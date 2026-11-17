#!/usr/bin/env bash
# Load the synthetic AutoCare Türkiye data into the `db` compose service.
#
#   seed/load.sh --yes
#
# Drops and recreates ONLY the database `autocare` (other databases and the data volume stay),
# applies db/schema.sql and db/roles.sql, loads seed/out/*.copy.gz in one transaction and runs
# VACUUM (ANALYZE). Passwords come from .env and are never printed. Run seed/generate.py first.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/seed/out"
DB=autocare

if [[ "${1:-}" != "--yes" ]]; then
  echo "This drops and recreates the database '$DB' in the compose service 'db'." >&2
  echo "Run again with --yes to continue." >&2
  exit 1
fi

# --- read .env without executing it (KEY=VALUE lines only)
[[ -f "$ROOT/.env" ]] || { echo "missing $ROOT/.env (copy .env.example)" >&2; exit 1; }
while IFS= read -r line || [[ -n "$line" ]]; do
  [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
  if [[ "$line" =~ ^([A-Z_][A-Z0-9_]*)=(.*)$ ]]; then
    value="${BASH_REMATCH[2]}"
    value="${value%\"}"; value="${value#\"}"; value="${value%\'}"; value="${value#\'}"
    export "${BASH_REMATCH[1]}=$value"
  fi
done < "$ROOT/.env"
for var in POSTGRES_PASSWORD AUTOCARE_APP_PASSWORD SQLBUDDY_RO_PASSWORD; do
  [[ -n "${!var:-}" ]] || { echo "$var is empty in .env" >&2; exit 1; }
done
[[ -f "$OUT/manifest.tsv" ]] || { echo "missing $OUT/manifest.tsv; run seed/generate.py first" >&2; exit 1; }

cd "$ROOT"
compose() { docker compose --project-directory "$ROOT" "$@"; }
psql_db() { compose exec -T db psql -X -q -v ON_ERROR_STOP=1 -U postgres "$@"; }

started=$(date +%s)
echo "==> starting db"
compose up -d --wait db >/dev/null

echo "==> recreating database $DB"
psql_db -d postgres <<SQL
DROP DATABASE IF EXISTS $DB WITH (FORCE);
CREATE DATABASE $DB TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER icu ICU_LOCALE 'tr-TR' LOCALE 'C.UTF-8';
SQL

echo "==> schema"
psql_db -d "$DB" < "$ROOT/db/schema.sql"

echo "==> data (one transaction)"
{
  echo "SET client_min_messages = warning;"
  while IFS=$'\t' read -r table columns file rows; do
    echo "\\echo   $table ($rows rows)"
    echo "COPY public.$table ($columns) FROM STDIN;"
    gunzip -c "$OUT/$file"
    echo '\.'
  done < "$OUT/manifest.tsv"
  # identity columns continue after the loaded ids
  cat <<'SQL'
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT table_name, column_name FROM information_schema.columns
           WHERE table_schema = 'public' AND is_identity = 'YES' LOOP
    EXECUTE format('SELECT setval(pg_get_serial_sequence(%L, %L), coalesce(max(%I), 0) + 1, false) FROM public.%I',
                   'public.' || r.table_name, r.column_name, r.column_name, r.table_name);
  END LOOP;
END $$;
SQL
} | psql_db -d "$DB" --single-transaction

echo "==> roles"
compose exec -T -e AUTOCARE_APP_PASSWORD -e SQLBUDDY_RO_PASSWORD db \
  psql -X -q -v ON_ERROR_STOP=1 -U postgres -d "$DB" < "$ROOT/db/roles.sql"

echo "==> vacuum analyze"
psql_db -d "$DB" -c "VACUUM (ANALYZE);"

elapsed=$(( $(date +%s) - started ))
size=$(psql_db -d "$DB" -At -c "SELECT pg_size_pretty(pg_database_size('$DB'))")
echo "==> done in ${elapsed}s, database size $size"
