# AutoCareHub
A full-stack automotive service management system built with Node.js, Express, and MySQL. Features include a user dashboard for garage management and smart appointment booking, plus a comprehensive admin panel for workflow tracking and revenue analytics.
--------------------------------------------------------------------------------------------------------
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

--------------------------------------------------------------------------------------------------------

## Database (v2)

AutoCareHub v2 is the backend of a fictional chain of car service centres, **AutoCare Türkiye**
(12 branches in 8 cities). It runs on **PostgreSQL 16** and ships with synthetic, deterministic data
(seed `20261117`, period 2023-01-01 to 2026-11-15). No real people, companies, plates or tax numbers.
The v1 MySQL course project is tagged `v1-course-project`.

| Path | What |
| --- | --- |
| `db/schema.sql` | 21 tables with keys, FKs, CHECKs, indexes on FK and date columns, `COMMENT ON` every table and column |
| `db/roles.sql` | `autocare_app` (DML on the app tables) and `sqlbuddy_ro` (SELECT only); passwords from the environment |
| `db/pattern_checks.sql` | one query per built-in pattern (seasonality, price rises, Çankaya, Bornova, overdue fleets, stock, campaign, growth) |
| `seed/generate.py` | data generator (Python 3.12, Faker `tr_TR`), writes gzip COPY files to `seed/out/` (git-ignored) |
| `seed/load.sh` | (re)creates the `autocare` database in the `db` container and loads everything |
| `docker-compose.yml` | service `db` (postgres:16 pinned by digest, named volume, no published port) |

### Generate and load

```bash
cp .env.example .env            # then replace every value, e.g. with: openssl rand -hex 24
python3.12 -m venv seed/.venv
seed/.venv/bin/pip install -r seed/requirements.txt
seed/.venv/bin/python seed/generate.py      # ~10 s, ~27 MB of gzip COPY files in seed/out/
docker compose up -d db
seed/load.sh --yes                          # drops and recreates ONLY the database "autocare"
```

`load.sh` reads `.env` (without executing it), creates the database with ICU collation `tr-TR`, applies the
schema, loads all COPY files in one transaction, resets the identity sequences, applies the roles and runs
`VACUUM (ANALYZE)`. Without `--yes` it does nothing. Every seeded web login (branch managers and service
advisors as `admin`, customers who booked online as `customer`) gets the bcrypt hash of `SEED_DEMO_PASSWORD`.

The database has no published port. To query it from the host:

```bash
docker compose exec db psql -U postgres -d autocare
# as the read-only role, over a password login:
docker compose exec -e PGPASSWORD=<sqlbuddy_ro password> db psql -h localhost -U sqlbuddy_ro -d autocare < db/pattern_checks.sql
```

Volumes: 12 branches, 182 employees, 25,000 customers (15% fleet), 32,000 vehicles, 60 services, 800 parts,
25 suppliers, ~200k appointments, ~160k work orders, ~590k work order lines, ~159k invoices, ~40k reviews,
plus purchasing and a stock ledger (`stock_levels` = sum of `stock_movements`). About 360 MB in PostgreSQL.
