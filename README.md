# Atlas Competition Manager

A full competition management system (CMS) for fencing, built first and
foremost as the **reference client** for the
[OpenPiste](https://openpiste.org) ecosystem — proving that OPP2
(OpenPiste Protocol 2), the open MQTT-based protocol connecting scoring
apparatus, scoreboards, and software, actually works end to end on real
competition-day workflows.

In the process it has grown into a genuinely usable tournament CMS in its
own right — the kind of thing a club or national federation could run an
event on today, with a feature set and a cost (free, self-hosted, open
source) that few existing systems combine. That includes **electronic
scoresheets**, a vital piece for running a genuinely paperless competition
rather than one that just adds software on top of a paper backup.

---

## What makes Atlas different

- **True client/server, not a single-workstation app.** One Atlas server —
  on a Raspberry Pi, a laptop, a NUC in the venue, or a machine in the
  cloud — is the single source of truth. Every device on the network talks
  to it live: no file handoffs, no "who has the current version of the
  Excel sheet."
- **Any device does any job.** The UI is responsive from phone width up.
  Presence/check-in, pool sheets, DE score entry, referee assignment,
  electronic scoresheets — none of it is tied to a PC. Run check-in from a
  tablet at the door while a referee enters scores from a phone on the
  strip and the tournament desk watches the dashboard on a laptop, all
  against the same live data. Each strip also gets a printable QR code
  (`/piste-qr.html`) that opens straight into that piste's live pipeline —
  no typing URLs on a phone between bouts.
- **Electronic scoresheets**, including card annotations with FIE t.170
  reason codes and attribution to the specific official who made the call —
  not just a paper backup.
- **Multiple competitions, one shared pool of resources.** Atlas runs
  several competitions simultaneously and schedules them against the same
  pistes and the same referees, with overlap warnings when a strip or
  official is double-booked. This is normal at any real tournament and
  most simple tools simply don't model it.
- **Runs anywhere Node.js runs.** No dependency on a specific OS or a
  hosted service — just Node.js, SQLite (bundled, zero server process to
  administer), and, for the OPP2/MQTT layer, any standard MQTT broker
  (e.g. Mosquitto). Raspberry Pi is the reference deployment target for
  competition day, but nothing about Atlas requires it.
- **Open protocol, not a walled garden.** Because Atlas speaks OPP2, any
  compliant scoring apparatus, scoreboard, or third-party tool can join
  the same competition without Atlas-specific integration work.

---

## Features

- **People** — fencers, referees, clubs; CSV import/export
- **Competitions** — tournaments, age categories, eligibility filtering, auto-seeding
- **Check-in** — competition-day presence registration
- **Pool rounds** — FIE serpentine seeding, official bout order, live rankings, advancement
- **Direct elimination** — FIE tableau seeding, byes, repechage, score entry, final results
- **Electronic scoresheets** — card reasons (FIE t.170), official attribution
- **Strips / OPP2** — piste pipeline scheduling, referee scheduling, MQTT integration with scoring apparatus
- **Multi-competition scheduling** — shared pistes and referees across simultaneous events, with overlap warnings
- **Responsive, multi-device UI** — desktop, tablet, and phone, including per-piste QR access
- **Dashboard** — live view of all active competitions

---

## Tech stack

| Layer | Choice |
|---|---|
| Runtime | Node.js + Express |
| Database | SQLite via `better-sqlite3` (synchronous, zero server process) |
| Frontend | HTMX + Alpine.js v3 — no build step, works on any modern browser (desktop/tablet/phone) |
| Real-time push | Server-Sent Events (SSE) |
| Device/apparatus integration | OPP2 over MQTT (any standard broker, e.g. Mosquitto) |
| Process manager | PM2 |
| Platform | Anything Node.js runs on — Raspberry Pi is the reference target, not a requirement |

---

## Installation (Raspberry Pi / Debian / Ubuntu)

The steps below are the automated, competition-day-ready path via
`install.sh` (Debian-family Linux, incl. Raspberry Pi OS). Atlas itself has
no OS dependency — anywhere Node.js and `better-sqlite3` run, `node
server.js` is enough (see [Development](#development)).

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

After install, Atlas is available at `http://<pi-ip>:3001`.

During installation an **admin account** is created automatically.
The one-time PIN is printed at the end of the install output — save it before
the terminal closes. You will be forced to change it on first login.

Login page: `http://<pi-ip>:3001/login.html`

To reset a lost admin PIN:

```bash
node scripts/reset_admin_pin.js
```

> **Port note:** Atlas defaults to port `3001` to avoid conflicting with
> `mqtt-web` and other OpenPiste services that typically run on port `3000`.
> Change `PORT=` in `.env` if needed.

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
| `lib/` | Pool formation, bout order, DE tableau, OPP2 client |
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
