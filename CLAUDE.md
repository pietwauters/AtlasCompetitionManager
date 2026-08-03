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

### `docs/level2.md` is a mirror — spec changes need an upstream PR
`docs/level2.md` is a local copy of the canonical OPP2 spec, which lives at
**https://github.com/OpenPiste/protocols** (`docs/level2.md` there). Atlas's copy
is kept in sync via `scripts/sync-spec.sh` (`./scripts/sync-spec.sh` to check for
drift, `--update` to pull the official version). Editing the file in *this* repo
only updates Atlas's own reference copy — it does **not** propagate anywhere
else, and no other OPP2 implementer (a video-review tool, a third-party
scoresheet, Cyrano) will ever see it.

**Any change to the wire protocol itself** (new/changed message fields,
retained/QoS semantics, topic structure — not just Atlas's own code) must also
land upstream:
1. Edit `docs/level2.md` here as usual, and get the Atlas-side implementation
   working against it.
2. Clone `https://github.com/OpenPiste/protocols`, apply the same diff to its
   `docs/level2.md`, push a branch, and open a PR (`gh pr create --repo
   OpenPiste/protocols ...`). Confirm with the user before merging — this is a
   shared, external repo, not Atlas's own.
3. Run `./scripts/sync-spec.sh` afterward to confirm Atlas's local copy matches
   the merged upstream version exactly.

A commit to `docs/level2.md` in the Atlas repo is **not** "the spec changing" —
only the merge to `OpenPiste/protocols` is. Confirmed once already, on
2026-07-02: local spec edits were pushed to Atlas's own repo and initially
assumed to be "the spec update" until the mismatch was caught.

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
- Separation: configured per rule file's `poolFormation.separation` array
  (`docs/format-authoring-guide.md` §3).
  **FIE-format rule files must use `["nationality"]` only** — the same array also drives
  which pools get FIE's special nationality-conflict bout-order tables (o.70) in
  `lib/boutOrder.js`, and those are officially nationality-only; including `"club"` risks a
  silent, undetectable deviation from official bout order whenever a same-club, different-
  nationality pair triggers the conflict-handling tables that o.70 never intended for them
  (see `docs/format-system-comparison.md` §7 for the real anomaly that surfaced this).
  `"club"` stays available for non-FIE domestic/club-level rule files. Both shipped FIE
  rule files (`pool-standard.json`, `level-pools.json`) use `["nationality"]` as of
  2026-07-05.
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

*Full dated build history, bug forensics, and verification detail for every item below
moved to `docs/implementation-log.md` on 2026-08-03 — read it for the "why" and "how it
was found/fixed." This section is a current-status index only.*

### Infrastructure
`db/index.js`, `db/migrator.js`, `server.js` (Express, mounts routes, runs migrations),
`install.sh`/`StartAtBoot.sh`/`DontStartAtBoot.sh`.

### People
People, Fencers, Referees, Clubs, NOCs. CSV import/export. UI: `public/people.html`.

### Competitions
Tournaments, Competitions, Age Categories, Competitors; eligibility filter; auto-seed
from ranking; format picker. **Presence gate on phase creation (2026-07-28):** both the
no-format and format-driven creation paths require `checked_in=1` before a competitor
enters a round. **`referee_separation` flag (2026-07-27):** competition-level
nationality/club referee-neutrality setting — storage/UI only, not yet consumed by
`opp2.html`'s assignment screen; a clubless referee is meant to count as neutral for the
club criterion, no equivalent decided for nationality.

### Referee rosters — tournament + competition (2026-07-27)
`tournament_referees`/`competition_referees` join tables; a competition's effective
roster is the union of its own roster and its tournament's, tagged `via`. UI on
`competition-detail.html` and `tournaments-detail.html`. `opp2.html`'s officiating
dropdowns still pull from every referee in the DB, not scoped to these rosters (deferred).

### Referee roster ranking (2026-07-27)
`rank_order` column (migration 034) models FIE t.50.3's ranked-referee-list; auto-rank-
by-level and manual up/down UI. The actual lot-draw mechanism (drawing referees for a
specific pool/DE-quarter from the ranked list) is not built.

### Pool referee auto-assignment (2026-07-27)
`services/poolRefereeAssignment.js`'s `autoAssign` — bipartite matching (Kuhn's
algorithm) draws referees from the competition's roster, minimizing nationality/club
conflicts in threshold stages, reports unassigned pools. Extended same day with
Hall/König shortfall diagnostics (which specific referees are missing and why) and
combined multi-competition solving for simultaneous pool rounds.

### Pool phase (complete)
FIE serpentine seeding + separation, FIE official bout order (verified against real FIE
GP XML and 3 vendors), live rankings, simulate, phase close/chaining, combined seeding
across phases. UI: `public/phase.html`, `public/pool.html`. Advancement supports
count/percentage/multiple with `roundTo` and a `minForCut` small-field guard.

### DE phase (complete)
FIE serpentine tableau seeding, all rounds pre-built with byes auto-finished,
`allPlacesFenced`, repechage (Tables D–G with FIE injection seeding — a real
completion bug in heavy-bye draws is fixed and verified). UI: `public/de.html`, with a
narrow-screen per-round accordion.

### Handedness-aware strip-side placement (2026-07-08)
FIE t.22: a left-hander is always placed on the referee's left when paired against a
right-hander — automatic for every pool/DE bout (`Bout.normalizeHandedness`), plus a
manual referee override (`Bout.swapSides`) exposed over OPP2 via bidirectional
`apparatus/fencers`/`software/fencers` (spec change merged upstream, PR #7). Verified
end-to-end against a real ESP32 firmware implementation. Live-MQTT testing against real
hardware is the one still-open verification gap.

### OPP2 roles/responsibilities discussion — ongoing (started 2026-07-08)
`docs/roles-and-responsibilities-discussion.md` — non-normative draft on which OPP2
element should execute each bout function (intent → executor → state → display model).
Read the file directly.

### OPP2 security and provisioning discussion — started 2026-07-13
`docs/security-provisioning-discussion.md` — non-normative draft on how OPP2 publishers
become authorized. Converged design (Tier A cert-based, Tier B credential-pool) pushed
upstream as PR #10, merged 2026-07-14. Implementation status lives under "Device Pairing
Tiers" in memory / the Tier A and e-scoresheet sections below, not in this doc.

### Standalone e-scoresheet (PWA)
`docs/e-scoresheet-standalone-design.md` — non-normative design doc; read directly for
rationale. Built and verified on real Android + iOS (Safari only) hardware: PWA app
shell, local CA + `openpiste.local` HTTPS, MQTT-over-WebSockets live piste display, card-
reason recording, full feature parity with `public/scoresheet.html` (bout list, pool
matrix, team relay banner). Pairing was rebuilt to the converged Tier A/B design (no
longer ticket-based — see Tier A section below). **Piste-scoping still open:** a paired
e-scoresheet credential can write to any piste's `scoresheet/*` topics, not just the one
it's watching.

### e-Scoresheet network-drop resilience fixes — complete, 2026-07-16
Split the "apparatus online" and "my phone lost WiFi" status badges, made card-reason
detection reconnect-safe (resets on every reconnect rather than diffing across a gap),
and stopped over-trusting `navigator.onLine` as the sole connectivity signal. Real
network-drop testing on a device is still the one open verification gap.

### e-Scoresheet legacy/no-apparatus mode discussion — paused 2026-07-15
`docs/e-scoresheet-legacy-mode-discussion.md` — non-normative, nothing implemented,
paused. Reframed mid-design: brief network instability (worth engineering OPP2
resilience for) and sustained connection loss (no real-time data to protect, needs a
much simpler two-sync-point paper-scoresheet replacement instead) are different
problems. Whichever mode is built, both sync points must be standardized OPP2 messages,
not an Atlas-specific REST call — no such message exists in the spec yet.

### Tier A (certificate-based) device provisioning — complete, 2026-07-14/15
Implements `docs/level2.md` §30.5: embedded/native components authenticate with a TLS
client cert instead of Tier B's username/password, exchanged over reserved
`openpiste/_provision/*` topics. Built and verified against real ESP32 firmware
hardware — several real bugs found only by pairing an actual device (MQTT message
fragmentation, an ACL gap blocking the response leg, a crash on first successful grant,
a TLS-hostname mismatch, re-provisioning being permanently impossible after first pair,
certificate accumulation, unbounded CRL growth) are all fixed; see the log for root
causes. **CMS self-authentication (2026-07-15):** Atlas's own OPP2 client now also
authenticates via its own cert (CN `software-cms`) rather than publishing `software/*`
anonymously, closing a spoofing gap.

### Mid-competition failover bundle — complete, 2026-07-15
`scripts/create-failover-bundle.sh`/`restore-failover-bundle.sh` — AES-256-encrypted 7z
bundle of `data/atlas.db` + `data/tls/` (including the CA key) for a pre-provisioned
standby server to take over without every device re-pairing. Verified with a full
encrypted round trip against a real standby machine; two real bugs found and fixed
(a stale-cert-path bug in the broker-cert installer, and a root-owned `.git` objects
issue unrelated to the bundle itself but found while testing it).

### Hostname provisioning — complete, 2026-07-15
`scripts/set-hostname.sh`/`restore-hostname.sh` — sets/restores the `openpiste` hostname
`install.sh` had always assumed was already set by hand. Verified in an isolated sandbox
across all branches; never touched the real dev machine's hostname while building it.

### Clean-install broker/NTP provisioning — complete, 2026-07-15
`scripts/provision-broker.sh` — installs Mosquitto and its 4 listeners plus chrony as a
local NTP server, none of which any script had ever actually set up before (the
reference deployment's broker had always been configured by hand). Verified against a
real disposable Mosquitto instance.

### Competition formats (complete)
`formats/*.json` shape files + `formats/catalog.json` (named/taggable aliases, 22+
entries) define multi-phase flows with cohorts and exemptions. Covers FIE GP/Worlds/
World Cup, Division 1/2 independent parallel tracks, pool-result-based splits, and the
common club formats — audited against Engarde and FencingTime's full template sets.
Known remaining gaps (parallel Division 1/2 richness beyond straight DE, "tableaux by
levels" for DE, multi-round pool→DE→pool shapes) listed in "What is NOT yet built" below.

### Results
Full competition results combining DE + pool-eliminated fencers, unique ranks except
shared 3rd. Format-driven multi-stage under-counting bug fixed 2026-07-07 (now branches
format-driven vs free-form competitions).

### Team competitions
Built to a meaningful degree: `services/teamMatches.js`/`teamPhases.js`,
`lib/teamFormation.js`, FIE 9-relay format, team DE bracket + results, OPP2 relay
integration, pipeline scheduling, referee assignment. Known gap: no repechage/
all-places-fenced equivalent for team DE (individual DE has this, team doesn't).

### Strips
CRUD for pistes/strips, inline rename, strip assignment to pools. UI: `public/strips.html`.

### Frontend layout & responsive system (complete as of 2026-07-02)
Five shared layout classes (`.layout-form/-data/-detail/-app/-wide`) in
`public/css/style.css`, driven by available width (never orientation). Dense tables
reflow to cards below 700px. `opp2.html` and `scoresheet.html` got master-detail/
side-by-side interaction changes; DE bracket got a narrow-screen accordion.

### OPP2 design principle — ecosystem independence
Every OPP2 component (apparatus, remote, scoresheet, display, CMS) must be
independently implementable from the spec alone. Consequence: never put Atlas-internal
IDs (`pool_id`, `phase_id`, etc.) into MQTT payloads.

### OPP2 / MQTT integration (foundational layer complete as of 2026-05-31)
Native JSON over MQTT per `docs/level2.md`. TCP on 1883, topic structure
`openpiste/{piste_id}/{publisher}/{message_type}`. Atlas publishes as `software`,
subscribes to `apparatus/*`; correct-ending rules (§23.4) gate ACK/NAK; per-strip
pipeline scheduling with predicted-end computation and an adaptive
`bout_duration_standards` average (built, not yet validated against a real live-MQTT
competition run); officiating roster + decision attribution; referee/official
double-booking detection with schedule-cascade resolution (2026-07-27). See "Key files"
below for the OPP2-specific file list.

### Kiosk waiting-room displays — complete, 2026-07-27
`public/kiosk-fencers.html` (per-competition fencer schedule) and
`public/kiosk-officials.html` (cross-competition officiating schedule), full-screen
auto-scrolling displays for a spectator monitor, linked from `admin.html`.

---

## What is NOT yet built — priority order

The "full DE tableau" bucket (repechage/allPlacesFenced bracket generation, the OPP2
pipeline placement/repechage strip-assignment bug, the repechage bracket-completion bug,
and the narrow-screen accordion) is now **fully done and verified** as of 2026-07-02 —
see "DE phase (complete)" and "Pipeline — piste scheduling" above. Also fixed in the same
pass: `addSlot` didn't dedupe `team_match_id` the way it already did for `pool_id`,
so reassigning a team match to a new strip left a stale slot on the old one — both
strips would then offer the same next relay (relays have no per-relay strip column to
partition on, unlike pool bouts). Fixed by mirroring the pool dedup guard.

### 1. Run a full tournament locally (no cloud needed)
- Direct competition import — federation/FIE start lists without touching the local people DB
  - Engarde XML format now fully understood (see `docs/GP/` for reference files); move this off "out of scope"
- ~~Registration desk — review `checkin.html` for competition-day check-in completeness~~ —
  **reviewed and wired into phase creation, 2026-07-28** — see "Presence gate on first-round
  creation" under Competitions below. `checkin.html` itself (present/withdrawn toggle
  buttons, summary counts) already existed and needed no changes beyond a guidance banner.
- Card reasons — FIE t.170 text (English + French) and decision attribution (which
  official — referee/referee2/assessor — made the call) are both done; still open:
  store the spec `ts` field instead of server datetime, and the match clock value
  (from `apparatus/clock`) at card time
- Manual appendices B and C
- ~~Fencer handedness (`hand`: R/L)~~ — **stale line, corrected 2026-07-08**: the data
  field already existed (`fencers.handedness`/`competitors.handedness`, CSV + FIE XML
  import, people/fencers UI — all predate this note). What was actually missing —
  strip-side placement — is now built; see "Handedness-aware strip-side placement" below.

### 2. Scoresheets
- Pool scoresheet grid (fencer vs fencer diagonal matrix) requires each fencer's **slot position in the pool** (Engarde: `NoDansLaPoule` 1–N). Currently derivable from seeding order but not stored. If a fencer is manually moved the grid breaks. Add `pool_slot` to the pool-fencer join table via migration.
- Cards are annotation/audit data only — Engarde does not include them in the results XML export. Keep card records separate from the authoritative bout result.
- Per-bout scheduled time: Engarde assigns `Heure` per individual DE bout (across strips). Atlas schedules at slot (round) level. Deriving per-bout times from slot data is sufficient for now.

### 3. Architecture / code hygiene
**Full dated forensics for this whole item moved to `docs/implementation-log.md` on
2026-08-03** — read it for root causes, verification steps, and the discussion that led
to the mechanical-checks approach.

**2026-07-28 architecture review — fully complete, every finding fixed.** Summary: one
live correctness bug (`_combinedSeeding` duplicated and drifted between
`services/phases.js` and `services/formats.js`, reopening a presence-gate bug — fixed),
referee double-booking conflict detection made server-enforced (was client-only — fixed,
migration 031), DE partition-range server-side validation added, the project's own
"prepared statements must be module-level" rule retrofitted across all 25 `services/`
files (2 real pre-existing bugs found in the process — a `co.fencer_id` column that
never existed, one of them on the live OPP2 team-relay hot path), the 4 `routes/*.js`
files calling `db.prepare()` directly moved into services (surfacing a missing-
transaction gap, now fixed), and three god-files split by extraction:
`services/phases.js` → `poolPhases.js`/`dePhases.js`/`phases.js` (orchestrator);
`services/pipeline.js` → `pipelineSlots.js`/`pipelineNav.js`/`pipelineRosters.js` +
`lib/deSlotMath.js`; `public/opp2.html` → six Alpine mixin files under `public/js/`.

**`scripts/check-architecture.sh`** (+ `scripts/check-circular-requires.js`) now scripts
every mechanically-checkable KPI — file size, prepared-statement hoisting, raw SQL
confined to `services/`, no `ALTER TABLE` outside migrations, `'use strict'`, duplicate
function names, circular requires/layering — and reports **0 hard-rule failures
codebase-wide**. Run it before committing any change under `services/`, `routes/`,
`lib/`, `public/*.html`, or `public/js/*.js`. `docs/architecture-kpis.md` has the full
KPI reference, including judgment-based checks (domain cohesion, transaction
correctness, documentation currency) reserved for periodic explicit review rather than
every commit.

### 4. Security
- Authentication: fully wired — session-based PIN login, roles: `admin` / `director` / `assistant` / `referee`
- GET requests are public; mutations are gated per route (`writeOnly(role)` in `server.js`)
- OPP2/MQTT config and user management require `admin`; phase/bout scoring requires `director`
- Install creates an `admin` account with a one-time PIN (forced change on first login)
- `scripts/reset_admin_pin.js` resets a lost admin PIN

### 5. OPP2 cloud bridge
- Mosquitto bridge config to remote broker
- `tournament_id` / `competition_id` from Atlas in payloads
- Lower priority: local operation is fully functional without it

### Out of scope for MVP
| Feature | Notes |
|---|---|
| Cyrano scoring machine | Lower priority than cloud bridge |
| FIE Engarde XML export | Out of scope for now; format fully understood from `docs/GP/` reference files |

---

## Key files

| Path | Purpose |
|---|---|
| `server.js` | Entry point, route mounting, migration runner, OPP2 auto-connect |
| `db/migrator.js` | Runs pending `.sql` files on start |
| `db/migrations/` | Numbered schema migrations (001–030) |
| `rules/` | JSON rule documents (pool-standard, de-standard, …) — see `docs/format-authoring-guide.md` for the full field reference |
| `formats/` | Format shape files + `catalog.json` — see `docs/format-authoring-guide.md` |
| `docs/format-authoring-guide.md` | Complete authoring reference: rule files → format shapes → catalog entries, with a worked end-to-end example |
| `lib/poolFormation.js` | FIE pool seeding + calcPoolOptions |
| `lib/boutOrder.js` | FIE official bout order tables |
| `lib/deFormation.js` | FIE DE tableau seeding (buildSeedPositions, buildDE) |
| `lib/opp2Client.js` | OPP2 MQTT client singleton |
| `lib/opp2Composer.js` | Builds/publishes OPP2 messages (fencers, match, score, record) |
| `services/phases.js` | Orchestrator: findById/findByCompetition, close/simulate/reopen/delete (mixed pool+DE logic), re-exports the two files below |
| `services/poolPhases.js` | Pool-specific: calcOptions, create, calculateRankings |
| `services/dePhases.js` | DE-specific: getDeOptions, createDE |
| `services/bouts.js` | Score entry, undo, advanceDEWinner |
| `services/results.js` | Final competition results combining DE + pool |
| `services/deLayout.js` | Builds de.html's main/repechage/placement sections incl. stripSlot (bracket, de_round, tableau, partition) for each round; `placementGroupBoutIds` resolves a placement pipeline slot to bout IDs |
| `services/pipeline.js` | Orchestrator: re-exports pipelineSlots/pipelineNav/pipelineRosters as one `Pipeline` API |
| `services/pipelineSlots.js` | Slot CRUD, officiating roster, referee double-booking enforcement |
| `services/pipelineNav.js` | Live OPP2 hot path: activeSlot/markActive/markDone, pendingBoutCount, nextBout/prevBout, relay resolution |
| `services/pipelineRosters.js` | competitorsForSlot/fencersForCompetition (kiosk waiting-room displays) |
| `lib/deSlotMath.js` | Pure DE tableau/partition/de_round math shared by the three pipeline files above |
| `public/opp2.html` | Pipeline builder page shell — six `<script src>` mixins below + `mergeMixins()`/`app()` |
| `public/js/opp2-core.js` | opp2.html Alpine mixin: strip-list state/lifecycle, DE partition math, shared low-level helpers |
| `public/js/opp2-add-slot.js` | opp2.html Alpine mixin: single-slot add form (pool/DE/team_match), multi-strip distribution |
| `public/js/opp2-conflict.js` | opp2.html Alpine mixin: referee assignment, double-booking conflict detection/resolution |
| `public/js/opp2-schedule-ops.js` | opp2.html Alpine mixin: move/drag/reorder/delete slots + schedule recascade |
| `public/js/opp2-bulk-assign.js` | opp2.html Alpine mixin: bulk-assign modal + undo |
| `public/js/opp2-referee-schedule.js` | opp2.html Alpine mixin: by-referee Gantt view |
| `services/settings.js` | Key/value settings (broker URL, enabled flag) |
| `services/cardReasons.js` | Card reason persistence, incl. official attribution |
| `public/opp2.html` | Pipeline builder, live piste status, piste + referee Gantt charts |
| `public/referee-schedule.html` | By-piste / by-referee schedule views |
| `scripts/sync-spec.sh` | Diff/update `docs/level2.md` against the canonical upstream spec |
| `scripts/check-architecture.sh` | Mechanical architecture/code-quality checks — run before committing any change under `services/`, `routes/`, `lib/`, `public/*.html`, or `public/js/*.js`. See `docs/architecture-kpis.md` |
| `docs/architecture-kpis.md` | Full architecture/code-quality KPI reference — mechanical (scripted) + judgment-based (periodic review) |

---

## Development

```bash
node server.js          # start on port 3000
# or
pm2 start server.js --name atlas
```

DB file: `data/atlas.db` (gitignored). Created by `install.sh` or on first start.

Test data: 37 U17 male foil fencers across 6 Belgian clubs (seeded by national ranking).
