# Atlas Competition Manager

Fencing competition management system built for the
[OpenPiste](https://openpiste.org) ecosystem.
Runs on a Raspberry Pi on competition day.

Manages pool rounds, direct elimination brackets, strip scheduling via OPP2/MQTT,
and publishes results. Part of the broader OpenPiste hardware + software platform.

---

## Features

- **People** — fencers, referees, clubs; CSV import/export
- **Competitions** — tournaments, age categories, eligibility filtering, auto-seeding
- **Pool rounds** — FIE serpentine seeding, official bout order, live rankings, advancement
- **Direct elimination** — FIE bracket seeding, byes, score entry, final results
- **Strips / OPP2** — piste pipeline scheduling, MQTT integration with scoring apparatus
- **Dashboard** — live view of all active competitions

---

## Tech stack

| Layer | Choice |
|---|---|
| Runtime | Node.js + Express |
| Database | SQLite via `better-sqlite3` (synchronous, zero server process) |
| Frontend | HTMX + Alpine.js v3 — no build step |
| Real-time push | Server-Sent Events (SSE) |
| Process manager | PM2 |

---

## Installation (Raspberry Pi / Debian / Ubuntu)

**Prerequisites:** clone the repo first, then run the install script as root.

```bash
git clone https://github.com/pietwauters/AtlasCompetitionManager.git
cd AtlasCompetitionManager
sudo bash install.sh
```

`install.sh` will:
- Install Node.js 20, npm, git, sqlite3, build tools (needed for `better-sqlite3`)
- Run `npm ci` to install dependencies
- Create the `data/` directory and initialise the database
- Install PM2 and configure auto-start at boot via systemd

After install, Atlas is available at `http://<pi-ip>:3000`.

---

## Updates

```bash
bash update.sh
```

Pulls latest code, updates dependencies, runs any new migrations, and restarts PM2.
No `sudo` required.

---

## Development

```bash
node server.js          # start on port 3000
# or
pm2 start server.js --name atlas
```

Database file: `data/atlas.db` (gitignored). Created automatically on first start.

---

## Test data

Populate a fresh database with realistic Belgian test data
(8 clubs, 200 fencers across all weapons/ages/genders, 15 referees):

```bash
node scripts/seed_test_population.js
```

To wipe and reload:

```bash
node scripts/seed_test_population.js --force
```

---

## Reset database

To permanently erase all data and start from an empty schema:

```bash
node scripts/reset_database.js
```

You will be asked to type a confirmation phrase. This cannot be undone.

---

## Scripts

| Script | Purpose |
|---|---|
| `install.sh` | Full fresh install (run as root) |
| `update.sh` | Pull + migrate + restart |
| `StartAtBoot.sh` | Enable PM2 auto-start |
| `DontStartAtBoot.sh` | Disable PM2 auto-start |
| `scripts/seed_test_population.js` | Load test data (200 fencers, 15 referees) |
| `scripts/reset_database.js` | !! Erase all data and recreate empty schema |

---

## Key files

| Path | Purpose |
|---|---|
| `server.js` | Entry point, route mounting, migration runner |
| `db/migrations/` | Numbered schema migrations (applied on every start) |
| `rules/` | JSON rule documents (pool sizes, DE parameters) |
| `lib/` | Pool formation, bout order, DE bracket, OPP2 client |
| `services/` | All database access (raw SQL, no ORM) |
| `routes/` | Express route handlers |
| `public/` | HTML pages (HTMX + Alpine.js, no build step) |
| `docs/` | Protocol specs and design documents |

---

## OPP2 / MQTT

Atlas speaks OpenPiste Protocol 2 over TCP MQTT (port 1883).
Default broker: `mqtt://openpiste.local:1883` — configurable at `/opp2.html`.

See `docs/level2.md` for the full protocol specification and
`docs/importing-official-data.md` for the import architecture design.

---

## Database conventions

- `snake_case` column names; `camelCase` JS variables
- All DB access is synchronous raw SQL in `services/` — no ORM, no async/await
- Schema changes = new migration file in `db/migrations/`; never modify existing ones
- `fencers.ranking`: national/club list position, lower = better (1 = top)
- `fencers.weapons`: JSON array, e.g. `["foil","epee"]`
