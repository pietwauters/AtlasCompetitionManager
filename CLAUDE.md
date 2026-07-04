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
- FIE serpentine seeding + separation (nationality for FIE formats; club also supported for
  non-FIE rule files — see "Pool formation" above)
- FIE official bout order (pools of 4–12) — **verified against real FIE GP XML, and
  cross-checked 2026-07-04/05 against 3 independent vendors' real competition data
  (Fencing Time, Engarde, Ophardt) — see `docs/format-system-comparison.md` §7**
- Live rankings (V/M, indicator, touches scored/received)
- Simulate function for random result entry (testing)
- Phase close: saves rankings, applies advancement, marks eliminated
- Phase chaining: previous pool rankings seed the next phase
- Combined seeding: aggregate stats across multiple pool phases
- UI: `public/phase.html`, `public/pool.html`
- **Advancement dead-doc/dead-code cleanup — FIXED 2026-07-08** (doc §8 item 1).
  `minimumVictories` and `top_per_pool` were documented in the (now-removed) `rules/RULES.md` and (the
  former) cargo-culted as `null` into all 4 shipped rule files, but never read by
  `services/phases.js`'s `close()` — struck from the docs and rule files rather than
  implemented, since nothing needs them. `rules/pool-advancement-choices.json` (an
  unwired stub meant to let a rule file offer a director a curated menu of advancement
  methods at close time) deleted rather than wired up: `phase.html` already has a
  generic, always-available "Advance:" override at close time for any pool phase
  (documented in the domain model above as "the competition manager can always manually
  override the proposed advancement list"), and it already covered 3 of the stub's 4
  methods (count/percentage/multiple). The one real gap — `percentage` + "rounded up to
  a multiple of N" — was a genuine miss: `services/phases.js` already read `adv.roundTo`
  (line ~425) but no UI ever sent it. Fixed by adding a `roundTo` input next to that
  override, shown only when `percentage` is selected.
- **Combined authoring guide added 2026-07-08.** `rules/RULES.md` and `rules/RULES-DE.md`
  (pool/DE rule-file field references) removed and folded, verbatim content plus a new
  end-to-end worked example and the format-shape/catalog schema (previously undocumented
  anywhere — see "Competition formats" below), into a single
  `docs/format-authoring-guide.md` — one place to read to build a whole dedicated
  competition format (rule file → format shape → catalog entry), not three.

### DE phase (complete)
- FIE serpentine tableau seeding
- All rounds pre-built on phase creation; byes auto-finished and wired
- Score entry, undo, winner auto-advancement
- Simulate function
- `allPlacesFenced` (unique rank down to last place): fully implemented and **verified
  end-to-end** — `de-all-places-t16.json` runs through `Phase.simulate()` to completion
  with zero stuck bouts, including multi-level placement groups (5th-8th, 9th-16th etc.)
- Repechage (Tables D/E/F/G with FIE injection seeding): bracket-building is correct, and
  a real completion bug found 2026-07-02 is now **fixed and verified**. Root cause: Table
  D pairs *consecutive R1 losers* — when two R1 byes land adjacent in the seeding (high
  bye-count draws, e.g. N=20 in a T32), neither bye has a real loser to route, so that
  Table D slot got permanently stuck with zero entrants, stalling everything downstream
  (confirmed on both `de-repechage-t32-t8.json` and `de-repechage-t64-t4.json`; light-bye
  draws like N=30 in a T32 were unaffected, which is what hid this for so long — no
  repechage phase had ever actually been run with a heavy enough bye count to hit it).
  Fix: `services/bouts.js`'s `routeBoutResult` cascade now detects when *both* sides of a
  repechage/placement bout are permanently starved (not just "one side, other side is a
  dead bye" as before) and resolves it as a no-result phantom bout (`winner_id = NULL`,
  `status = 'finished'`) so the emptiness propagates transparently to whatever it would
  have fed. `services/phases.js`'s `createDE` now runs every bye through
  `routeBoutResult` at creation time (Pass 4) instead of only hand-forwarding its winner,
  since that's what makes the cascade check fire at all. Verified against N=20/T32
  (heavy bye), N=30/T32 (light bye), and N=34/T64→T4 (very heavy bye, 14 phantom bouts) —
  all complete with zero stuck bouts and `services/results.js` produces unique ranks with
  no crash even with phantom bouts present.
- Final results table: unique rank per place when `allPlacesFenced`/repechage rules are
  used; otherwise 1st/2nd unique, 3rd shared if no bronze bout, others by seed
- UI: `public/de.html` — generic `sections`/`displayHint` renderer handles main,
  placement, and repechage brackets side by side. Below 700px width, `displayHint:
  'bracket'` sections (main/Finals) become a per-round collapsible accordion instead of
  horizontal scroll (`isNarrow`/`matchMedia`, same pattern as `opp2.html`'s master-detail
  drill-down); one round auto-expands on load (first with an unfinished real bout, else
  the last round). `displayHint: 'list'` sections (repechage/placement) already reflowed
  fine via CSS grid and needed no JS change. Also fixed while building this: the piste
  label/strip-filter functions (`roundPisteLabel`, `roundVisible`, `boutVisible`) matched
  slots by `(bracket, tableau)` only — the same ambiguity fixed server-side in
  `services/pipeline.js` above — now match on `de_round` when available.
- Bout order within each round: sequential by bracket position (top to bottom) — **verified against real FIE GP XML**

### Competition formats (complete)
- Format files in `formats/*.json` (**shapes** — stage-pipeline definitions, id unchanged
  since before the catalog existed) define multi-phase flows with cohorts and exemptions
- `formats/catalog.json` (added 2026-07-05) — named, taggable entries that alias a shape;
  multiple entries may share one shape (e.g. Worlds/World Cup/Grand Prix Senior Individual
  all alias `grand-prix-fie`, per FIE o.83). See `docs/format-system-comparison.md` §9.
- `services/formats.js` — `loadFormat` resolves a catalog id first, falling back to the
  pre-catalog direct-shape-file lookup for any `format_id` that predates the catalog (no
  migration needed); `listFormats` returns catalog entries plus a synthesized
  `scope: "custom"` entry for any shape with no catalog entry (still how self-defined
  formats surface); other exports (`resolveParticipants`, `applyPoolClose`,
  `closeFormatDE`, `validateCounts`) unchanged
- Migration 021: `format_id` on competitions, `format_cohort` on competitors, `format_stage` on phases
- Shapes: `grand-prix-fie.json` (3-stage GP/Worlds/WC — bronze-bout bug fixed 2026-07-05,
  see below), `mixed-formula-b.json`, `two-pool-rounds.json`, `two-pool-rounds-round2.json`,
  `two-pool-rounds-repechage-t32-t8.json`, `two-pool-rounds-apf-t16.json`,
  `pool-level-pools.json`, `pool-de.json`, `pool-de-repechage-t32-t8.json`,
  `pool-de-repechage-t64-t4.json`, `pool-de-apf-t16.json`, `pool-top8-de-fo3.json`,
  `pool-top16-de-fo3.json`, `de-only-bronze.json`, `de-only-no-bronze.json` — 22 catalog
  entries across them (`docs/format-system-comparison.md` §9-9.1). Audited 2026-07-05
  against every Engarde `.fta` formula and all 35 FencingTime `EventTemplates.xml` entries
  — fully covered except formats needing new engine capability (Division 1/2 parallel
  competitions, repechage-to-a-specific-standalone-placement, "tableaux by levels,"
  multi-round pool→DE→pool/APF shapes like `SUPERPOOLS`) — see doc §9.1 for the full list.
- GP format verified against real FIE Grand Prix XML (Shanghai 2026, 233 fencers): 16 initial exempts, 70% pool advancement, 32 survivors from preliminary tableau, T=64 final
- UI: format picker in competition detail (`public/competition-detail.html`) — "Official
  FIE formats only" checkbox (default on) + `<optgroup>` grouping by tier/age category,
  inline display of a catalog entry's `note` (caveats/approximations); stage plan with
  "+ Next stage" guided creation unchanged
- **Comparison study vs. Engarde and FencingTime (2026-07-03):** see
  `docs/format-system-comparison.md` for the full analysis. Summary: Atlas's
  `formats/*.json` shape matches FencingTime's linear `Round`-list model closely (and
  already covers Engarde's GP-shape, Brazilian, repechage, and all-places-fenced
  patterns). Confirmed real gaps, prioritized: (1) **fix dead docs/code** — (then)
  `rules/RULES.md` documented `minimumVictories`/`top_per_pool` advancement methods that
  `services/phases.js:408-426` never implements, and `rules/pool-advancement-choices.json`
  was an unwired stub with literal `"?"` placeholders — **fixed 2026-07-08**, see the
  Pool phase section below; `rules/RULES.md` no longer exists, folded into
  `docs/format-authoring-guide.md` (2) add a `minForCut` guard to pool
  `advancement` (don't cut a small field); (3) percentage-range advancement
  (`fromPercent`/`toPercent`, FIE rules often specify a range e.g. o.86.1's 20–30%); (4)
  "tableaux by levels" for DE (parallel same-size brackets by rank block — pools already
  have this via `pool-level-pools.json`, DE doesn't). Also checked FIE's Organisation Rules
  PDF directly against the codebase (doc §6-7): nationality/club pool separation (o.68.2)
  and the nationality-conflict special bout-order tables (o.70, pools of 6/7) are both
  **confirmed correct**, byte-verified against the rules text and (for the no-conflict
  pool-of-7 case) real GP XML in `docs/GP/`. `lib/boutOrder.js`'s `STANDARD[6]` was
  initially flagged as a likely bug from that cross-reference, then wrongly retracted after
  matching a document that turned out to be a probable USA-Fencing-domestic reference
  (not FIE-international) — then **actually fixed** 2026-07-04 once real data from an
  actual FIE World Cup (Lion of Bonn 2019) confirmed the original suspicion. `STANDARD[6]`
  now holds the table backed by that real competition and by a column-major reading of the
  current Organisation Rules PDF; the old value moved to its own `TRIO_6` (no longer an
  alias), which is still correct for the trio-conflict case. See doc §7 for the full
  four-round investigation — the short version is that no single document was trustworthy
  enough on its own here; it took two independent real/current sources agreeing to close
  it. **Pairwise lot-draw seeding**
  (o.87/o.102 "drawing lots in pairs") is now implemented for the individual GP/Worlds
  cohort merge (`formats/grand-prix-fie.json`'s `initial_exempt` cohort +
  `services/formats.js`'s `pairedLotDraw` flag) — team side (o.102) still open, needs its
  own design since team seeding doesn't go through the cohort system at all. Also added
  `formats/mixed-formula-b.json` (Junior/Cadet Worlds, Cadet/Junior WC, Zonals — pools then
  single DE, no bronze bout, o.89-94), which didn't exist as a ready preset before even
  though both ingredients (`pool-de.json`'s shape, `de-no-bronze.json`) already did. Lower
  priority / still open: sharks-and-minnows pools, Engarde/FencingTime import (export lower
  value), external/combined seeding lists + ranking-points classification (would make Atlas
  a cross-event ranking authority — separate scope decision), team DE repechage/
  all-places-fenced richness, pool-sheet-position-by-lot (o.68.3), pool-size floor
  (o.67.1). **Format catalog added 2026-07-05** (doc §9): the alias mechanism above,
  populated with every FIE individual combo buildable at full rule-accuracy today plus the
  common non-FIE club formats already catalogued in doc §2-3. Also fixed the
  `grand-prix-fie.json` bronze-bout bug while populating it (o.88 — no bronze bout in
  Mixed Formula A; confirmed against real `docs/GP/` data, no separate 3rd-place `Tableau`
  exists in the actual bracket). Discovered a new, separate gap while scoping team
  entries: team phase creation has **no format/rule picker at all** —
  `competition-detail.html` hardcodes `rule_doc: 'team-fie-standard.json'` — so Team World
  Cup/Zonal/Worlds catalog entries were dropped from this pass rather than added as
  cosmetic-only options; distinct from the already-tracked team-DE-placement-richness gap.
- **Independent parallel tracks added 2026-07-06** (doc §10) — the first of the two
  "needs new engine capability" gaps from the audit above, built (scoped to exactly what
  Engarde's Division 1/2 formulas actually need: 2 groups, straight DE per group, no pools
  inside a division). New pieces: `resolveParticipants`'s `rank_range` source; optional
  `dependsOn` on a stage (absent = the single preceding stage, unchanged for every prior
  format; explicit `[]` = no prerequisite, letting two stages both be "next" at once);
  `getFormatPlan`'s `nextStage` → `nextStages` (array); new `getTerminalStages(format)`.
  `services/results.js` now merges every terminal DE phase (not just the single last one)
  — offsetting each by the *actual entrant count* of tracks before it, not by how many
  places have been decided so far (would be wrong mid-tournament). A separate,
  format-agnostic "most recent phase must be finished" guard in
  `services/phases.js` (`Phase.create`/`Phase.createDE`) predated and blocked this even
  though `assertNextStage` correctly allowed it — found only during verification, fixed by
  skipping that guard specifically once a format has already validated the real
  dependency. `formats/division-1-2-t16.json` + 1 catalog entry. All verified end-to-end
  including regression checks against `pool-de` and `grand-prix-fie` (unchanged behavior).
  **Found, not fixed, unrelated to this change:** `results.js`'s "pool fencers" section has
  a pre-existing bug on multi-stage cohort-based formats like GP — fencers eliminated in a
  non-terminal DE stage never appear in results, causing duplicate place numbers. See doc
  §10 and §8 item 15.

### Results
- Full competition results page combining DE + pool-eliminated fencers
- Unique ranks except 3rd (shared); pool-eliminated appended in pool-rank order
- UI: `public/results.html`, endpoint `GET /api/competitions/:id/results`
- **Under-counting bug on multi-stage cohort-based formats — FIXED 2026-07-07** (doc §12).
  `getCompetitionResults` now branches: format-driven competitions (`_getResultsForFormat`)
  rank every *terminal* stage (`Format.getTerminalStages` — pool or DE) merged in
  format-declared order, then walk every other phase in reverse pipeline order appending
  eliminations as they're found, instead of guessing a boundary from one pool phase's
  `advanced` count. Free-form/no-format competitions (`_getResultsFreeForm`) keep the
  original code verbatim, untouched. Verified against the GP repro (100/100, all 11
  previously-missing preliminary-tableau eliminees present) plus 5 regression checks.
- **Pool-result-based independent split added 2026-07-06** (doc §10.1) — a Belgian club
  experiment ("Elite Division" / "Division 1"): one no-elimination pool round purely to
  rank the field, then split by *pool result* (not initial seed) into two independent
  tableaux, `dependsOn: ["pools"]` on both (§10's `dependsOn` mechanism already generalized
  to this with no further changes needed). New: `rank_range`'s optional
  `basedOn: "last_pool"`. `formats/pool-elite-division.json` + 1 catalog entry, verified
  end-to-end including that the split is genuinely by pool ranking, not initial seed.
- **Per-entry descriptions added 2026-07-06** (doc §11), to stop near-duplicate catalog
  entries from being picked by accident. Two parts: `services/formats.js`'s
  `describePipeline(format)` computes a `mechanics` string live from stage/rule data (never
  hand-written, can't drift stale) — including grouping independent/parallel stages into
  "waves" so Division 1/2 shows as `[independently]` rather than a misleading `→`; and a
  hand-written `why` field on all 24 catalog entries (`formats/catalog.json`), explicitly
  naming the distinguishing factor for every entry with a near-duplicate sibling, plus the
  governing article range for FIE-scoped entries. UI shows both the moment an option is
  selected, and `why` doubles as each `<option>`'s native hover tooltip.

### Team competitions
Built to a meaningful degree — the "Out of scope" note that used to be in this file was
stale (corrected 2026-07-03). `services/teamMatches.js`/`teamPhases.js`, `lib/teamFormation.js`,
`rules/team-fie-standard.json` (9-relay FIE format, relay bout order verified byte-exact
against Organisation Rules o.99.3), team DE bracket + results, OPP2 relay integration
(fencer/score resolution, NAK-on-baseline-regression handling), pipeline scheduling for
team matches (with `team_match_id` slot dedup matching the pool-slot dedup pattern), and
referee/official assignment all exist. UI: `public/team-de.html`, `team-match.html`,
`team-results.html`. **Known gap** (found 2026-07-03, see `docs/format-system-comparison.md`
§6): `rules/team-fie-standard.json` has no `repechage`/`allPlacesFenced` equivalent, so
Team World Championships' "all places to 16th fought for" (o.98.1) can't be expressed —
individual DE has this richness, team DE doesn't yet.

### Strips
- CRUD for pistes/strips; inline rename (click-to-edit)
- Strip assignment to pools: `PATCH /api/pools/:id` with `{strip_id, referee_id}`
- Assigning a strip sets `strips.status = 'assigned'`; clearing it resets to `'idle'`
- UI: `public/strips.html`

### Frontend layout & responsive system (complete as of 2026-07-02)

`public/css/style.css` defines a small named layout vocabulary — use one of
these on every new page's `<main>` instead of inventing a new `max-width`
value:

| Class | Behavior | Use for |
|---|---|---|
| `.layout-form` | Capped ~700px, centered, even on 4K | Narrow single-entity forms/results |
| `.layout-data` | Fluid up to ~1500px | Table/list pages (the majority of pages) |
| `.layout-detail` | Grid, `1fr 1fr` side by side ↔ stacks below 720px | Two-panel detail pages (apply to a wrapper *inside* `<main>`, not `<main>` itself) |
| `.layout-app` | No cap, fully fluid | Multi-pane dashboards/schedulers |
| `.layout-wide` | Fluid + `overflow-x:auto` | Inherently wide content (brackets, timelines) |

**Governing principle:** layout decisions are driven by **available width**,
never by the `orientation:` CSS media feature — a landscape phone can be
narrower than a portrait tablet, so width is the real signal and orientation
is just a correlated proxy. No page should hard-lock rotation (WCAG 2.1 SC
1.3.4 forbids restricting content to one orientation).

Also bundled in the same pass: form inputs/selects have a 16px font-size
floor (below that, iOS Safari auto-zooms on focus — do not drop this),
`header`/`.nav-right` wrap instead of overflowing, `.form-grid` stacks to one
column below 600px, and dense controls (`.row-actions button`, etc.) get
larger tap targets under `@media (pointer: coarse)` without affecting
mouse-driven desktop density.

Two pages needed real interaction changes, not just a CSS class:
- **`opp2.html`**: below 900px, the strip list and pipeline detail no longer
  both shrink side by side — an Alpine `isNarrow` flag (driven by
  `matchMedia`, set up in `init()`) switches to a master-detail drill-down:
  full-width strip list, tap a strip to see its full-width pipeline detail
  with a "← Back to strips" button.
- **`scoresheet.html`**: the pool matrix and bout list sit side by side above
  700px width instead of always stacking (`.pool-layout`), so a landscape
  tablet/phone uses its width instead of forcing extra scrolling.

**Dense tables → cards (complete as of 2026-07-02):** `table.table-responsive`
in `style.css` — below 700px, each row becomes a bordered card instead of a
squeezed/scrolled table, via `data-label` + `::before` (no JS). Opt-in per
table, not global — apply it to any new dense table (label/value pairs, one
per column). Applied to `people.html`, `fencer-roster.html`, `phase.html`
rankings, `admin.html`, `referee-schedule.html`, `clubs.html`, `strips.html`,
`competitions.html`, `tournaments.html`, `tournaments-detail.html`,
`results.html`. Skipped: `team-results.html` (only 3 columns, already fine).

**DE bracket narrow-screen accordion — DONE 2026-07-02:** see "DE phase (complete)"
above for the implementation; verified in a real browser at 390px (phone) and 1400px
(desktop) with a live repechage phase.

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
- `bout_duration_standards` table holds per-weapon/gender/phase-type default minutes-per-bout,
  seeded by migration 020 and editable via the admin UI (`GET`/`PATCH /api/opp2/bout-standards`).
  A running average (`observed_average`/`sample_count`) is recorded automatically from real
  bout durations over MQTT (`lib/opp2Client.js`, on `apparatus/control END`) and takes over
  from the configured default once `sample_count >= 4` (`services/boutDurationStandards.js`)
- Referee schedule is a derived view: all slots where the person is assigned in *any*
  officiating role (`pipeline_slot_officials` — see below), not just as primary referee
- On NEXT: Atlas walks the pipeline — exhausted slot auto-advances to the next one
- Multiple competitions can run simultaneously; each piste's pipeline determines what it fences

**Officiating roster & decision attribution (complete as of 2026-07-02):**
- `pipeline_slots.referee_id` is the primary referee only. `pipeline_slot_officials`
  (migration 024) adds up to four more roles per slot: `referee2` (second referee —
  common in team competitions), `video_assistant`, `assessor1`, `assessor2`. Any
  combination is optional; `Pipeline.getOfficials(slotId)` / `Pipeline.setOfficial(...)`
  in `services/pipeline.js` manage them.
- **Wire split, per the upstream spec (see the mirror rule above):** `software/fencers`
  (apparatus-facing) carries only `common.referee` — the apparatus and Cyrano-compatible
  systems never need more. The full roster (`referee`, `referee2`, `video_official`,
  `assessor1`, `assessor2`) is published on `software/record` instead — scoresheet-facing
  and retained, so a reconnecting scoresheet gets it immediately. Built in
  `lib/opp2Composer.js`'s `buildFencersCommon` / `buildRecordOfficials`.
- **Decision attribution:** `scoresheet/event` / `scoresheet/record` annotations (card
  reasons) carry an optional `official {id, name, role}` naming which specific official
  made that call — separate from the roster, which only says who's assigned to the bout
  at all. `public/scoresheet.html`'s card dialog shows a "Recorded by" picker only when
  more than one official is assigned (silent default otherwise — zero added friction for
  the common single-referee case). Persisted via `card_reasons.official_referee_id` /
  `official_role` (migration 025).
- `public/referee-schedule.html` (by-piste and by-referee views) and the referee Gantt
  chart in `public/opp2.html` both iterate every assigned official, not just the primary
  referee, tagging each with their role.

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
- `bout_duration_standards`' adaptive running average is built and wired (see above) but
  unexercised — `sample_count` is 0 across the board in the dev DB, meaning no real or
  simulated competition has run enough bouts over live MQTT to validate it yet
- Pipeline UI drag-to-reorder (▲▼ buttons work; drag is future)
- `video_review`'s `official` field is spec-documented (upstream, see the mirror rule
  above) but unimplemented — no Atlas code publishes `var/video_review` at all yet;
  there's no video-review tool built

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
- Registration desk — review `checkin.html` for competition-day check-in completeness
- Card reasons — FIE t.170 text (English + French) and decision attribution (which
  official — referee/referee2/assessor — made the call) are both done; still open:
  store the spec `ts` field instead of server datetime, and the match clock value
  (from `apparatus/clock`) at card time
- Manual appendices B and C
- Fencer handedness (`hand`: R/L) — not yet in `fencers` table; Engarde stores `Lateralite` (D/G); relevant for scoresheet display and OPP2 `software/fencers` payload

### 2. Scoresheets
- Pool scoresheet grid (fencer vs fencer diagonal matrix) requires each fencer's **slot position in the pool** (Engarde: `NoDansLaPoule` 1–N). Currently derivable from seeding order but not stored. If a fencer is manually moved the grid breaks. Add `pool_slot` to the pool-fencer join table via migration.
- Cards are annotation/audit data only — Engarde does not include them in the results XML export. Keep card records separate from the authoritative bout result.
- Per-bout scheduled time: Engarde assigns `Heure` per individual DE bout (across strips). Atlas schedules at slot (round) level. Deriving per-bout times from slot data is sufficient for now.

### 3. Architecture / code hygiene
- `bout_duration_standards` adaptive tracking is built but unvalidated — needs a real or
  simulated competition run over live MQTT to confirm the observed-average path behaves
  (see OPP2 section above)
- Pipeline UI drag-to-reorder (▲▼ works; drag is future)
- Resilience: discuss network loss / crash recovery across the ecosystem
- Minor: `CyranoServer.js` missing `'use strict'`

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
| `db/migrations/` | Numbered schema migrations (001–026) |
| `rules/` | JSON rule documents (pool-standard, de-standard, …) — see `docs/format-authoring-guide.md` for the full field reference |
| `formats/` | Format shape files + `catalog.json` — see `docs/format-authoring-guide.md` |
| `docs/format-authoring-guide.md` | Complete authoring reference: rule files → format shapes → catalog entries, with a worked end-to-end example |
| `lib/poolFormation.js` | FIE pool seeding + calcPoolOptions |
| `lib/boutOrder.js` | FIE official bout order tables |
| `lib/deFormation.js` | FIE DE tableau seeding (buildSeedPositions, buildDE) |
| `lib/opp2Client.js` | OPP2 MQTT client singleton |
| `lib/opp2Composer.js` | Builds/publishes OPP2 messages (fencers, match, score, record) |
| `services/phases.js` | Phase create/activate/close + DE creation + simulate |
| `services/bouts.js` | Score entry, undo, advanceDEWinner |
| `services/results.js` | Final competition results combining DE + pool |
| `services/deLayout.js` | Builds de.html's main/repechage/placement sections incl. stripSlot (bracket, de_round, tableau, partition) for each round; `placementGroupBoutIds` resolves a placement pipeline slot to bout IDs |
| `services/pipeline.js` | Piste pipeline: CRUD, bout navigation, predicted-end, officials roster |
| `services/settings.js` | Key/value settings (broker URL, enabled flag) |
| `services/cardReasons.js` | Card reason persistence, incl. official attribution |
| `public/opp2.html` | Pipeline builder, live piste status, piste + referee Gantt charts |
| `public/referee-schedule.html` | By-piste / by-referee schedule views |
| `scripts/sync-spec.sh` | Diff/update `docs/level2.md` against the canonical upstream spec |

---

## Development

```bash
node server.js          # start on port 3000
# or
pm2 start server.js --name atlas
```

DB file: `data/atlas.db` (gitignored). Created by `install.sh` or on first start.

Test data: 37 U17 male foil fencers across 6 Belgian clubs (seeded by national ranking).
