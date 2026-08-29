# Schedule planner — how the solver works

This describes the algorithm behind the tournament schedule planner (`schedule-planner.html`,
`services/schedulePlans.js`, `services/schedulePlanSolver.js`, `services/schedulePlanEstimate.js`,
`services/schedulePlanReferees.js`). It's a **Phase 1 estimation tool**: it projects a rough
day plan from estimated headcounts, before any real phase, pool, or bout exists, and before
real fencers are even registered. It never writes to the live scheduling tables
(`phases`/`pools`/`pipeline_slots`) — its own tables (`schedule_plans`,
`schedule_plan_stages`, `schedule_plan_slots`, and the override/reservation tables below) are
entirely separate. Nothing here is a claim of optimal scheduling; it produces a reasonable
starting layout that a director then adjusts by hand.

It models **one evolving plan, re-solved as inputs change** — there's no "commit" step.
Re-running the solve always re-derives every slot from the stages' current inputs, wholesale
replacing whatever was there before (including any manual hand-edit a director made to the
previous solve's output).

## The pipeline, end to end

1. **Estimate the shape of each stage** (`schedulePlanEstimate.js`) — given an estimated
   headcount N, project pool sizes / DE tableau size, bout counts, and total bout-minutes,
   reusing the exact same math the live system uses for real competitors.
2. **Build solver units** (`schedulePlans.js`'s `_buildSolverInput`) — turn each
   `schedule_plan_stages` row into one or more opaque work units the solver can place in time.
3. **Solve** (`schedulePlanSolver.js`'s `simulate()`) — a greedy list-scheduling pass that
   assigns each unit a start time and a set of pistes.
4. **Layer on referee analysis** (`schedulePlanReferees.js`) — a separate, non-blocking check
   of whether the registered+assumed referee roster can actually staff the solved pool
   windows.
5. **Persist** — `resolve()` writes the result to `schedule_plan_slots` and a `computed_json`
   blob per stage (metrics, warnings, notices), all replaced wholesale on every re-solve.

## Step 1 — projecting a stage's shape from an estimated N

`computeStageMetrics(stage, competition)` branches on phase type:

- **Pool**: `calcPoolOptions` picks the same recommended pool-size split the live pool-creation
  UI would (first uniform split, else the first option), and bout count is the sum of
  `n·(n-1)/2` across pools.
- **DE**: `getTableauSize(N)` picks the tableau (smallest power of 2 ≥ N), then
  `deRoundBoutCounts` walks it down — a T32 tableau is `[16, 8, 4, 2, 1]` bouts round by
  round, round of 32 down to the final. A third-place bout (if the rule enables one) is folded
  into the final's own round rather than added as a separate one.

Both multiply bout count by `minutesPerBout`, looked up from `bout_duration_standards` per
weapon/gender/phase (falling back to a flat 5 min/bout if unconfigured). `N < 2` short-circuits
to a zero-work "insufficient data" stage rather than crashing on `getTableauSize`.

A DE stage that depends on a pool stage doesn't just reuse the pool's raw entrant count — it
projects through the pool's own advancement percentage first (`projectAdvancement`, the same
formula `services/formats.js` uses for its own feasibility checks), so a 70%-cut pool of 66
correctly projects a T32-ish DE bracket, not one sized for all 66.

## Step 2 — building solver units

A pool stage becomes exactly **one** unit. A DE stage explodes into **one unit per tableau
round**, chained sequentially (`8:r0 → 8:r1 → 8:r2 → ...`) — round *i+1* depends on round *i*
finishing. Every unit carries:

- `workMinutes` — total bout-minutes of work (not a fixed duration — see Step 3).
- `pistesAssigned` / `maxPistesAssigned` — a **range**, not a fixed number (see "Piste count:
  a range, not a target" below).
- `restMinutes` — minimum gap enforced after its dependency finishes (see "Fencer-safety rest
  buffer" below).
- `fixedStart` — an optional hard floor on this unit's own start time.
- `competitionId`, `tableauSize` (DE only) — used for piste eligibility.

### Max-flights: deriving piste counts instead of fixing them

"Never use more pistes than needed to stay within N flights (waves)" — a director thinks in
flights, not raw piste counts. When a plan-wide default (`default_max_flights_pool`/`_de`) or
per-stage override (`schedule_plan_stages.max_flights`) is set, the piste **floor** for a unit
is derived: `ceil(poolCount / maxFlights)` for a pool, `ceil(boutsInRound / maxFlights)` per DE
round. Falls back fully to the director's own fixed `pistes_assigned` when neither is set.

## Step 3 — the greedy solve

`simulate()` processes units off a ready queue: a unit becomes ready once every unit it
`dependsOn` has been placed, ties broken by the stage's own `order` (roughly, competition
entry order). For each unit, in order:

### Eligibility

A piste is eligible for a unit when (`isEligible`):

- **Pool unit**: the piste's `pools_allowed` flag is set.
- **DE unit**: `de_allowed` is set, and the round's tableau size falls within
  `[min_de_tableau, max_de_tableau]` (either bound `null` = unrestricted on that side).
  **Tableau size counts down as the competition progresses** (T64 happens before T2), so
  `max_de_tableau` — the *largest* tableau a piste may host — is really "usable **from** this
  round onward"; `min_de_tableau` — the *smallest* it may host — is "usable **until** this
  round." `strips.html` labels them that way for exactly this reason.
- **Competition reservation** (DE only, `schedule_plan_piste_reservations`): a piste can be
  reserved to one competition once a round's tableau shrinks to a threshold or below — e.g.
  splitting 8 colored/video pistes 4-and-4 between two competitions once both reach T8, so
  neither starves the other on the run-in to the semis. Above the threshold the reservation
  hasn't kicked in yet (piste is fully shared); at or below it, only the reserved
  competition's own units may use it.

If nothing is eligible at all, the solver throws rather than silently producing a broken plan.

### Timing floor

```
naturalStart = max(
  competition's own start override (or the plan's day_start),
  every dependency's finish time + this unit's restMinutes
)
earliestStart = fixedStart != null ? max(naturalStart, fixedStart) : naturalStart
```

A `fixedStart` only ever pushes a unit *later* — it never pulls it earlier than its natural
dependency timing allows. When natural timing is already past a requested fixed start, the
request simply couldn't be honored; `resolve()` compares the solved `naturalStart` against the
requested time to tell that apart from a unit that's merely idle *before* a legitimately later
fixed start (e.g. the final running in a different venue) — the former is a warning, the
latter an informational note.

### Piste count: a range, not a target

This is the part that changed most recently (2026-08-28). Each unit's piste count is a
**range** — `pistesAssigned` (floor) to `maxPistesAssigned` (ceiling, "no benefit beyond
this" — one-flight-worth: `boutsInRound` for a DE round, `poolCount` for a pool). Earlier, the
solver always used exactly the flights-floor, even when far more pistes sat completely idle —
correctly avoiding waste, but also needlessly running a round longer than it had to when
nothing else needed the extra capacity.

`findBestSlot` now searches this range: at each candidate start time (generated from existing
piste reservations' end times — availability only changes at those points), it tries piste
counts from the ceiling down to the floor. Since `duration = ceil(workMinutes / k)` is
non-increasing in `k`, a larger `k` at a fixed start is never worse — it needs a *shorter*
window, which is only ever as-hard-or-easier to fit into existing gaps. The search keeps the
overall best (earliest-finishing) `(start, k)` pair across all candidate starts, since an
earlier start with fewer pistes can genuinely lose to a later start that lands enough extra
pistes to finish sooner.

In **fixed mode** (a director-set `pistes_assigned`, no flights cap), the floor and ceiling are
equal, so this degenerates to exactly the old fixed-`K` behavior.

### Piste selection within a chosen k

Among the pistes free for the chosen window, ties are broken by:

1. **Narrowest eligibility first** (`pisteBreadth`) — a piste with no restrictions at all can
   serve any DE round of any competition; a piste restricted to a narrow tableau-size band can
   only ever serve a few. Consuming the narrow one first, even when both are idle and
   eligible, protects the broad one for whichever later, more specialized unit turns out to
   have no other option. (Found from a real case: an unrestricted Sabre T64 round grabbing a
   colored/video piste just because it was idle longest, needlessly delaying a Foil T32 round
   that could *only* use that piste.)
2. **Idle longest** (last interval end time, ascending) — spreads load across identical
   unrestricted pistes instead of always picking the same one.

### Real busy intervals, not a single "next free" scalar

Each piste tracks a real list of `[start, end)` intervals, not one "next free" timestamp.
Queue order (topological + `order` tie-break) isn't chronological order — a unit processed
later in the queue can have an earlier real start time than one processed before it. A single
scalar can't represent "this piste is free right now, even though it's *also* going to be busy
again starting two hours from now for an unrelated later-processed unit" — it would either
block the piste needlessly or double-book it. The interval list lets `findBestSlot` find any
real gap, not just "after everything reserved so far."

## Fencer-safety: the DE rest buffer

No fencer should start a bout again within a configurable number of minutes (`de_rest_minutes`,
plan-wide, default 20) of finishing their previous one. This needs no fencer identity — DE
bracket routing is fully deterministic from tableau size alone, so the worst case is
structural, not data-dependent.

Both a round and the one after it process bouts in tableau-position order via contiguous
per-piste chunks (mirroring how real bout-to-piste assignment already works elsewhere in this
codebase — FIE o.87.1/o.93.2's "one quarter of the table per piste"). Every piste-chunk
boundary in a round lands at that round's own true finish time — so the next round's tightest
bout is only fed by one of those late-finishing bouts (zero natural gap) when the previous
round doesn't have dramatically more flights than the next one. When it does, the earliest
chunk boundary already falls past the next round's own first flight, leaving real natural
slack.

```
minGap    = max(0, ceil(ceil(flights_prev / 2) / flights_next) − 1) × minutesPerBout
restAdded = max(0, configuredRestMinutes − minGap)
```

Only the *shortfall* below the configured minimum gets added — not the configured amount
unconditionally. `flights_prev`/`flights_next` are derived from the **referee-capped** floor
(see below), not the uncapped flights target, since if referees genuinely limit a round to
fewer pistes than flights math wanted, more flights are really needed and the safety
calculation should reflect that reality.

Scoped to DE round-to-round transitions only — not pools, not the pool→DE handoff (those can
still get a buffer, but only if a director explicitly sets one — see next section).

## Director-set overrides

`schedule_plan_round_overrides`, keyed by `(stage, tableau_size)` — `0` is the sentinel for a
pool stage's own single unit, a real tableau size (T4, T8, ...) selects one DE round:

- **`fixed_start`** — see "Timing floor" above.
- **`buffer_after_minutes`** — an explicit buffer required after this specific round/phase
  finishes, before whatever depends on it may start (room changes, results verification,
  ceremony setup — general-purpose, not fencer-rest-specific, and applicable to *any* phase
  transition, not just DE-to-DE). Combines with the automatic DE rest-buffer by taking
  whichever is longer, never shorter — a director's own number can only add safety margin, not
  remove it.

`schedule_plan_piste_reservations`, keyed by `(strip, competition, from_tableau_size)` — see
"Competition reservation" above.

## The referee-driven piste cap

Once opportunistic widening lets a round grab every free/eligible piste, the real limit stops
being pistes and becomes qualified referees. `default_max_pistes_de` (plan-wide) and
`schedule_plan_stages.max_pistes` (per-stage override) put a hard ceiling on simultaneous DE
piste usage, regardless of how many are physically free. Applied in *both* flights and fixed
mode — referees are a physical constraint either way — clamping both the floor and the
ceiling. The flights-warning mechanism keeps a separate, uncapped `targetPistesAssigned` purely
so a referee-cap-caused shortfall is still reported accurately ("wanted 8, got 6") even though
the solver itself never asked the piste-availability search for more than the capped amount.

## Warnings and notices (`resolve()`, per stage, in `computed_json`)

- **`flightsWarnings`** — a unit got fewer pistes than its true flights target wanted (piste
  eligibility, or the referee cap, or both).
- **`fixedStartNotices`** — `severity: 'warning'` when a fixed start couldn't be honored
  (shows requested vs. actual, and by how much); `severity: 'info'` when a unit is simply idle
  before a legitimately later fixed start.
- **`referees`** (from `schedulePlanReferees.js`) — pool-stage-only, non-blocking: simulated
  pools (built from real registered-but-not-checked-in competitors) run through the same
  bipartite-matching referee assignment the live pool-referee auto-assigner uses
  (`poolRefereeAssignment.js`'s `solveAssignment`), padded with abstract placeholder referees.
  Overlapping pool stages' solved windows are clustered and solved together, mirroring the live
  assigner's "combined phases" mode. A referee shortage is flagged as risk (FIE t.50
  neutrality is "if possible," not a hard rule), never fed back into the piste solver.

## Known limitations

- **Not a claim of optimality.** This is a standard greedy list-scheduling heuristic. It gives
  a reasonable starting layout; a director adjusts individual `schedule_plan_slots` by hand
  afterward, and any manual edit lasts until the plan is next re-solved.
- **A stage/round is one opaque block**, never reasoned about at the individual-bout level —
  that finer-grained placement is what the real pipeline (`services/pipelineSlots.js`) already
  solves once real pools/bouts exist.
- **DE bout-count projection assumes straight single-elimination.** Repechage/all-places-fenced
  rule docs need a richer round structure for full accuracy — this affects estimate precision
  only, not the tool's overall shape.
- **Single continuous time axis, no day boundary.** A schedule running past 24h shows an
  elapsed "HH:MM" past 24:00 rather than wrapping to a wrong clock time or splitting across
  calendar days — fine for a single-day estimate.
- **No lookahead.** The greedy solve processes units in queue order and never revisits an
  earlier decision once made, so it can't foresee that a still-shared piste will soon become
  scarce for someone else. The narrowest-eligibility-first tie-break (see above) mitigates the
  worst of this without requiring full backtracking search.

## Key files

| Path | Purpose |
|---|---|
| `services/schedulePlanEstimate.js` | Pure per-stage math: pool/DE projections from an estimated N |
| `services/schedulePlanSolver.js` | The greedy solver itself — `simulate()`, `findBestSlot()`, `isEligible()` |
| `services/schedulePlans.js` | Orchestrator — `_buildSolverInput()`, `resolve()`, plan/stage/override CRUD |
| `services/schedulePlanReferees.js` | Non-blocking referee-shortfall analysis, layered on top |
| `public/schedule-planner.html` | The UI |
| `public/js/schedule-planner-*.js` | Alpine mixins: core/gantt/solve/referees |
