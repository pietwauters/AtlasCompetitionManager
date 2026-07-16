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
- **`minForCut` guard added 2026-07-08** (doc §8 item 2). New optional
  `advancement.minForCut` field in pool rule files: if the active fencer count in a
  phase is below it, `services/phases.js`'s `close()` advances everyone instead of
  applying `method`/`value` — matches FencingTime's own guard. Only applies to the
  rule's own automatic cut; a director's explicit close-time override always still
  applies regardless of field size. Not set on any shipped rule file — opt-in, not a new
  default (FencingTime itself leaves it disabled on all but one of its 35 templates).
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

### Handedness-aware strip-side placement (added 2026-07-08)
`bouts.left_id`/`right_id` isn't just a scoresheet column label — it's the physical
strip side, and it's genuinely load-bearing: FIE pool bout-order tables
(`lib/boutOrder.js`) assign it by pool-slot position, DE's advancement cascade
(`services/bouts.js`) assigns it by bracket structure (`tableau_position % 2`,
precomputed `winner_next_side`/`loser_next_side`), and OPP2's `software/fencers`/score
messages are wired to real apparatus lamps/connectors (`docs/level2.md`: "Red light:
left fencer scored"). None of that ever considered fencer handedness — which it must:
**FIE Technical Rules t.22** ("Coming on guard and placing of the fencers") specifies
that the fencer called first stands on the referee's right, *except* in a right-vs-left
bout, where the left-hander is placed on the referee's left regardless of call order
(t.22.2 covers the team version — greater right-hander count takes the referee's right,
tied broken by call order — not yet implemented; team relays go through a completely
separate code path, `services/teamMatches.js`/`teamPhases.js`, with no cohort/rule
resolution at all).

Two parts, both individual bouts only (pool + DE; team relays untouched):

1. **Automatic default — always on, not a rule-file setting.** `Bout.normalizeHandedness(boutId)`
   (`services/bouts.js`) swaps `left_id`/`right_id` so a left-handed fencer occupies
   `left_id` (mapped to the referee's left) whenever paired against a known
   right-hander, for every pool and DE bout unconditionally; no swap when both share a
   hand or either's handedness is unknown — the table/bracket-driven default is left
   untouched in both cases. (An earlier version of this gated the behavior behind an
   opt-in `bout.handednessAware` rule field — removed 2026-07-08 per direction that this
   must always apply whenever handedness is known, not be something a rule file can
   silently leave off.) Wired at every point a bout's two sides become concretely known:
   pool bout creation (`services/phases.js`'s `create()`, immediately after each bout
   insert); DE bracket creation for real (non-bye) round-1 pairs (`createDE()`, right
   after Pass 1's insert loop); and every dynamic routing write inside
   `services/bouts.js`'s `routeBoutResult` cascade (winner-forward, loser-forward, and
   the bronze-bout write) — called defensively after each write since the helper itself
   no-ops unless both sides are filled and the bout hasn't been scored yet, so a bracket
   where a bout's second side isn't known until several rounds later still gets
   normalized the moment it is. Reads handedness fresh from `competitors.handedness` by
   id — no need to thread it through `lib/poolFormation.js`/`lib/deFormation.js`'s
   existing (unmodified) pairing/seeding logic at all.
2. **Manual referee override — not optional, per t.22's "if it is not forced upfront by
   the CMS, the referee needs the possibility to swap the fencers."** `Bout.swapSides(boutId)`
   (`services/bouts.js`) is available regardless of how the current sides were assigned —
   a general safety valve, not tied to the automatic feature above. Swaps
   `left_id`/`right_id`, `left_score`/`right_score` (so each fencer's own score stays
   attached to them, not to whichever column they used to occupy), every `bout_history`
   snapshot's scores (so a later `undo()` doesn't misattribute a pre-swap snapshot), and
   every `card_reasons.side` for that bout (cards are keyed by side —
   `card_reasons.side TEXT CHECK(side IN ('left','right'))` — not by `competitor_id`, so
   they'd otherwise silently reattach to the wrong fencer after a swap). Refused once the
   bout is `finished` — `undo()` first, same as any other post-result correction. Exposed
   as `POST /api/bouts/:id/swap-sides` (`routes/bouts.js`, gated by the existing
   `writeOnly('director')` mount on `/api/bouts`) and a "⇄" button in both score-entry
   UIs: `public/pool.html`'s scoresheet grid (per bout row, hidden once finished) and
   `public/de.html`'s score modal ("⇄ Swap sides", shown instead of "↩ Undo" while a bout
   is still open).

**OPP2 integration — FIXED 2026-07-08.** The gap above (manual override was
Atlas-web-UI-only, no apparatus integration) is closed. Design settled on **not** a new
`control` command — that would have required apparatus state-machine changes (waiting
for corrected match data, re-pressing BEGIN) the user explicitly rejected as needless
complexity, and doesn't match how Cyrano actually does this. Instead, `fencers`
(`docs/level2.md` §15) is now bidirectional, mirroring the existing `score` precedent
(`apparatus/score` vs `software/score`): the apparatus can publish `apparatus/fencers`
with the `left`/`right` fencer objects exchanged, verbatim, whenever the referee
corrects the assignment locally (button or remote — the trigger itself stays entirely
outside OPP2, per the user's steer: "no-one will see a button, or an IR remote control,
only commands exchanged via MQTT are seen"). No new control command, no apparatus
state-machine change. Spec change is upstream at
[OpenPiste/protocols#7](https://github.com/OpenPiste/protocols/pull/7) (**merged
2026-07-08**) — also documents `apparatus/fencers` as retained (matching `apparatus/score`,
not the `software/fencers` carve-out), the scoresheet-side reaction (§18 "Fencer swap
mid-bout" — same `slot_id`/bout id but changed `left`/`right` means flip `side` on
existing annotations, not a slot change), and the NAK-gating extension (§25.4 — an
unresolved mismatch blocks END regardless of score/priority correctness).

Atlas-side implementation, `lib/opp2Client.js`:
- New `handleApparatusFencers(pisteId, payload)`, wired to a new
  `openpiste/+/apparatus/fencers` subscription. Compares the received ids against the
  active bout on file, in this order: **empty** (both sides absent — normal idle
  between bouts) → ignore; **identical to current** (same two ids, same sides — a
  confirmation echo, not a swap) → ignore; **clean swap** (same two ids, exchanged) →
  calls `Bout.swapSides`, then `_republishSwappedFencers` re-sends `software/fencers`
  (`identifyingOnly`, so it never resets score/clock/uw2f) and `software/record`;
  **anything else** (no active bout, the bout already has a result, or a pairing that's
  neither identical nor a clean exchange) → `_flagFencersMismatch` logs it, stores
  `state.fencersMismatch` (surfaced via `emitPisteState`/SSE to `public/index.html`'s
  "Live pistes" pills and `public/strips.html`'s table — a `badge-error` "⚠ fencer
  mismatch" tooltip naming the detail), and `handleEnd` NAKs unconditionally while it's
  set. Cleared whenever `state.boutId` changes (`handleNext`/`handlePrev`).
- The existing web-UI swap (`Bout.swapSides` via `POST /api/bouts/:id/swap-sides`) had
  the same desync risk in the *other* direction — a director swapping via the web page
  while an apparatus already had that bout loaded would leave the apparatus with a
  stale mapping. Fixed by extracting `_republishSwappedFencers` as a shared helper and
  exposing `OPP2.notifyBoutSwapped(boutId)` (`routes/bouts.js` calls it right after
  `Bout.swapSides`) — finds whichever piste currently has that bout active and pushes
  the same re-publish, regardless of which direction triggered the swap. Safe no-op
  when OPP2 isn't connected or no piste matches.

**Cross-checked against a real implementation, 2026-07-08** — `esp32scoringdeviceMqtt`
(`/home/piet/esp-idfProjects/esp32scoringdeviceMqtt`), an existing ESP32 scoring-device
firmware. Its swap feature (`Opp2Handler.cpp`'s `UI_SWAP_FENCERS` handling, triggered by
an already-implemented OPRCP remote-control command) **predates this design session by
over a month** (implemented 2026-05-24) — it already swaps fencers/scores/cards/
priority/lights/UW2F together, publishes under `apparatus/fencers` (`BuildTopic` always
uses the apparatus role), and marks it retained — all independently matching what this
session converged on. The legacy Cyrano/EFP1 path needs no separate swap code at all:
`PushCachedStatusToCyrano()` rebuilds the EFP1 cache fresh from the already-swapped
canonical state, leaving `EFP1Message::SwapFencersInclScoreCardsEtc()` genuine dead code
(never called, superseded by that refactor).

This comparison caught a real bug before it shipped: the firmware republishes
`apparatus/fencers` any time its assignment changes for *any* reason (a fresh
`software/fencers` arriving — e.g. every normal `NEXT` — MQTT reconnect, or clearing to
empty between bouts), not only after a genuine swap. The original Atlas handler only
recognized "clean swap" or "anomaly," so it would have flagged a false mismatch on
every ordinary bout transition. Fixed by adding the empty/identical no-op cases above,
verified against all five branches (empty, identical, anomaly, clean swap, no-active-
bout) using a temporary test hook (added, exercised, then removed — no test scaffolding
shipped). Also amended upstream: `docs/level2.md` §15 now documents that
`apparatus/fencers` isn't always a swap, pushed as a second commit to
[OpenPiste/protocols#7](https://github.com/OpenPiste/protocols/pull/7) — **merged
2026-07-08**; `./scripts/sync-spec.sh` confirmed Atlas's local mirror is byte-identical
to the merged version.

**Verified:** `Bout.swapSides` end-to-end (pool bout, pre-existing card follows the
fencer to its new side, rejected on a finished bout, `undo()`→swap→re-score recovers);
`OPP2.notifyBoutSwapped` no-ops safely with no live connection and with no matching
piste; all touched modules (`lib/opp2Client.js`, `routes/bouts.js`, plus every route
mounted alongside it in `server.js`) load with no circular-dependency issues. **Not
verified against a live or simulated MQTT broker** in this environment — same
documented limitation as `bout_duration_standards`' adaptive average (OPP2 section
above) — the actual `apparatus/fencers` message routing, the mismatch NAK-gating, and
the SSE-driven UI warnings are code-reviewed but not exercised end-to-end over real
MQTT traffic yet. **Next session:** live-MQTT testing against the real
`esp32scoringdeviceMqtt` firmware (broker + real device, not just code review) is
planned to close this gap.

Verified end-to-end with a throwaway competition: a 6-fencer pool with alternating R/L
handedness produced zero R-left/L-right pairs; the same setup with the shipped
`pool-standard.json` (before the always-on change, using the then-existing opt-in flag
off) reproduced several unswapped R-L pairs, confirming the gate worked as designed at
the time. An 8-fencer DE (including one fencer with unknown handedness) showed zero
violations in round 1 (created) and rounds 2-3 (filled in dynamically via `simulate()`),
confirming the cascade hook fires correctly as later rounds' pairings become known.
`swapSides` verified separately: a card recorded pre-swap correctly followed its fencer to the new
side; swapping a finished bout was correctly rejected; `undo()` → swap → re-score
correctly recovered from an already-finished bout.

### OPP2 roles/responsibilities discussion — ongoing (started 2026-07-08)

`docs/roles-and-responsibilities-discussion.md` is a **non-normative** draft document
(not part of the spec, not yet sent to the external friend it's intended for) working
out a general model for which OPP2 element should originate/execute each bout function,
rather than arguing it per-function. Core model: referee **intent** → **executor**
(decided by the "locality principle" — whichever element already has to hold the
resulting state for an unrelated reason; only the CMS and the apparatus ever qualify) →
**state** → **display**. Read the file directly for the full reasoning — this entry is
a pointer, not a substitute.

### OPP2 security and provisioning discussion — started 2026-07-13

`docs/security-provisioning-discussion.md` — another **non-normative** draft, same
spirit as the roles/responsibilities one above: needs first, then a model, before any
spec language. Complementary, not overlapping — that document assumes a message
arrived from an already-authorized publisher and asks who executes it; this one is
about how a publisher becomes authorized to begin with (today, none of them are —
every Mosquitto listener in Atlas's reference deployment is `allow_anonymous true`).

Surfaced concretely while building the standalone e-scoresheet PWA's pairing flow
(`docs/e-scoresheet-standalone-design.md` §4.3/§4.8) — realized partway through that a
fix scoped to "Atlas talking to Mosquitto" doesn't actually serve OPP2's stated
multi-vendor interoperability goal, so this was pulled out into its own document rather
than folded into Atlas's own implementation notes.

**10 needs established** (cross-vendor interop; device-capability diversity —
embedded/browser/native each have genuinely different capabilities, browsers
specifically cannot select a client cert from JS or touch a platform keystore at all;
no internet dependency; no specific-broker assumption; an explicit "not bank-grade"
trust-model statement; authorization scoped to the existing publisher-role topic
structure; revocation as a required *capability*, mechanism-defined; interoperability
pinned at the MQTT/TLS protocol level, not a broker's proprietary management API — only
the *provisioning exchange* itself is genuinely OPP2's to standardize; read stays open,
only write is gated; additive/backward-compatible, doesn't break already-fielded
hardware like the real ESP32 firmware).

**Model, briefly:** perimeter trust (physical/network access, already assumed) vs
component trust (what provisioning establishes) are kept separate; every provisioning
path traces back to a human vouching for the new component, same as physically
deploying an apparatus already does; **two device-capability tiers, both legitimate,
neither a workaround** — Tier A (embedded/native, fully scripted, e.g. the real ESP32
firmware's existing CSR-based enrolment) and Tier B (browsers/PWAs, requires at least
one manual OS-level trust action — installing a CA root, entering a relayed code — an
inherent property of the browser platform, confirmed directly against Atlas's own PWA
build, not a defect to keep trying to engineer away); credential *shape* is standard
MQTT/TLS, the *provisioning exchange* is what OPP2 actually defines; role-scoped
authorization with mechanism-agnostic revocation; additive/negotiable, not a breaking
requirement.

**Fully designed and pushed upstream, 2026-07-14** — the provisioning exchange
converged through several rounds of the user catching real gaps in each pass (a role/
tier field conflation bug; Tier A's revocation being hand-waved as "CRLs, OCSP" with
neither picked; an assumption that per-device Tier B credentials required a live/
dynamic broker capability, which turned out to be false once creation and assignment
were separated; an HTTP-based delivery design for Tier B that got replaced by
out-of-band QR/manual delivery, which is simpler *and* closes a residual third-party-
CORS gap the HTTP version still had). Final shape: Tier A is a scripted MQTT
request/response exchange against the deployment's CA with CRL-based revocation; Tier
B is a pre-generated, per-device credential pool with out-of-band (QR/manual)
delivery — no dynamic broker capability needed for either tier. Capability signaling
proposed as an optional `connection`-message field. Written into `docs/level2.md` §30
(filling what was an explicit "Open item — decision required" placeholder) and pushed
upstream as [OpenPiste/protocols#10](https://github.com/OpenPiste/protocols/pull/10)
— **merged 2026-07-14**. `./scripts/sync-spec.sh` confirms the local mirror is
byte-identical to the merged upstream version.

Atlas's own e-scoresheet pairing flow (`docs/e-scoresheet-standalone-design.md` §4.8,
"Option 1" — a single shared Mosquitto credential, HTTP-delivered) predated this
converged design and has been **rebuilt to match, 2026-07-14** — see
`docs/e-scoresheet-standalone-design.md`'s "Rebuilt to match the converged design" note
and `docs/security-provisioning-discussion.md` §4.6. Summary: unique-per-device MQTT
credentials, pre-generated into a `mqtt_credentials` pool (migration
`028_scoresheet_credential_pool.sql`, `scripts/top-up-credential-pool.js`) and pushed to
Mosquitto via `scripts/sync-mosquitto-scoresheet-acl.sh`; assignment
(`services/pairing.js`'s `assignCredential`, `routes/pairing.js`'s `POST /assign`) is a
pure Atlas-DB action with no network round-trip to the device; delivery is a QR/manual
credential in a URL **fragment** (never reaches Atlas's server or its logs) that
`escoresheet/js/app.js` reads and immediately scrubs via `history.replaceState`. The old
ticket-code/HTTP-redeem flow (`routes/pair.js`'s `POST /redeem`, `pairing_tickets`/
`paired_devices` tables, the dead `token` bearer concept) is fully removed, not kept
alongside the new flow. `apparatus`/`software`/`remote`/`var` topics were left untouched
in this pass — Tier A (apparatus certs) wasn't built yet at the time; this pass was
scoped to Tier B only, per `docs/security-provisioning-discussion.md` §3.3.1's own
conclusion that the e-scoresheet was, at the time, the only component that needed it.
**Tier A is now built too** — see "Tier A (certificate-based) device provisioning"
below. Verified end-to-end at the service layer
and over real HTTP (full pool lifecycle, route auth gating, QR image, fragment-URL
parsing) against a throwaway director account and a temporary credential batch on a
second, non-default-port server instance — the real dev server was left untouched and
all test rows were cleaned from the live DB afterward.

**Real bug found on the first live run, fixed same day.** Once the user actually ran
`sync-mosquitto-scoresheet-acl.sh` and paired a real device, the apparatus stayed
correctly online per Atlas's own backend but the e-scoresheet saw nothing. Cause: on
Mosquitto 2.0.18 a global/unscoped `topic read #` ACL line only reaches truly anonymous
connections — an authenticated device only gets what's inside its own `user <name>`
block, so every paired e-scoresheet's subscriptions silently received zero messages
(`SUBACK` still succeeded, hiding the failure). Fixed at the time by adding
`topic read #` inside each generated `user` block in `sync-mosquitto-scoresheet-acl.sh`
— **later superseded, 2026-07-15, by a more robust fix found while building Tier A**:
every genuinely universal grant now uses Mosquitto's `pattern` directive instead of
`topic`, which reaches every client regardless of auth state with no per-user
repetition at all — see "Tier A (certificate-based) device provisioning" below for the
full story (this same per-user-repetition gap turned out to also block Tier A device
re-provisioning, which is what prompted finding the better fix).
`docs/implementation-notes/mosquitto-security.md`'s examples had the same latent bug,
corrected the same way both times. Also **wired both provisioning steps into `install.sh`**
(credential-pool seeding, always; broker sync, only if Mosquitto is found on the same
host — otherwise printed as a manual next step) — previously both were undiscoverable
manual steps, which is exactly what let this bug go unnoticed until a real pairing.

One real spec change has come out of it so far and **is shipped**: `software/score`
changed from `Retained: Yes` to `Retained: No` in `docs/level2.md` (§4.5, §6, §13) —
`apparatus/score` is unaffected and stays retained. Reasoning: the apparatus is the
executor/authority for score/cards/priority regardless of network presence, so
`software/score` is a correction pushed to it, not a fact it should adopt unattended
from a stale retained replay — the same reasoning already applied to
`software/fencers`/`software/match`, just never carried back to `score` (confirmed via
git history: `Retained: Yes` predates the whole model, it was inherited spec text, not
a deliberate choice). No Atlas code change was needed — `lib/opp2Transport.js`'s
`publish()` helper already defaults to `retain: false` and both `software/score` call
sites in `opp2Composer.js` rely on that default, so Atlas was already spec-conformant
in practice; this closed a spec/implementation mismatch. Pushed upstream as
[OpenPiste/protocols#8](https://github.com/OpenPiste/protocols/pull/8), **merged
2026-07-09**; `./scripts/sync-spec.sh` confirms the local mirror is byte-identical.

### Standalone e-scoresheet (PWA) — architecture discussion, ongoing (started 2026-07-12)

`docs/e-scoresheet-standalone-design.md` — **non-normative, nothing implemented yet.**
Today's `public/scoresheet.html` is Atlas-rendered and SSE-driven, which means it (a)
doesn't demonstrate multi-vendor OPP2 interop and (b) dies if Atlas's own web server is
unreachable, even though the apparatus/referee could otherwise keep fencing. Target
shape agreed: a standalone **PWA** (no native iOS/Android app, one codebase, installable,
offline-capable via service worker) that talks OPP2/MQTT directly as its own ecosystem
participant. Read the file directly for full reasoning — pointer only, not a substitute.

Key conclusions so far:
- **Transport:** browsers can't open raw TCP sockets, so a browser OPP2 client needs
  MQTT-over-WebSockets. Purely additive on the broker side (a second Mosquitto
  listener) — no change to Atlas's own TCP-based `lib/opp2Client.js` or the apparatus
  firmware.
- **TLS trust, chosen approach:** each CMS install generates its own local CA (no
  shared ecosystem-wide root — avoids needing cross-vendor PKI governance; fine to
  regenerate the root per competition). The CMS's own cert is issued for
  **`openpiste.local`** (the existing mDNS hostname, not an IP) — this is what makes
  the whole thing DHCP/subnet-agnostic with zero internet dependency, since mDNS already
  re-resolves to whatever IP a venue's router hands out. Public-CA tricks (a
  `plex.direct`/`sslip.io`-style IP-embedded hostname, or Atlas's own domain + DDNS) were
  considered and rejected — they either share a published private key (weaker
  anti-impersonation) or need a fixed/trackable IP plus a live DNS dependency, which
  conflicts with Atlas's own "local operation needs zero internet" principle.
- **Pairing precedent:** `~/mqtt-web/enrolment.js`'s existing ESP32 scoring-device
  enrolment flow (local CA + operator-gated time-boxed window + CSR/HMAC challenge) is
  the model, adapted rather than copied. Its localhost-only gating and global
  single-pairing-slot don't work for an operator walking strip-to-strip with their own
  phone — reworked into: reusing Atlas's existing QR+PIN director/admin session instead
  of an IP check (`docs/security-and-roles.md` already lists "Electronic scoresheet
  (future)" in the access matrix), per-attempt single-use PIN tickets instead of a
  global slot (closes a real race condition and adds a human-verification step), and a
  bearer token instead of a client cert/CSR (no crypto library needed in-browser,
  trivial revocation).
- ~~**Open, unverified:** whether an installed/home-screen PWA handles a self-signed
  cert warning the same way a normal tab does~~ — **resolved.** Needs a real CA-profile
  install (a click-through alone isn't enough), confirmed hands-on on both real Android
  Chrome (2026-07-13) and real iOS Safari (2026-07-15 — Safari specifically; Chrome on
  iOS can't produce a true standalone install at all, see "iOS verified for real" below).
- ~~**Not yet designed:** the pairing-ticket API/payload shape, the PWA-side pairing
  UI~~ — **built** (see "pairing-ticket flow" below), **then rebuilt** to the converged
  Tier A/B credential-pool design (see "Device Pairing Tiers" / §4.5 of
  `docs/security-provisioning-discussion.md`) — no longer ticket-based. **Still
  genuinely open:** the three older scoresheet-authority sub-problems (offline
  bundle/pre-round export, local §23.4 correct-ending enforcement when Atlas is
  unreachable, stale-replay reconciliation) — see
  `docs/e-scoresheet-legacy-mode-discussion.md` for where that thread stands now
  (paused mid-design, 2026-07-15).
- **Implemented 2026-07-13:** the PWA app shell itself — `escoresheet/` (manifest,
  service worker with versioned app-shell caching, install/online-status page, no
  OPP2/pairing logic yet), mounted in `server.js` at `/escoresheet` as a plain static
  folder with no Atlas session/auth dependency. And the TLS piece: `./scripts/generate-
  tls-cert.sh` generates the local CA + `openpiste.local` leaf cert into `data/tls/`
  (gitignored); `server.js` now also listens on a second, additive HTTPS port
  (`HTTPS_PORT`, default 3443) on the same Express app — existing HTTP workflows are
  untouched. Verified via `openssl verify` + `curl --cacert` (full chain validation, no
  `-k`) against both `localhost` and the real `openpiste.local` mDNS hostname. **Not
  done:** the broker's MQTT-over-WebSockets listener, and any actual OPP2 client code in
  the PWA — nothing to connect to yet.
- **Verified 2026-07-13 on a real Android phone (Chrome), end to end:** HTTP
  reachability → HTTPS untrusted-cert warning before pairing (expected baseline) →
  installed `data/tls/ca.crt` via Android's certificate-install flow → HTTPS with no
  warning, service worker active → Add to Home Screen → launched from the home-screen
  icon in genuine standalone mode (no address bar/tabs). This resolves §4.4's open
  question **for Android**: once the manifest/SW/cert are all valid, Chrome does launch
  a real standalone PWA. One
  real snag hit and fixed along the way: on a dev machine with Docker installed, avahi
  was advertising `openpiste.local`'s IPv4 as the Docker bridge (`172.17.0.1`) instead of
  the real LAN interface — fixed with `deny-interfaces=docker0` in
  `/etc/avahi/avahi-daemon.conf` (not an interface allowlist, which would break under
  Ethernet). Also found: the first "Add to Home Screen" attempt produced a plain
  bookmark (not a real install) because it was tried before Chrome had settled on
  installability — retrying after the service worker was confirmed active fixed it;
  the eventual pairing UX should prompt for home-screen install only after confirming
  SW-active + warning-free, not immediately on first load.
- **iOS verified for real, 2026-07-15.** Resolved §4.4's open question for iOS too —
  genuinely works, but only from Safari specifically. First attempt failed because the
  device was using Chrome on iOS: Apple restricts true standalone-launching "Add to
  Home Screen" to Safari — every other iOS browser is a WebKit wrapper that at best
  produces a plain bookmark (opens with the browser's own address bar/tabs), never a
  real standalone window, regardless of manifest/service-worker correctness. Once
  switched to Safari and both cert-trust steps were completed (install the profile via
  `install-cert.html`, then separately enable **Full Trust** for the root CA in
  Settings → General → About → Certificate Trust Settings — the step that's easy to
  miss, since installing the profile alone leaves it untrusted for actual TLS use),
  install worked cleanly. No manifest/HTML changes were needed — `escoresheet/manifest.json`
  (`display: standalone`) and `escoresheet/index.html`'s iOS meta tags
  (`apple-mobile-web-app-capable`, `apple-touch-icon`, etc.) were already correct;
  this was purely a browser-choice + cert-trust-completeness issue on the device side.
- **Implemented 2026-07-13: broker WSS trust unification.** Mosquitto already had a
  `wss://` listener (`9002`, alongside plain-`ws://` `9001`) — nothing new needed on the
  transport side. It was presenting a cert from an unrelated pre-existing CA
  (`openpiste-CA`, likely from `mqtt-web`'s own setup), which would have meant pairing a
  device against two separate trust roots. Fixed via new `scripts/install-broker-cert.sh`
  — installs Atlas's own CA-signed cert into Mosquitto's TLS listeners (`8883`, `9002`);
  deliberately location-agnostic (works whether the broker is co-located with Atlas or
  on separate hardware — copy `data/tls/` there and run it there). Verified: both
  listeners now show `issuer=CN = Atlas Local CA`, chain validates (`Verify return
  code: 0`), and Atlas's own OPP2 client (plain `1883`, untouched) reconnected cleanly
  after the broker restart. *(True only at this specific point on 2026-07-13 — the PWA
  gained its first real OPP2 client code later the same day; see "Live piste display"
  below, and by 2026-07-16 the PWA has a full OPP2 client with published resilience
  fixes too.)*
- **Implemented 2026-07-13: pairing-ticket flow.** Migration `027_scoresheet_pairing.sql`
  (`pairing_tickets`, `paired_devices`); `services/pairing.js`
  (create/redeem/list/revoke/verifyToken — 6-digit codes, 5-min TTL, single-use, not
  DB-uniqued forever since codes are meant to be reused over a competition's lifetime).
  Two routers split by trust level: `routes/pairing.js` (`/api/pairing`,
  `auth.require('director')` on everything — ticket creation, device list/revoke, a
  ticket QR endpoint) and `routes/pair.js` (`/api/pair`, no auth — the device-facing
  `redeem` call). `public/pairing.html` is the operator UI (code + QR + countdown +
  device list), linked from `opp2.html`. `escoresheet/`'s pairing form now really calls
  `/api/pair/redeem`, generates+persists its own `deviceId` via `crypto.randomUUID()`,
  and stores the returned bearer token — assumes same-origin with Atlas's API (no
  CMS-address field; a true third-party scoresheet would need one). Service-worker
  cache bumped to `v2` since the app shell changed. **Real bug found and fixed:** the
  pre-existing `app.use('/api', writeOnly('director'), require('./routes/teamMatches'))`
  matches any `/api/*` path by prefix, so it was silently auth-gating the new public
  `/api/pair/redeem` too — fixed by registering `/api/pairing` and `/api/pair` before
  that catch-all. **General lesson: a bare `app.use('/api', ...)` mount traps anything
  registered after it — check route order whenever a new `/api/*` path is added.**
  Verified end-to-end over real HTTP: create→redeem→verify→single-use-rejection→
  revoke→re-verify-fails, plus `/api/pair/redeem` returns 403 (not 401) for a bad code
  confirming it's genuinely unauthenticated. **Verified fully on real devices** the
  same day: QR scan → e-scoresheet opens with code pre-filled → Pair → shows paired,
  and appears in `pairing.html`'s device list. One real bug caught along the way: a
  stale server process (predating the QR route being added — Node doesn't hot-reload
  route files) made the QR image 404; general lesson, restart after any
  `server.js`/`routes/*`/`services/*` edit, unlike `public/`/`escoresheet/` static
  files which reload on every request with no restart needed.
- **Implemented 2026-07-13: cert-onboarding friction reduction.** New `GET /ca.crt`
  (`server.js`, public, plain HTTP — deliberately not HTTPS, since a new device has no
  reason yet to trust what this CA signs) replaces the old ad hoc "copy into `public/`"
  workaround. New `public/install-cert.html` — unauthenticated onboarding page with a
  QR (`GET /api/pair/ca-qr`) + platform-detected instructions (Android/iOS/desktop
  Chrome/Firefox, shown via user-agent sniffing so nobody reads all four), linked from
  `pairing.html`. Also: `scripts/generate-tls-cert.sh` now **defaults to reusing the
  existing CA** (was: fresh CA every run, opt-in reuse) — `--rotate-ca` to deliberately
  start over. Rotating means every already-onboarded device redoes the one-time
  OS-level install dance, for every competition — real friction, not a one-off — so
  reuse is now the default and rotation is deliberate. After a rotation,
  `install-broker-cert.sh` must be re-run too (broker cert would otherwise still chain
  to the old, replaced root).
- **Implemented 2026-07-13: live piste display — the first real OPP2 client code in
  the PWA.** Deliberately read-only (subscribes/mirrors, never publishes) — the
  "display" role in the roles-and-responsibilities model. `escoresheet/js/app.js` uses
  `mqtt.js` (CDN, browser build of the same `mqtt` package Atlas's backend already
  depends on) to connect to `wss://{hostname}:9002` and subscribe to
  `apparatus/connection`, `apparatus/fencers`, `apparatus/score`, `apparatus/clock`,
  `software/match` for an operator-entered piste id, rendering fencer names, score,
  card chips, priority, clock, and an online/offline badge. Deliberately tracks only
  `apparatus/fencers` (not `software/fencers` too) — it's retained and always reflects
  the current correct assignment, so a passive display doesn't need to replicate the
  CMS's swap-reconciliation logic. No MQTT auth used (broker is `allow_anonymous
  true`, matching how apparatus already connects) — the pairing bearer token remains
  issued but unconsumed, reserved for a possible future Atlas REST API, not broker auth.
  **Verified without a real browser:** Node's own `mqtt` client replayed the exact
  subscribe flow against `wss://localhost:9002` with `data/tls/ca.crt` while a second
  connection published all 5 message types via plain `mqtt://localhost:1883` — all
  arrived with topics parsing correctly. **Confirmed for real 2026-07-13**: connected
  a real paired Android phone to an actual live, in-progress piste (not simulated
  data) and watched fencer names, score, cards, and clock render correctly in real
  time — closes the real-browser-rendering gap the Node-only test couldn't reach.
  Confirmed working on iOS too the same day.
- **Implemented 2026-07-13: card-reason recording — the PWA's first *publishing*
  feature**, everything before this was read-only. Ported from the existing
  `public/scoresheet.html` (Atlas's own Alpine.js/Paho scoresheet, which already
  implements this exact feature over the legacy plain `ws://:9001` listener) rather
  than designed from scratch — same card-detection logic, same `/data/reasons.json`
  data source, same dialog flow (reason grid, "Repeated Group 1" drilldown, free-text,
  official picker, skip), rewritten as vanilla JS/`mqtt.js`/`wss://` instead of
  Alpine/Paho/plain `ws://`. **No server-side code needed** — `lib/opp2Client.js`
  already subscribes to `scoresheet/event` and persists `CARD_REASON` annotations via
  `services/cardReasons.js`, built for the existing scoresheet, works identically for
  any compliant publisher — the ecosystem-independence principle actually paying off.
  New: subscribes to `software/record` (slot/active_bout/officiating roster) and
  `scoresheet/record` (retained history, for reconnect); `detectCards()` diffs
  successive `apparatus/score` payloads (skips the very first, so reconnecting to an
  already-carded piste doesn't false-trigger); publishes `scoresheet/event` per
  annotation and republishes the full `scoresheet/record` after each one; slot-change
  vs same-slot semantics per §17/§18 (new `slot_id` clears history, same `slot_id`
  keeps it). **Known imperfection, not fixed:** `scoresheet/record`'s `bout_id` is
  spec-mandatory but could be `null` if a card is detected before any `software/record`
  has arrived (unset `activeBoutId`) — narrow edge case, left as a known gap.
  **Verified:** syntax check, `/data/reasons.json` reachability, and a Node-simulated
  `software/record` + card-triggering `apparatus/score` sequence over the real `wss://`
  listener. **Tested on a real device — one real bug found and fixed:** the dialog
  opened correctly but wouldn't dismiss (Skip/submit did nothing visible). Root cause
  was CSS, not the dialog logic — `.overlay` set `display: flex` unconditionally, and
  an *author* stylesheet rule outranks the browser's built-in `[hidden]{display:none}`
  *user-agent* rule by cascade origin alone, regardless of specificity. The JS was
  correctly setting `hidden = true` the whole time; the CSS just kept showing it
  anyway. Fixed by scoping to `.overlay:not([hidden])`. Checked every other
  `hidden`-toggled element in the stylesheet (`.card`, `.error`, `.back-btn`,
  `.official-picker`) — none of the others set `display` at all, so this was isolated,
  not systemic. Confirmed fixed on a real device after a full reload (to verify the
  service worker's `skipWaiting()`/`clients.claim()` actually served the new CSS
  rather than a stale cached copy).
- **Implemented 2026-07-13: full feature parity with `public/scoresheet.html`.**
  Everything before this showed only the single active bout. Ported (same
  algorithms/data shapes, vanilla-JS/`mqtt.js` instead of Alpine/Paho): full bout list
  from `software/record`'s `bouts[]` (collapsible, LIVE badge + auto-expand for the
  active/unfinished bout, final result or placeholder for others, any bout
  manually expandable via event delegation since rows regenerate via `innerHTML`);
  pool results matrix (`computeMatrix`/`renderMatrix` — participants × participants
  grid, V/M, indicator, ranking, ported line-for-line from `scoresheet.html`'s `matrix`
  getter); team relay banner (relay/team/cumulative-score/target — Atlas-specific
  `software/match` extensions, not core §16 fields, handled defensively); slot-info
  line (label + officiating roster); manual theme toggle
  (`:root[data-theme]` overrides alongside `prefers-color-scheme`, mirrors `nav.js`'s
  pattern). **Deliberately carried over:** resetting `lastScoreForCards`/`lastFencers`/
  `lastClock` to `null` on every active-bout change — without it, card detection could
  diff the new bout's first score against the previous bout's final card state,
  causing spurious or missed triggers. **Verified:** every DOM id cross-checked against
  the HTML (two expected non-matches are dynamically-generated, correctly null-guarded);
  a fuller Node-simulated pool `software/record` (3 participants, 3 bouts, one
  finished) over the real `wss://` listener. **Tested on a real device — one real bug
  found and fixed:** the pool matrix never appeared. `#matrix-section` (outer
  container) was correctly shown by `renderMatrix()`, but the inner `#matrix-wrap`
  (the actual table) had a static `hidden` attribute only the manual toggle-button
  click handler ever cleared — stayed collapsed by default, unlike `scoresheet.html`'s
  `matrixOpen: true` (expanded by default). Fixed by removing the static `hidden` and
  defaulting the arrow to `open`. Bout list, team relay banner, slot info, and theme
  toggle all worked correctly on first real-device try, no fixes needed.
- **Tracked gap, raised 2026-07-13 — role-scoping now DONE, piste-scoping still
  open (corrected 2026-07-16).** The original note described `services/pairing.js`'s
  `verifyToken()`/bearer-token model, and `watchPiste()` sending no credentials at
  all — that whole system no longer exists. It was fully replaced by the Tier A/B
  credential-pool design (see "Device Pairing Tiers"): `escoresheet/js/app.js`'s
  `watchPiste()` now sends a real per-device MQTT username/password
  (`mqtt.connect(url, { username: mqttUsername, password: mqttPassword })`), required
  by the broker, and `scripts/sync-mosquitto-scoresheet-acl.sh` scopes each
  authenticated credential's write access by *role* (`topic write
  openpiste/+/scoresheet/#`, not open to anyone anonymous). So "any device that can
  reach the broker, paired or not, can watch/publish for any piste" is no longer
  true — an unpaired/unauthenticated device can no longer publish at all.

  **What's still genuinely open:** that same ACL line uses `+` (any piste), not a
  specific one — a paired e-scoresheet credential can still write to *any* piste's
  `scoresheet/*` topics, not just the one it's actually watching. True per-piste
  scoping (e.g. `%u`/`%c` substitution binding a credential to one specific piste)
  is still not implemented — confirmed directly against the sync script, not assumed.
  Mosquitto's `read`/`write` ACL rules are independent per topic pattern, so "read
  stays open, write gets scoped per-piste" would still be directly supportable on the
  same listener if this is ever prioritized — see `docs/e-scoresheet-standalone-design.md`
  §4.8 for the full writeup. Not decided whether/when to build it.

**Piste transfer** (moving an ongoing match, or an entire pipeline, to a different piste
mid-competition — apparatus failure, scheduling) is raised 2026-07-09, explicitly
CMS-executed (only the CMS has pipeline structure and an already-mirrored snapshot of
live score/UW2F state). Moving a whole pipeline is mostly free (unstarted slots are pure
CMS bookkeeping); moving the *currently active* bout is new territory — the first case
requiring the executor itself (the physical apparatus instance) to change mid-bout. This
surfaced two concrete protocol gaps (see `docs/roles-and-responsibilities-discussion.md`
§5 and §7):

1. **DONE 2026-07-10 — software→apparatus seeding message for clock and UW2F.**
   `software/clock` and `software/uw2f` are now spec'd (`docs/level2.md` §11/§19),
   non-retained, QoS 1, symmetric to `software/score` — pushed upstream as
   [OpenPiste/protocols#9](https://github.com/OpenPiste/protocols/pull/9) (**merged
   2026-07-14**). Atlas-side: `lib/opp2Composer.js`'s two duplicated `isFresh` blocks
   (in `sendMatchData`/`_sendRelayData`) were extracted into a shared
   `sendFreshClockAndUw2f()` that publishes both through the standard envelope helper —
   `software/clock` previously wrote an undocumented, off-spec QoS-0 `rawPublish`
   mirroring `apparatus/clock`'s own QoS instead of the spec's QoS-1 requirement for the
   software side. `software/uw2f` needed no code change; it already published through
   the standard helper and was already spec-conformant, just undocumented.

   Cross-checked against the real `esp32scoringdeviceMqtt` firmware
   (`opp2-library`'s `Dispatcher.onClock`/`onUW2F`, wired in `Opp2Handler.cpp` — the
   library's initial commit is 2026-05-20 and the handler wiring hasn't been touched
   since 2026-07-01, both predating this whole discussion) — found the receiving side
   already implemented and correctly gated: `updateClockExternal` refuses an incoming
   `software/clock` unless the apparatus's *own* clock is currently stopped, exactly the
   invariant this design assumes. That check surfaced a real gap, though: it applies the
   incoming message's `running` field verbatim rather than forcing it false, so a
   `"running": true"` `software/clock` payload would start the apparatus's clock from a
   network command alone, bypassing the physical interlock. Spec tightened same-day to a
   hard MUST/MUST NOT on this (`software/clock`'s `running` MUST be `false`; an
   apparatus receiving `true` MUST NOT start its clock from it), same PR #9. **Low-
   priority TODO, not yet actioned:** `esp32scoringdeviceMqtt`'s `updateClockExternal`
   (`Opp2Handler.cpp:2062`) doesn't yet enforce this — it would currently honor a stray
   `running: true`. Nothing in Atlas exploits this today (`sendFreshClockAndUw2f`
   always sends `running: false`), so it isn't blocking anything; flagged for whenever
   the firmware repo is next touched, not scheduled.

2. **Still open:** no `control` value meaning "relinquish this bout, no result" — every
   existing value (BEGIN/NEXT/PREV/END) assumes normal completion. Also still open:
   Atlas doesn't mirror the clock into `pisteState` at all (`lib/opp2Client.js` tracks
   `lastScore`/`lastUw2f`, no `apparatus/clock` handler). Both block the actual
   mid-bout piste-transfer feature — 2026-07-10 only closed the messaging-format
   prerequisite (item 1), not the feature itself.

### e-Scoresheet network-drop resilience fixes — complete, 2026-07-16

Investigated "how resilient is the already-shipped e-scoresheet to network drops?"
by reading the actual connection code, not from memory. Found brief blips were
already handled reasonably well (`reconnectPeriod: 2000`, full resubscribe on every
reconnect, retained topics mean a reconnect gets current state immediately, `qos: 1`
card-reason publishes queue in `mqtt.js` while disconnected and flush on reconnect,
service worker keeps the app shell rendering through a drop) — but found and fixed
three real, independent bugs in `escoresheet/js/app.js`:

1. **Conflated status badge.** `#conn-badge` ("apparatus online/offline") was driven
   by *both* the retained `apparatus/connection` message *and* this e-scoresheet's
   own MQTT `error`/`close` events — same badge, same text either way. A referee
   couldn't tell "the scoring box disconnected" from "my phone lost WiFi." Fixed by
   adding a second, independent `#broker-badge` (new `renderBrokerStatus()`) driven
   only by this device's own connection lifecycle (`connect`/`reconnect`/`close`/
   `offline`) — `renderConnection()` (the apparatus badge) is now only ever called
   from the `apparatus/connection` message handler.
2. **Retained delivery can collapse more than one event into a single diff.**
   `detectCards()` compares two consecutive `apparatus/score` payloads to infer new
   cards. Since `apparatus/score` is retained, a reconnect only ever delivers the
   *current* state — if e.g. two red cards were given while disconnected, the diff
   against the pre-drop snapshot would only fire one dialog, silently
   under-representing what happened. Fixed by resetting `lastScoreForCards`/
   `lastFencers`/`lastClock` to `null` on every reconnect (tracked via a new
   `hasConnectedOnce` flag, distinguishing "first connect for this piste" from
   "reconnected after a drop") — reuses the exact guard (`if (lastScoreForCards)`)
   already in place to skip detection on the very first message ever, for the same
   reason: silently resync rather than risk a false or incomplete trigger. Tradeoff,
   accepted deliberately: a card given entirely within a gap gets no annotation
   recorded (there's still no manual card-assignment path — see the paused
   legacy-mode discussion below) — safer than logging a wrong or partial one, and
   consistent with cards being audit/annotation data only, not the authoritative
   record.
3. **`navigator.onLine`-driven status is a weak signal on its own** — reflects
   whether the device's network interface is up, not whether the broker is actually
   reachable; can read "Online" while the WSS connection is failing outright. Not
   removed (still legitimate, lower-cost information) but no longer the only signal
   — the new `#broker-badge` from fix 1 is the authoritative "is live data actually
   flowing" indicator.

Service worker cache bumped to `v11` (app shell — `index.html`/`app.css`/`app.js` —
all changed). Verified via `node --check` and manual code-path review; confirmed the
update itself reaches a real device (`git pull` + close/reopen picked up `v11`
cleanly). **Not yet confirmed:** actually triggering a real network drop on that
device and watching the new broker/apparatus badge split and reconnect-safe card
detection behave as designed — still worth a real test.

### e-Scoresheet legacy/no-apparatus mode discussion — paused 2026-07-15

`docs/e-scoresheet-legacy-mode-discussion.md` — **non-normative, nothing implemented,
paused pending reconsideration.** Started from a concrete ask: when no scoring
apparatus is connected, the e-scoresheet should still be usable to increment/correct
scores, assign cards outright (not just record a reason — today's `CardReason.record()`
is *only* ever called from apparatus-driven card detection, no manual path exists
anywhere, not even in Atlas's own director UI), assign and log priority (currently not
persisted anywhere at all — it's a transient MQTT payload field, discarded after use),
and manually activate/end a match. Directly revives the three sub-problems already
flagged as open in `docs/e-scoresheet-standalone-design.md` §5 (offline bundle/
pre-round export, local §23.4 enforcement, stale-replay reconciliation).

Worked through several decision axes (auth = real Atlas login on-device; activation =
fallback-only-when-apparatus-absent; DE deferred, pools only; frozen per-piste
pipeline snapshot, not live reassignment; trust the referee, no local correct-ending
enforcement; reconnect conflicts flagged for a human, never auto-merged) — see the doc
for the full table. **Paused by a reframing the user raised partway through:** brief
network instability and a sustained loss of connection for an entire bout/pool are
qualitatively different problems, not one continuum. Brief instability is exactly
where OPP2 earns its keep (real-time, time-accurate data) and is worth engineering
resilience for. Sustained loss has *no* real-time data to protect — OPP2 has nothing
to offer there, and the honest answer is a much simpler offline paper-scoresheet
replacement synchronizing at just two points (start/end of pool or bout), same
approach already used by existing systems like FencingTime via their own REST API —
not a scaled-down OPP2 client. Whether this means splitting into two genuinely
separate modes (a live/connected mode for the new manual capabilities, riding on
OPP2/MQTT as today; a separate two-sync-point "digital paper scoresheet" mode for
real disconnection) — and whether the second mode even belongs in the e-scoresheet
PWA rather than being its own smaller tool — is exactly what's left open.

**Corrected 2026-07-16:** an earlier tentative note in the doc had proposed the
two-sync-point mode call Atlas's own REST API directly — wrong, and flagged by the
user as violating this project's own ecosystem-independence principle (see "OPP2
design principle" above): that would mean only an Atlas-specific e-scoresheet could
ever run in this mode, exactly the fragmentation OPP2 exists to prevent. **Even the
disconnected mode's two sync points must be standardized OPP2 messages**, so any PWA
or non-PWA e-scoresheet works against any compliant CMS, not just Atlas — a real spec
extension is likely needed, since no existing OPP2 message carries pipeline/pool-
structure data today. The connection doesn't need to be *continuous* to be OPP2 —
brief-connect/sync/disconnect at each of the two points is still protocol-pure; only
the live window in between has no OPP2 involvement. Read the doc directly before
resuming this thread.

### Tier A (certificate-based) device provisioning — complete, 2026-07-14/15

Implements `docs/level2.md` §30.5 for real: embedded/native components (the scoring
apparatus firmware, and by extension anything else that can't run in a browser) prove
themselves with a TLS client certificate instead of a Tier B username/password —
generated locally, private key never transmitted, exchanged for a signed cert over the
reserved `openpiste/_provision/request` / `openpiste/_provision/response/{device_id}`
topics. Built across **both** repos this project depends on: this one (the CMS/signing
authority) and `esp32scoringdeviceMqtt` (the real device — see
[[reference_scoring_device_firmware]]), and paired against **actual hardware**, not
just simulated — the first Atlas feature verified that way end-to-end.

**Atlas side:** migration `029_tier_a_provisioning.sql` (`tier_a_tickets`,
`tier_a_certificates`); `services/provisioning.js` — ticket issuance,
`signCertificate` (shells to `openssl x509 -req` against `data/tls/ca.{key,crt}`,
overriding the CSR's own subject with an Atlas-controlled `{role}-{deviceId}` CN so it
maps directly to a Mosquitto ACL identity), `revokeCertificate`
(CRL regen via a minimal bootstrapped OpenSSL CA database at `data/tls/ca-db/`),
`purgeRevokedCertificates` (operator-list cleanup only, never touches the CRL);
`lib/opp2Provisioning.js` — the MQTT-side handler, wired into `lib/opp2Client.js`
ahead of the normal piste-scoped message parsing (the `_provision/*` topics are a
reserved 3-segment shape the opp2-library-style parsing can't handle); new
`routes/pairing.js` endpoints and a "Pair a scoring device" ticket-issuing flow.
`scripts/sync-mosquitto-tier-a.sh` (new) handles the broker-listener half:
`require_certificate`/`use_identity_as_username`/`crlfile` on 8883, CRL pushing.

**Firmware side:** new `TierAProvisioning` singleton — mbedtls EC keypair + CSR
generation, NVS persistence (`"tier_a"` namespace), the MQTT exchange, and a new
`/provision` page on the existing calibration web server (the device has no camera to
scan a Tier B–style QR with, so the operator-relayed ticket code is typed in there).
Filled in `AtlasAsyncMqttClient`'s previously-unimplemented `setTlsCerts()` stub.

**Real bugs found only by pairing an actual device — this is the valuable part, not
just "it compiled":**
- **MQTT message fragmentation.** esp-mqtt delivers any message over its internal
  buffer (default 1024 bytes) across multiple `MQTT_EVENT_DATA` callbacks;
  `AtlasAsyncMqttClient::handleEvent` treated every fragment as a complete message.
  Invisible until now because every prior OPP2 message (score, clock, control) was
  small enough to arrive whole — Tier A's response (two PEM certificates) was the
  first payload big enough to fragment. Fixed with proper
  `current_data_offset`/`total_data_len` reassembly.
- **Broker ACL let the device publish its request but never let Atlas publish the
  response.** Atlas's own OPP2 client connects anonymously (by design); the ACL only
  ever granted the request-topic write to anonymous connections, so every exchange
  died silently on the response leg — no error either side, `SUBACK`/`PUBACK` both
  looked fine.
- **Crash on the first successful grant.** `esp_mqtt_client_stop()`/`_destroy()`
  (needed to switch the device onto mTLS) must never be called from inside the MQTT
  client's own event-handler task — doing so crashed the device with a FreeRTOS mutex
  assertion. Fixed by deferring the actual reconnect to
  `Opp2Handler::CheckConnection()` (the main loop task) via a staged
  "reconnect pending" flag rather than doing it synchronously in the response handler.
- **TLS handshake failed even with a valid, correctly-signed cert.** The device
  connects via a resolved IP; the broker's cert SAN only covers the mDNS hostname.
  Fixed with `skip_cert_common_name_check` (the certificate *chain* is still fully
  verified against Atlas's CA — only the hostname/CN match is skipped). Documented as
  a deliberate, revisitable tradeoff in the firmware repo's `TECHNICAL_NOTES.md`, not
  silently patched over.
- **Re-provisioning was permanently impossible after the first successful pairing.**
  Confirmed the hard way, with a real device: once authenticated (via its own
  certificate), a client no longer inherits *any* global/unscoped ACL rule on this
  Mosquitto version — only what's in its own per-user stanza. The provisioning-request
  grant had only ever been added globally (for first-time anonymous devices), so an
  already-provisioned device could never request a renewal. Root-fixed, not patched
  per-instance: every genuinely universal grant (`read #`, both `_provision/*` topics)
  now uses Mosquitto's `pattern` directive instead of `topic` — confirmed empirically
  (disposable broker, several angles) to reach *every* client regardless of auth
  state, closing this entire bug class rather than the one symptom.
- **Certificates accumulated instead of superseding.** Every re-pair left the previous
  certificate for the same device+role sitting around as a separate "active" row
  forever. `signCertificate` now auto-revokes any prior active certificate for the
  same device+role on each new issuance.
- **`openssl ca -gencrl` failed outright the first time that supersession logic ran.**
  OpenSSL enforces unique certificate subjects by default; Tier A deliberately reuses
  the same CN across re-provisioning (that's what makes "find and revoke the old one"
  possible). Fixed with the standard `index.txt.attr` → `unique_subject = no`
  override.
- **Device label never appeared in the certificate list.** The label typed at
  ticket-issue time was stored on the *ticket*; the certificate's own label came only
  from a `device_label` field in the device's MQTT request, which the firmware never
  actually sends. `signCertificate` now falls back to the ticket's label when the
  device doesn't send one.
- **Unbounded CRL/index.txt growth.** A revoked entry only needs to stay listed until
  its own original expiry passes — after that the TLS handshake already rejects it
  for being expired, CRL or not. New `pruneExpiredRevocations()`, wired into
  `scripts/sync-mosquitto-tier-a.sh` (the same script already re-run after every
  revocation, not a separate thing to remember).

**UI:** `public/pairing.html` rebuilt as two consistently-styled, collapsible sections
— "Device-locked credentials" (Tier A, expanded by default — the common case) and
"Username & password" (Tier B, collapsed) — replacing four mismatched cards, with
matching show/clear-revoked controls added to both. `public/admin.html`'s card
retitled "Device pairing" (was "Scoresheets" — no longer accurate once this covered
more than the e-scoresheet).

**Pairing vs. e-scoresheet installation fully separated, 2026-07-15 (later pass).**
An initial attempt at this UI baked e-scoresheet-specific QR/link generation directly
into the Tier B "assign a credential" flow — confusing (per user feedback: "everything
still smells escoresheet mixed with pairing"), and wrong in principle: Tier B is a
generic browser-credential mechanism, and a future Tier B device that isn't the
e-scoresheet (has a camera, is browser-based, but isn't a scoresheet) shouldn't be
steered through escoresheet-flavored UI at all. Fixed by fully separating the two into
independent steps:
- `pairing.html` is pure credential issuance again (Tier A tickets, Tier B
  username/password) — zero e-scoresheet awareness, identical UI for any device type.
- New `public/install-escoresheet.html` — picks an already-paired, active Tier B
  device from a dropdown and shows its e-scoresheet QR code plus a plain clickable
  link (`escoresheetPairingUrl`, for testing on the same machine or when there's no
  camera to scan with — a real gap in the first attempt, which only ever offered a QR
  image). This is now the *only* place any e-scoresheet-specific logic lives.
- `admin.html` gained a separate "Install e-scoresheet" card alongside "Device
  pairing", linking to the new page.
- `routes/pairing.js`: `/devices/:id/reveal` now also returns `escoresheetPairingUrl`
  as data (cheap to compute, harmless to include) but `pairing.html` never renders it
  — only `install-escoresheet.html` does. `/devices/:id/qr` renamed to the explicitly
  e-scoresheet-scoped `/devices/:id/escoresheet-qr`.

**Verified end-to-end against real hardware**, not just compiled: ticket issue → code
typed on the device's own `/provision` page → CSR generated and never leaves the
device → signed certificate received → persisted to NVS → clean mTLS reconnect on
8883 → re-provisioning without manual intervention → correct label and
single-active-row bookkeeping in `pairing.html`. `docs/implementation-notes/mosquitto-security.md`
updated to document the `pattern`-vs-`topic` finding for future implementers (not the
spec itself — this is Mosquitto-specific, deliberately out of `docs/level2.md`'s
scope per its own vendor-neutrality principle). Committed to both repos: Atlas
`1547f03`, `esp32scoringdeviceMqtt` `714250d`.

**Not done:** flashing/testing a *second* physical device (only one has been paired
so far); per-piste/per-instance scoping beyond role (tracked, longstanding, not
specific to Tier A); OCSP (CRL was always the intended mechanism, per spec).

**CMS self-authentication — complete, 2026-07-15.** A real gap surfaced once Tier A
was working against real hardware: Atlas's own OPP2 client (`lib/opp2Transport.js`)
still connected to the broker anonymously, relying on a backward-compat, anonymous-only
`topic write openpiste/+/software/#` ACL grant to publish at all. Since Tier B/Tier A
had already scoped `scoresheet`/`apparatus`/etc to their own authenticated identities,
`software` was the one role left wide open — any other anonymous client on the network
could spoof `software/*` messages the apparatus is spec-required to trust
unconditionally (e.g. `software/clock`'s `running:false` invariant). Fixed by giving the
CMS its own Tier A client certificate, CN `software-cms`:
- `services/provisioning.js`'s `signCertificate` was refactored into two shared
  helpers (`_signCsr`, `_recordAndSupersede`) plus a new `issueCmsCertificate()` —
  unlike every other Tier A device, the CMS doesn't need the ticket/MQTT
  request-response exchange at all, since it already holds the CA's own private key
  locally; keypair, CSR, and signing happen in one local `openssl` step. Writes
  `data/tls/software-client.{key,crt}` and records the cert in `tier_a_certificates`
  (role `software`, device_id `cms`) for the same CRL/revocation/pruning machinery
  every other Tier A cert gets.
- Migration `030_cms_self_certificate.sql` — `tier_a_certificates.role`'s CHECK
  constraint gained `'software'` (table rebuild, SQLite has no ALTER for CHECK
  constraints). Deliberately did **not** touch `tier_a_tickets.role`'s CHECK, which
  still excludes `'software'` — that's the real invariant (no operator-issued ticket
  can ever grant an external device the software role); the CMS's self-issuance
  bypasses the ticket flow entirely, so only the certificate *record* needed the
  schema change.
- `lib/opp2Transport.js`'s `connect()` now checks for
  `data/tls/software-client.{key,crt}` + `ca.crt`; if present, upgrades to
  `mqtts://host:8883` with the client cert. If absent, behaves exactly as before
  (anonymous) — fully additive/opt-in, can't break an install that hasn't issued the
  cert yet.
- New `scripts/provision-cms-client-cert.sh` — issues the cert and prints the
  sequenced next steps (restart Atlas, re-run `sync-mosquitto-scoresheet-acl.sh`,
  re-run `sync-mosquitto-tier-a.sh` if 8883 doesn't already require a client cert).
  The sequencing matters: `sync-mosquitto-scoresheet-acl.sh` already read
  `tier_a_certificates` generically (no script change needed to pick up
  `software-cms`), but if Atlas reconnects via mTLS *before* that script re-runs, it
  authenticates successfully yet has no ACL stanza yet — same "an authenticated
  client inherits nothing from an old anonymous grant" lesson as everywhere else in
  Tier A/B, this time biting Atlas's own connection instead of a device's.
- Once the certificate was confirmed working live (server log showed `(mTLS, cert CN
  software-cms)`, existing piste state kept publishing normally), the anonymous
  `topic write openpiste/+/software/#` line was removed from
  `sync-mosquitto-scoresheet-acl.sh`'s generated ACL — closing the spoofing gap for
  real, not just adding a redundant authenticated path alongside the open one.
  `apparatus`/`remote`/`var` deliberately keep their anonymous fallback (Tier A is
  still optional for those roles; `software` is different because only Atlas itself
  ever legitimately publishes it).
- `install.sh` updated to issue the CMS certificate at install time (same
  skip-if-already-provisioned pattern as the Tier B credential pool) and to print a
  reminder that `sync-mosquitto-tier-a.sh` (listener 8883's
  `require_certificate`/`use_identity_as_username`/`crlfile`) is a separate, more
  invasive step (full broker restart, not a reload) left manual rather than run
  automatically on every install.

**Verified against the real, already-live deployment** (not simulated): cert issued,
chain-verified against `data/tls/ca.crt`, key/cert match confirmed; ACL regenerated and
pushed with the operator's own broker (`sudo grep` confirmed `software` absent from the
anonymous block and present under a `user software-cms` stanza); Atlas reconnected over
mTLS with no disruption to already-live piste state.

### Mid-competition failover bundle — complete, 2026-07-15
A pre-provisioned standby server (Atlas + Node + Mosquitto already installed, just
idle — a live failover has no time for `install.sh` from scratch) can take over from a
failed primary without every device needing to re-pair. Two scripts:
- `scripts/create-failover-bundle.sh` — bundles a live, consistent `data/atlas.db`
  snapshot (`sqlite3 .backup`, safe without stopping the server) and the *entire*
  `data/tls/` directory (CA + every issued certificate, including `ca-db/` so serial
  numbers and revocation history survive too) into a `7z` archive with **AES-256
  encryption and encrypted filenames** — deliberately not `zip -e`'s legacy
  ZipCrypto, since the archive contains the CA private key. Deliberately does *not*
  bundle Mosquitto's own `acl.conf`/`passwd`/`mosquitto.conf` — those are fully
  regenerable from the two bundled things via scripts this project already has, so
  regenerating on restore avoids a second, independently-drifting snapshot.
- `scripts/restore-failover-bundle.sh` — extracts, shows the bundle's manifest
  (created-at/source host/git commit) so the operator can confirm it's the right
  one, asks for explicit confirmation, backs up the standby's *own* current
  `data/atlas.db`/`data/tls/` first (reversible), installs the restored files, then
  re-runs `install-broker-cert.sh` + `sync-mosquitto-scoresheet-acl.sh` +
  `sync-mosquitto-tier-a.sh` if Mosquitto is co-located, and restarts Atlas.
- `p7zip-full` added to `install.sh`'s package list. Verified: the `sqlite3 .backup`
  snapshot (integrity check passes, tables match the live DB) and the `data/tls/`
  copy logic tested against the real repo.
- **Full encrypted round trip verified for real, 2026-07-15** (same day, later
  pass) — the gap above is closed. `p7zip-full` installed, bundle created from this
  dev checkout's real pairing data (an active apparatus Tier A cert plus the Tier B
  e-scoresheet credential pool), `scp`'d to the real standby (`atlas@openpiste.local`),
  and restored there with `restore-failover-bundle.sh`: manifest matched the source
  host/commit, Mosquitto ACL/CRL/listener-8883 resync and Atlas restart both completed
  cleanly, and the previously-paired device showed as paired again with no re-pairing
  needed. One real, non-obvious wrinkle found: an already-open browser session on the
  standby didn't reflect the restored state until a fresh login — restoring
  `atlas.db` mid-session replaces the `users`/session tables out from under the
  existing session cookie, so a relogin (not a bug, not a re-pair) is needed to see
  the restored data. Worth calling out to whoever runs a real failover so it isn't
  mistaken for the restore having failed.
- **Two more real bugs found finishing that same test, both fixed same day.**
  - The e-scoresheet PWA still couldn't see its piste as online after the restore even
    though the CMS could. Root cause: `install-broker-cert.sh` only *creates* a TLS
    listener stanza if one doesn't already exist at all — it never normalizes an
    *already-existing* one's `cafile`/`certfile`/`keyfile` paths. Listener `8883` had
    always been Atlas-only so this never mattered; listener `9002` (wss) on the real
    standby predated Atlas (inherited from `mqtt-web`'s original setup) and pointed at
    `/etc/mosquitto/certs-web/server.cert`, not `/etc/mosquitto/certs/server.crt` —
    so the script kept installing fresh cert bytes at a path nothing read from, `9002`
    kept serving a year-old unrelated self-signed cert, and the e-scoresheet's own TLS
    chain validation correctly refused to trust it (the CMS, on the correctly-configured
    `8883`, had no such problem — which is what made "CMS sees it online, e-scoresheet
    doesn't" so confusing at first). Fixed: `install-broker-cert.sh` now rewrites just
    the three cert-path directives inside an existing listener's own stanza, leaving
    every other directive (`protocol`, `allow_anonymous`, `require_certificate`, …)
    untouched. Caught a `set -e` footgun while testing the fix itself:
    `[[ -z "$file" ]] && return 0` aborts the *whole script* when the condition is
    false (the bare `&&`'s left side exits non-zero as a statement) — switched to an
    explicit `if`. Also used portable `awk` throughout (no GNU-only `\y`), since
    Raspberry Pi OS ships `mawk`, not `gawk`, as the default `awk`.
  - Separately, `git pull`/`update.sh` failed on the standby with "insufficient
    permission for adding an object to repository database .git/objects" — unrelated
    to the failover bundle itself, but found in the course of pulling these very
    fixes. Root cause: the box's original clone had been done as root, leaving a large
    fraction of `.git/objects`/`.git/refs/tags` root-owned while newer objects were
    `atlas`-owned; whether any given `git pull` hits this is a coin flip (only fails
    if a new object's hash lands in an existing root-owned bucket directory). Gone
    unnoticed until now partly because the *old* `update.sh` ran `git pull` unwrapped,
    so under `sudo bash update.sh` it always ran as root — masking the problem (and
    likely growing it, since root-run pulls create their new objects as root too).
    Same root-cause shape as the `node_modules` ownership bug found earlier the same
    day (`install.sh`'s initial `npm ci` also ran as root instead of `APP_USER`).
    `sudo bash update.sh` now self-heals both `node_modules` and `.git` ownership
    before touching them.

### Hostname provisioning — complete, 2026-07-15
`install.sh` never actually set the hostname to `openpiste` anywhere — that had been
done by hand on the reference deployment, with avahi's default `<hostname>.local`
advertisement doing the rest; there was no script at all, contrary to what a stale
assumption held. Built properly instead of just documented:
- `scripts/set-hostname.sh` — asks first, backs up the original hostname to
  `data/hostname.backup` (never overwritten by a later run — that file is the ONE
  true original), then `hostnamectl set-hostname openpiste` + updates `/etc/hosts`'s
  `127.0.1.1` line. Idempotent (no-ops if already `openpiste`). Callable standalone
  or from `install.sh` (skipped there if not an interactive terminal, e.g. piped
  installs — `avahi-daemon` also added to `install.sh`'s package list, since mDNS
  advertisement depends on it).
- `scripts/restore-hostname.sh` — restores from that backup (and deletes it once
  restored); if no backup exists, asks interactively what hostname to set instead
  rather than failing.
- Verified logic end-to-end in an isolated sandbox (fake `hostname`/`hostnamectl`/
  `sudo`) covering all branches: fresh set, idempotent re-run (doesn't clobber the
  backup), decline, empty-answer-defaults-to-no, already-`openpiste`, restore with
  backup present, restore with no backup. Never touched the real dev machine's
  hostname while building this.

### Clean-install broker/NTP provisioning — complete, 2026-07-15
Auditing "will a truly clean Pi get everything `install.sh` needs?" (prompted by a
direct question, not assumed) surfaced a real gap: **Mosquitto itself was never
installed by anything in this repo**, and no script created its listener config
(1883/8883/9001/9002) from scratch — every broker-touching script only ever
`command -v mosquitto`-checked and silently skipped if absent. Worse, confirmed by
reading it: `sync-mosquitto-tier-a.sh`'s listener-8883 editor specifically searches
for an *already-existing* `listener 8883` block to edit — on a stock Mosquitto
install (only the default port 1883, no extra listeners), it would silently do
nothing at all, no error. The whole 4-listener layout had always been set up by hand
on the reference deployment (traces back to the sibling `mqtt-web` project).
- `scripts/provision-broker.sh` (new, called interactively from `install.sh`,
  same skip-if-not-interactive handling as the hostname step) — installs Mosquitto
  if missing and creates the two listeners that never depend on TLS material (`1883`
  plain MQTT, `9001` plain WebSockets) if they don't already exist anywhere in
  `mosquitto.conf` or `/etc/mosquitto/conf.d/*.conf` (won't duplicate or fight a
  hand-customized broker — confirmed harmless against the real, already-configured
  reference deployment, since its listeners already exist and the check just skips).
  Backs up `mosquitto.conf` first, same convention as `sync-mosquitto-tier-a.sh`.
  Also installs and configures **chrony as a local NTP server**, per
  `docs/level2.md` §4.3 ("The broker host SHOULD also run a local NTP server...
  chrony is recommended") — bundled into the same script rather than a separate one
  because devices reach the NTP server at the same address as the broker, so it only
  makes sense on whichever machine actually runs Mosquitto. Keeps the distro's
  default upstream `pool`/`server` lines (real internet time when available) and
  only adds `allow` for the three common private-network ranges plus
  `local stratum 10`, so it still serves time to local clients with zero working
  upstream source — the actual "self-contained competition network" requirement.
- `scripts/install-broker-cert.sh` extended to also create the `8883`/`9002` TLS
  listener stanzas if they don't exist yet (`require_certificate false` — still
  `sync-mosquitto-tier-a.sh`'s job to flip that to `true` once a real Tier A cert
  exists), right before installing the cert files — deferred out of
  `provision-broker.sh` specifically because these listeners need real certs to
  reference, which don't exist yet on a clean box.
- `openssl`/`curl`/`lsof` added to `install.sh`'s package list — all three were
  already shelled out to by existing scripts (`generate-tls-cert.sh`,
  `provisioning.js`, the NodeSource fallback, the port-in-use check) but never
  explicitly installed; likely present already on most Debian-based images but not
  guaranteed, especially `lsof` on a minimal image.
- **Verified against a real disposable Mosquitto instance** (this dev machine
  already has mosquitto 2.0.18 installed) — extracted the exact content both
  scripts generate (not a hand-typed approximation) and confirmed it starts cleanly
  with all four listeners open, anonymous plain MQTT pub/sub works, and anonymous
  TLS (`require_certificate false`, no client cert offered) works. Sandbox testing
  hit two artifacts worth remembering if reused: `sudo install -o root -g root`
  genuinely returns exit 1 when not truly root (file still gets copied; only the
  chown fails) — irrelevant in real deployment since these scripts always run under
  real `sudo`/root; and `set -e` does **not** reliably abort on a failing pipeline
  in this environment even as the pipeline's last command, confirmed empirically
  (`true | false` does not trigger `-e`) — a real bash quirk, not specific to these
  scripts, but worth knowing before trusting `set -e` alone to catch a pipeline
  failure elsewhere.
- Time sync itself (not just chrony's presence) was *not* found to be a gap —
  Debian/Raspberry Pi OS ships `systemd-timesyncd` active by default, which is what
  actually matters for TLS handshakes; worth a one-time `timedatectl status` check
  on a truly offline-at-first-boot Pi, not an `install.sh` package addition.

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
- `video_review`'s `official` field is spec-documented (upstream, see the mirror rule
  above) but unimplemented — no Atlas code publishes `var/video_review` at all yet;
  there's no video-review tool built (Atlas only *subscribes*/handles an incoming one)

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
- ~~Fencer handedness (`hand`: R/L)~~ — **stale line, corrected 2026-07-08**: the data
  field already existed (`fencers.handedness`/`competitors.handedness`, CSV + FIE XML
  import, people/fencers UI — all predate this note). What was actually missing —
  strip-side placement — is now built; see "Handedness-aware strip-side placement" below.

### 2. Scoresheets
- Pool scoresheet grid (fencer vs fencer diagonal matrix) requires each fencer's **slot position in the pool** (Engarde: `NoDansLaPoule` 1–N). Currently derivable from seeding order but not stored. If a fencer is manually moved the grid breaks. Add `pool_slot` to the pool-fencer join table via migration.
- Cards are annotation/audit data only — Engarde does not include them in the results XML export. Keep card records separate from the authoritative bout result.
- Per-bout scheduled time: Engarde assigns `Heure` per individual DE bout (across strips). Atlas schedules at slot (round) level. Deriving per-bout times from slot data is sufficient for now.

### 3. Architecture / code hygiene
- `bout_duration_standards` adaptive tracking is built but unvalidated — needs a real or
  simulated competition run over live MQTT to confirm the observed-average path behaves
  (see OPP2 section above)
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
| `db/migrations/` | Numbered schema migrations (001–030) |
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
