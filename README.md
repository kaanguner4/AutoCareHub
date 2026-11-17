# AutoCareHub

AutoCareHub v2 is the website and backend of **AutoCare Türkiye**, a fictional chain of car service centres
(12 branches in 8 cities). Customers register, manage their vehicles and book service appointments; branch
staff confirm and close appointments for their branch; a head-office admin sees all branches.
Node.js 20 + Express 5, PostgreSQL 16, Docker Compose. The original MySQL course project is tagged
`v1-course-project` and described at the end of this file.

## Quick start (local)

```bash
cp .env.example .env                        # replace every value; JWT_SECRET: openssl rand -hex 32
docker network create autocare_shared       # once per host
python3.12 -m venv seed/.venv && seed/.venv/bin/pip install -r seed/requirements.txt
seed/.venv/bin/python seed/generate.py      # synthetic data -> seed/out/ (~10 s)
seed/load.sh --yes                          # starts db, (re)creates the database "autocare" (~20 s)
docker compose up -d --build                # db + app
open http://localhost:3000                  # the app listens on 127.0.0.1:3000 only
```

## Demo accounts

Only these six seeded logins can sign in. The password is `SEED_DEMO_PASSWORD` from `.env`.
Registering a new customer through the site also works.

| Login | Role | Sees |
| --- | --- | --- |
| `kayrabay.sensoy@example.org` | customer (individual, Kadıköy) | own vehicles and appointments |
| `zaliha.arslan@example.com` | customer (individual, Çankaya) | own vehicles and appointments |
| `muhasebe3@soylucatering.example.com` | customer (fleet, Bornova) | own vehicles and appointments |
| `feyruz.yildirim@autocare-turkiye.example` | branch admin (Kadıköy manager) | Kadıköy only |
| `idik.arslan@autocare-turkiye.example` | branch admin (Çankaya manager) | Çankaya only |
| `hq.admin@autocare-turkiye.example` | head-office admin | all branches |

## Web app (v2)

The pages (`index`, `register`, `dashboard`, `appointment`, `admin`) and the API are served by one Express app
(`backend/`), same origin. API, all JSON under `/api`:

| Endpoint | Who | What |
| --- | --- | --- |
| `GET /health` | anyone | `{"status":"ok"}` after a database ping (503 otherwise), no details |
| `POST /api/register` | anyone | new customer + login (bcrypt, cost 12) |
| `POST /api/login`, `POST /api/logout`, `GET /api/me` | anyone / signed in | session cookie in, out, current user |
| `GET /api/services`, `GET /api/branches` | anyone | active services with today's list price; open branches |
| `GET/POST /api/vehicles`, `GET/DELETE /api/vehicles/:id` | customer | own vehicles only (others: 404) |
| `GET /api/appointments?view=active\|history\|all`, `GET /api/appointments/:id` | signed in | customer: own; branch admin: own branch; HQ: all |
| `POST /api/appointments` | customer | pending web booking for an own vehicle at a branch, with services |
| `PUT /api/appointments/:id/status` | signed in | customer: cancel own upcoming; staff: confirm / complete / no-show / cancel in scope |
| `GET /api/admin/stats`, `GET /api/admin/users` | admin | KPI cards; web logins, scoped like appointments |

Security: signed JWT (HS256, 8 h) in an `httpOnly`, `SameSite=Lax` cookie (`Secure` when `APP_ORIGIN` is
https), re-checked against the database on every request; every POST/PUT/PATCH/DELETE must carry
`Origin: APP_ORIGIN` (else 403); helmet with a CSP of `'self'` only (no CDN, no inline script or style);
login rate limit (10 failed attempts per IP per 15 min); CORS only for `APP_ORIGIN`; parameterized SQL;
fixed error bodies (errors are logged, never sent); out-of-scope ids answer 404. The database login is the
`autocare_app` role (DML only). Bootstrap 5.3.0 (MIT), Font Awesome Free 6.4.0 (MIT / OFL-1.1 / CC BY 4.0)
and Poppins via `@fontsource/poppins` (OFL-1.1) are pinned npm packages served from `/vendor`; their
licences ship in the packages.

Configuration (`.env`, see `.env.example`): `AUTOCARE_APP_PASSWORD`, `JWT_SECRET` (random, at least 32
characters), `APP_ORIGIN` (e.g. `http://localhost:3000` or `https://autocare.gunerkaan.com`) and `TRUST_PROXY`
(`1` when a proxy or tunnel forwards to the app).

Tests (node:test + supertest, against the running database; they clean up after themselves):

```bash
docker compose --profile test run --rm test
cd backend && npm audit --omit=dev
```

## VM install (outline)

Target: Ubuntu 24.04 VM. Details and the Cloudflare tunnel follow in ACH-3.

1. Grow the disk to 30 GB; install Docker Engine and the compose plugin; `git clone` this repo.
2. Write `.env` on the VM (never copy it through git): fresh random values,
   `APP_ORIGIN=https://autocare.gunerkaan.com`, `TRUST_PROXY=1` once the tunnel forwards to `127.0.0.1:3000`.
3. `docker network create autocare_shared`
4. Generate and load the data: `python3 -m venv seed/.venv`, install `seed/requirements.txt`,
   `seed/.venv/bin/python seed/generate.py`, `seed/load.sh --yes` (target: under 5 minutes).
5. `docker compose up -d --build`; check `curl -fsS http://127.0.0.1:3000/health`.
6. The SQLBuddy Appliance joins `autocare_shared` and connects to `autocare-db:5432` as `sqlbuddy_ro`.

## Database (v2)

**PostgreSQL 16** with synthetic, deterministic data (seed `20261117`, period 2023-01-01 to 2026-11-15).
No real people, companies, plates or tax numbers.

| Path | What |
| --- | --- |
| `db/schema.sql` | 22 tables with keys, FKs, CHECKs, indexes on FK and date columns, `COMMENT ON` every table and column |
| `db/roles.sql` | `autocare_app` (DML on the app tables) and `sqlbuddy_ro` (SELECT only); passwords from the environment |
| `db/pattern_checks.sql` | one query per built-in pattern (seasonality, price rises, Çankaya, Bornova, overdue fleets, stock, campaign, growth) |
| `seed/generate.py` | data generator (Python 3.12, Faker `tr_TR`), writes gzip COPY files to `seed/out/` (git-ignored) |
| `seed/load.sh` | (re)creates the `autocare` database in the `db` container and loads everything |
| `docker-compose.yml` | `db` (postgres:16 pinned by digest, named volume, no published port; `autocare-db` on the shared network `autocare_shared`), `app`, and the `test` profile |

### Generate and load

```bash
cp .env.example .env            # then replace every value, e.g. with: openssl rand -hex 24
docker network create autocare_shared       # once per host (load.sh also creates it if missing)
python3.12 -m venv seed/.venv
seed/.venv/bin/pip install -r seed/requirements.txt
seed/.venv/bin/python seed/generate.py      # ~10 s, ~27 MB of gzip COPY files in seed/out/
docker compose up -d db
seed/load.sh --yes                          # drops and recreates ONLY the database "autocare"
```

`load.sh` reads `.env` (without executing it), creates the database with ICU collation `tr-TR`, applies the
schema, loads all COPY files in one transaction, resets the identity sequences, applies the roles and runs
`VACUUM (ANALYZE)`. Without `--yes` it does nothing. Only the six demo logins (see above) get the bcrypt hash
of `SEED_DEMO_PASSWORD`; every other seeded web login has `password_hash` NULL and cannot sign in.
`appointment_services` holds the services chosen in web bookings; it is empty for the seeded appointments.

The database has no published port. To query it from the host:

```bash
docker compose exec db psql -U postgres -d autocare
# as the read-only role, over a password login:
docker compose exec -e PGPASSWORD=<sqlbuddy_ro password> db psql -h localhost -U sqlbuddy_ro -d autocare < db/pattern_checks.sql
```

Volumes: 12 branches, 182 employees, 25,000 customers (15% fleet), 32,000 vehicles, 60 services, 800 parts,
25 suppliers, ~200k appointments, ~160k work orders, ~590k work order lines, ~159k invoices, ~40k reviews,
plus purchasing and a stock ledger (`stock_levels` = sum of `stock_movements`). About 360 MB in PostgreSQL.
The SQLBuddy Appliance reads it as `sqlbuddy_ro` at `autocare-db:5432` on the network `autocare_shared`.

## Original course project (v1)

A full-stack automotive service management system built with Node.js, Express, and MySQL. Features include a user dashboard for garage management and smart appointment booking, plus a comprehensive admin panel for workflow tracking and revenue analytics.
Auto Care Hub is a robust full-stack web application designed to digitize the workflow of a premium automotive performance center. Built with a Node.js and Express backend coupled with a MySQL relational database, this project bridges the gap between vehicle owners and service administrators through a responsive and interactive interface.

Key Features:

For Drivers (User Module):

Digital Garage: Users can register and manage multiple vehicles with specific details (Brand, Model, Plate) saved to the database.

Smart Booking: An interactive appointment form allows users to select specific cars from their garage and choose multiple services (e.g., Periodic Maintenance, Dyno Test). The system performs real-time price calculation based on selected services.

Live Tracking: A visual timeline enables users to track their service status (Pending → Approved → Completed) instantly.

For Management (Admin Panel):

Operational Control: A secure dashboard for administrators to view, approve, or cancel incoming appointment requests.

Analytics: Real-time calculation of estimated revenue, completed jobs, and pending approvals.

Workflow Integration: Actions taken in the admin panel (e.g., marking a job as "Completed") instantly update the user's timeline and archive the job.

Technical Stack:

Frontend: HTML5, CSS3 (Bootstrap 5 & Custom Dark Mode), Vanilla JavaScript (ES6+).

Backend: Node.js, Express.js (RESTful API architecture).

Database: MySQL (Structured relational data for Users, Vehicles, and Appointments).

This project demonstrates proficiency in CRUD operations, database schema design, and full-stack state management.
