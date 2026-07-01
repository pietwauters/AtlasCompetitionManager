# Atlas Competition Manager — CLAUDE.md

This file is the authoritative reference for AI-assisted development on this project.
Read it before touching any code. It overrides default behaviors.

---

## What this project is

**Atlas** is a fencing competition management system built for the
[OpenPiste](https://openpiste.org) ecosystem. Target hardware: Raspberry Pi on
competition day. A competition manager uses it to run pool rounds, direct elimination
tableaux, and publish results.

Part of the broader OpenPiste ecosystem: strip scoreboards and club software communicate
via **OPP2** (OpenPiste Protocol 2, MQTT + JSON). Atlas must eventually speak OPP2.

---

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js + Express | Same as companion `mqtt-web`; runs on Pi |
| Database | SQLite via `better-sqlite3` | Synchronous, zero server process, trivial Pi backup |
| Schema migrations | Numbered `.sql` files in `db/migrations/` | Applied by `db/migrator.js` on every server start |
| Frontend | HTMX + Alpine.js v3, no build step | No transpiler, no bundler; CDN scripts in HTML |
| Real-time push | Server-Sent Events (SSE) | Simpler than WebSockets for server→browser |
| Process mgmt | PM2 | Same as `mqtt-web` |

---

## Hard rules — never violate these

### No ORM
**Never** use Sequelize, Prisma, Knex, TypeORM, or any query builder.
A partial Sequelize migration was the direct cause of a full codebase rewrite.
All DB access is raw SQL inside `services/` functions.

### No async DB calls
`better-sqlite3` is synchronous. This is intentional. No `async`/`await` in service files.
Routes may be async only when calling genuinely async things (e.g. file I/O), not DB.

### Prepared statements must be module-level constants
**Never** call `db.prepare()` inside a function or method body.
`better-sqlite3` does not cache `prepare()` calls — every inline call recompiles the SQL.
Benchmarked at **~16x slower** than a module-level statement under load, with GC pressure
that compounds over hours of competition-day use. Always declare statements at the top of
the file, before the service object:

```js
const stmtFind = db.prepare('SELECT * FROM things WHERE id = ?');
const Thing = { findById(id) { return stmtFind.get(id); } };
```

Exception: SQL that is genuinely dynamic at runtime (e.g. a `WHERE` clause built from
optional filters) may call `prepare()` inline, but this should be rare — SQL parameters
(`?` / `@name`) handle the vast majority of variability without dynamic SQL.

### Multiple DB writes that belong together must use a transaction
Any sequence of writes that must succeed or fail as a unit — or that leaves the DB in an
inconsistent intermediate state — must be wrapped in `db.transaction()`:

```js
const doSwap = db.transaction((a, b) => {
  stmtUpdate.run(-9999999, a);   // temp to avoid unique constraint
  stmtUpdate.run(b, a);
  stmtUpdate.run(a, b);
});
doSwap(x, y);
```

The prior failure mode: three bare `db.prepare(...).run(...)` calls for a bout-order swap
left the DB with corrupt `bout_order` values if the process crashed mid-sequence.

### Filesystem reads in request paths must be cached
`fs.readFileSync` / `fs.existsSync` / `JSON.parse` are synchronous and block the event
loop. They are acceptable at module load time, but never inside a function called during
request handling without a module-level cache:

```js
const cache = new Map();
function loadThing(id) {
  if (cache.has(id)) return cache.get(id);
  const val = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  cache.set(id, val);
  return val;
}
```

This applies to rule files (`lib/rules.js`), format files (`services/formats.js`), and
any other JSON config read at runtime.

### SSE writes must be guarded with try/catch
When writing to SSE subscriber sets, always wrap `res.write()` in `try/catch`. A socket
that is destroyed before its `close` event fires will throw synchronously, which would
abort the loop and skip all remaining subscribers without the guard:

```js
for (const res of subs) {
  try { res.write(msg); } catch (_) {}
}
```

This applies to both `emit()` and any keepalive/heartbeat loops.

### Schema changes = new migration file
Adding or changing a column means creating `db/migrations/005_describe_change.sql`.
Never modify existing migration files. Never ALTER tables in application code.

### 3-minute rule
**Stop after ~3 minutes of tool use without producing a user-facing message.**
Report what was tried and where it got stuck. Ask for direction.
Do not keep chaining tool calls hoping something will work — it wastes tokens.

---

## Coding style

```js
'use strict';
const db = require('../db');

// Prepared statements MUST be module-level constants — never inside methods.
// better-sqlite3 does not cache prepare() calls; inlining them recompiles the
// SQL on every invocation and is ~16x slower under load.
const stmtFindById = db.prepare('SELECT * FROM things WHERE id = ?');
const stmtInsert   = db.prepare('INSERT INTO things (name) VALUES (@name)');

const Thing = {
  findById(id) {
    return stmtFindById.get(id);
  },
  create({ name }) {
    const { lastInsertRowid } = stmtInsert.run({ name });
    return this.findById(lastInsertRowid);
  },
};

module.exports = Thing;
```

- `'use strict'` at the top of every file
- CommonJS: `require()` / `module.exports` — no ES module `import`/`export`
- 2-space indentation, single quotes, semicolons
- `snake_case` for DB column names and SQL; `camelCase` for JS variables and function names
- Object literal / repository pattern for all services
- One domain per file in `services/`; one route group per file in `routes/`
- No comments unless the WHY is non-obvious

---

## Domain model

```
Person          — master record (anyone: fencer, referee, coach)
  └─ Fencer     — club member with weapon/licence/ranking
  └─ Referee    — with level/licence

Tournament      — named series of competitions
  └─ Competition — one event (weapon + gender + age category)
       └─ Competitor — a Fencer entered in this Competition
            └─ Phase  — Pool round or DE tableau within this Competition
                 └─ Pool / Bout
```

**Competitor** is the per-competition entity derived from Fencer. It holds
`initial_seed` and `final_rank`. Never conflate Fencer with Competitor.

---

## Phase and rules system

- Each Phase is either **Pool** OR **Direct Elimination** — never mixed
- Phase behavior is fully described by a **JSON rule document** in `rules/`
- Pool rule: pool sizes, advancement %, separation mechanism
- DE rule: touch target, time limit, tableau parameters
- The output ranking of one phase is the input seed order for the next phase
- Multiple pool phases can be combined (aggregate V/M, indicator, touches for seeding)
- The competition manager can always manually override the proposed advancement list

### Pool formation
- FIE serpentine seeding across pools
- Separation: club (default) or nationality — asked when creating the phase
- All valid uniform options shown (e.g. 42 fencers → both 6×7 and 7×6)
- Mixed options (different pool sizes) also shown when they exist

### DE tableau (FIE seeding)
- Tableau size = smallest power of 2 ≥ N competitors
- `buildSeedPositions(T)`: seed 1 at position 1, seed 2 at position T
  Seeds 2 & 3 meet only in the semi-final; 1 & 2 only in the final
- Top (T − N) seeds get byes; byes are auto-finished on phase creation
- `advanceDEWinner` wires the winner into the correct slot of the next round

**WARNING — `buildSeedPositions` is subtle and was implemented wrong once.**
The correct algorithm alternates expansion direction per slot. For T=8 the result
must be `[1, 8, 5, 4, 3, 6, 7, 2]` (seed 1 top, seed 2 bottom, SF is 1v4 and 2v3).

```js
function buildSeedPositions(T) {
  let slots = [1, 2], cur = 2;
  while (cur < T) {
    cur *= 2;
    const next = [];
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      if (i % 2 === 0) next.push(s, cur + 1 - s);  // odd position: seed first
      else             next.push(cur + 1 - s, s);   // even position: seed last
    }
    slots = next;
  }
  return slots;
}
```

**WARNING — bye distribution.**
Byes go to the **top seeds**, not random positions. In a T=64 tableau with 45
fencers, seeds 46–64 are byes. A bye at position P means the real seed at that
position gets a free pass; there is never a bout between two real competitors
where one of them has a seed number higher than N. The bye slots fall out
naturally from `buildSeedPositions`: any position whose seed > N is a bye.

---

## Known gotchas

### Alpine.js v3 — `x-for` requires a single root element
An `x-for` directive must have exactly one root element in its template. Wrapping
two sibling elements inside a `<template x-if="true">` inside `x-for` silently
fails — Alpine renders only the first element or nothing. Fix: wrap siblings in a
single `<div>` (or use CSS to achieve the layout without extra DOM siblings).

---

## What is built (as of 2026-06-01)

### Infrastructure
- `db/index.js`, `db/migrator.js`, migrations 001–004
- `server.js` — Express, mounts all routes, runs migrations on start
- `install.sh`, `StartAtBoot.sh`, `DontStartAtBoot.sh`

### People
- People, Fencers, Referees, Clubs, NOCs
- CSV import/export (RFC-4180, match by licence or name+DOB)
- UI: `public/people.html`

### Competitions
- Tournaments, Competitions, Age Categories, Competitors
- Eligibility filter (gender + weapon + age)
- Auto-seed from national ranking
- UI: `public/tournaments.html`, `public/competition-detail.html`

### Pool phase (complete)
- FIE serpentine seeding + separation (club/nationality)
- FIE official bout order (pools of 4–12) — **verified against real FIE GP XML**
- Live rankings (V/M, indicator, touches scored/received)
- Simulate function for random result entry (testing)
- Phase close: saves rankings, applies advancement, marks eliminated
- Phase chaining: previous pool rankings seed the next phase
- Combined seeding: aggregate stats across multiple pool phases
- UI: `public/phase.html`, `public/pool.html`

### DE phase (complete)
- FIE serpentine tableau seeding
- All rounds pre-built on phase creation; byes auto-finished and wired
- Score entry, undo, winner auto-advancement
- Simulate function
- Final results table (1st/2nd unique; 3rd shared if no bronze; others by seed)
- UI: `public/de.html`
- Bout order within each round: sequential by bracket position (top to bottom) — **verified against real FIE GP XML**

### Competition formats (complete)
- Format files in `formats/*.json` define multi-phase flows with cohorts and exemptions
- `services/formats.js` — `loadFormat`, `resolveParticipants`, `applyPoolClose`, `closeFormatDE`, `validateCounts`
- Migration 021: `format_id` on competitions, `format_cohort` on competitors, `format_stage` on phases
- Implemented: `grand-prix-fie.json` (3-stage GP), `two-pool-rounds.json`
- GP format verified against real FIE Grand Prix XML (Shanghai 2026, 233 fencers): 16 initial exempts, 70% pool advancement, 32 survivors from preliminary tableau, T=64 final
- UI: format picker in competition detail, stage plan with "+ Next stage" guided creation

### Results
- Full competition results page combining DE + pool-eliminated fencers
- Unique ranks except 3rd (shared); pool-eliminated appended in pool-rank order
- UI: `public/results.html`, endpoint `GET /api/competitions/:id/results`

### Strips
- CRUD for pistes/strips; inline rename (click-to-edit)
- Strip assignment to pools: `PATCH /api/pools/:id` with `{strip_id, referee_id}`
- Assigning a strip sets `strips.status = 'assigned'`; clearing it resets to `'idle'`
- UI: `public/strips.html`

### OPP2 design principle — ecosystem independence

Every component in the OPP2 ecosystem (scoring apparatus, remote control, scoresheet tablet, display, CMS) can be from different and independent implementers who have no knowledge of each other's implementation details. Everything must work if communication follows the spec.

**Consequence for Atlas OPP2 work:** never put Atlas-internal identifiers (DB row IDs, `pool_id`, `phase_id`, `pipeline_slot_id`) into MQTT payloads. Any compliant CMS must be able to produce the message; any compliant display must be able to consume it without knowing anything about Atlas.

### OPP2 / MQTT integration (foundational layer complete as of 2026-05-31)

**Protocol:** OpenPiste Protocol 2 (OPP2) — native JSON over MQTT.
Spec lives in `docs/level2.md`. Read it before touching any OPP2 code.

**Transport:** TCP MQTT on port 1883 (not WebSockets — those are for browsers).
Default broker: `mqtt://openpiste.local:1883`. Configurable in `public/opp2.html`.

**Topic structure:**
```
openpiste/{piste_id}/{publisher}/{message_type}
```
`piste_id` = `strips.strip_number` (integer, as string in topic).
Atlas publishes as `software`; apparatus publishes as `apparatus`.

**What Atlas does over MQTT:**
- Publishes `software/connection online:true` (retained) for each strip on connect; LWT clears it
- Subscribes to `apparatus/connection`, `apparatus/control`, `apparatus/score` on all pistes
- On `apparatus/control NEXT`: finds next pending bout from the piste's pipeline, publishes `software/fencers` + `software/match`
- On `apparatus/control PREV`: re-sends the previous bout in the pipeline (referee navigation)
- On `apparatus/control END`: checks correct-ending rules (spec §23.4), records score via `Bout.updateScore()`, sends ACK; sends NAK if no clear winner
- Tracks live score per piste in memory from `apparatus/score` messages

**Correct-ending rules (§23.4) — when Atlas sends ACK vs NAK:**
- ACK if: scores differ, OR scores equal with priority assigned (L/R), OR abandonment/exclusion
- NAK if: scores equal, no priority → referee must resolve before Atlas accepts the result

**Pipeline — piste scheduling:**
Each strip has an ordered list of pipeline slots. A slot is either a pool or a DE bout range.
- Pool slot: `pool_id` — all bouts in that pool, in FIE bout order
- DE range slot: `phase_id` + `de_round` + `bout_start`/`bout_end` (1-based, tableau order)
- Each slot has optional `scheduled_start` (HH:MM) and `minutes_per_bout` for predicted-end computation
- `predicted_end` = `scheduled_start` + `bout_count × minutes_per_bout` (computed, not stored)
- `bout_duration_standards` table holds future weapon/phase-type defaults (empty for now)
- Referee schedule is a derived view: all slots where `referee_id = X`
- On NEXT: Atlas walks the pipeline — exhausted slot auto-advances to the next one
- Multiple competitions can run simultaneously; each piste's pipeline determines what it fences

**Key files added:**
| Path | Purpose |
|---|---|
| `docs/level2.md` | OPP2 protocol specification (read before implementing) |
| `db/migrations/005_opp2_settings.sql` | `settings`, `pipeline_slots`, `bout_duration_standards` |
| `services/settings.js` | `get(key)` / `set(key, value)` against settings table |
| `services/pipeline.js` | Pipeline CRUD, `nextBout`, `prevBout`, predicted-end computation |
| `lib/opp2Client.js` | MQTT singleton: connect/disconnect, per-piste state, NEXT/PREV/END handlers |
| `routes/opp2.js` | REST: broker settings, connect/disconnect, pipeline CRUD |
| `public/opp2.html` | Admin: broker config, live piste status, pipeline builder, referee schedule |

**OPP2 admin page:** `http://localhost:3000/opp2.html`
- Connect/disconnect to broker
- Build per-strip pipeline (add pool or DE range slots, set times, assign referees)
- Overlap warning when `scheduled_start` < previous slot's `predicted_end`
- Referee schedule view (filtered across all strips)

**What is NOT yet done in OPP2:**
- Cloud bridging (Mosquitto bridge to remote broker)
- `bout_duration_standards` table is empty — fill it to get automatic `predicted_end`
- DE referee assignment (currently a placeholder in the query)
- Pipeline UI drag-to-reorder (▲▼ buttons work; drag is future)

---

## What is NOT yet built — priority order

### 1. Full functional DE tableau
- `allPlacesFenced`: all places fenced off from 1st to last (T8+, common in youth events)
- Repechage: losers re-enter the tableau from a defined round
- `de.html` full redesign to accommodate both of the above
- Bronze bout for placement bouts in pipeline (strip picker doesn't yet cover placement/repechage)

### 2. Run a full tournament locally (no cloud needed)
- Direct competition import — federation/FIE start lists without touching the local people DB
  - Engarde XML format now fully understood (see `docs/GP/` for reference files); move this off "out of scope"
- Registration desk — review `checkin.html` for competition-day check-in completeness
- Card reasons — full FIE t.170 text, English + French; store OPP2 `ts` + clock at card time
- Manual appendices B and C
- Fencer handedness (`hand`: R/L) — not yet in `fencers` table; Engarde stores `Lateralite` (D/G); relevant for scoresheet display and OPP2 `software/fencers` payload

### 3. Scoresheets
- Pool scoresheet grid (fencer vs fencer diagonal matrix) requires each fencer's **slot position in the pool** (Engarde: `NoDansLaPoule` 1–N). Currently derivable from seeding order but not stored. If a fencer is manually moved the grid breaks. Add `pool_slot` to the pool-fencer join table via migration.
- Cards are annotation/audit data only — Engarde does not include them in the results XML export. Keep card records separate from the authoritative bout result.
- Per-bout scheduled time: Engarde assigns `Heure` per individual DE bout (across strips). Atlas schedules at slot (round) level. Deriving per-bout times from slot data is sufficient for now.

### 4. Architecture / code hygiene
- `bout_duration_standards` table empty — fill for automatic `predicted_end`
- DE referee assignment in pipeline (placeholder query in `opp2Composer`)
- Pipeline UI drag-to-reorder (▲▼ works; drag is future)
- Resilience: discuss network loss / crash recovery across the ecosystem
- Minor: `CyranoServer.js` missing `'use strict'`

### 5. Security
- Authentication: fully wired — session-based PIN login, roles: `admin` / `director` / `assistant` / `referee`
- GET requests are public; mutations are gated per route (`writeOnly(role)` in `server.js`)
- OPP2/MQTT config and user management require `admin`; phase/bout scoring requires `director`
- Install creates an `admin` account with a one-time PIN (forced change on first login)
- `scripts/reset_admin_pin.js` resets a lost admin PIN

### 6. CSS centralisation
- ~1 600 lines of inline `<style>` spread across 20 pages; extract to `css/style.css`
- Do this when the UI component vocabulary is stable (after DE redesign)

### 7. OPP2 cloud bridge
- Mosquitto bridge config to remote broker
- `tournament_id` / `competition_id` from Atlas in payloads
- Lower priority: local operation is fully functional without it

### Out of scope for MVP
| Feature | Notes |
|---|---|
| Cyrano scoring machine | Lower priority than cloud bridge |
| Team competitions | Out of scope |
| FIE Engarde XML export | Out of scope for now; format fully understood from `docs/GP/` reference files |

---

## Key files

| Path | Purpose |
|---|---|
| `server.js` | Entry point, route mounting, migration runner, OPP2 auto-connect |
| `db/migrator.js` | Runs pending `.sql` files on start |
| `db/migrations/` | Numbered schema migrations (001–005) |
| `rules/` | JSON rule documents (pool-standard, de-standard, …) |
| `lib/poolFormation.js` | FIE pool seeding + calcPoolOptions |
| `lib/boutOrder.js` | FIE official bout order tables |
| `lib/deFormation.js` | FIE DE tableau seeding (buildSeedPositions, buildDE) |
| `lib/opp2Client.js` | OPP2 MQTT client singleton |
| `services/phases.js` | Phase create/activate/close + DE creation + simulate |
| `services/bouts.js` | Score entry, undo, advanceDEWinner |
| `services/results.js` | Final competition results combining DE + pool |
| `services/pipeline.js` | Piste pipeline: CRUD, bout navigation, predicted-end |
| `services/settings.js` | Key/value settings (broker URL, enabled flag) |

---

## Development

```bash
node server.js          # start on port 3000
# or
pm2 start server.js --name atlas
```

DB file: `data/atlas.db` (gitignored). Created by `install.sh` or on first start.

Test data: 37 U17 male foil fencers across 6 Belgian clubs (seeded by national ranking).
