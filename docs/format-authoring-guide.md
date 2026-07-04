# Authoring competition formats — complete guide

This is the single reference for creating a competition format in Atlas, from the
smallest building block (a pool rule file) up to something a director picks by name in
the competition detail page. If you only read one document to build a new dedicated
format, this is it — everything below used to be split across `rules/RULES.md`,
`rules/RULES-DE.md`, and scattered `CLAUDE.md`/`docs/format-system-comparison.md` prose;
those two rule-file docs have been folded in here and removed so there's one place to
look, not three.

---

## 1. The three layers

A competition format is built from three kinds of file, each with a different job.
You don't always need all three — a one-phase pool-only or DE-only competition just
needs layer 1 — but any multi-stage format (pools then DE, exempt cohorts, parallel
divisions, repechage-to-a-tableau-size) needs all three.

```
rules/*.json (type: "pool" or "de")      formats/*.json                formats/catalog.json
─────────────────────────────────       ────────────────              ─────────────────────
How ONE phase behaves:                  How several phases            How a shape is
 - pool sizes, separation                CHAIN into a pipeline:        PRESENTED to the
 - advancement cutoff                     - stage order/dependencies    director:
 - seeding tiebreakers                    - who participates in each    - human label
 - DE touch target, repechage,             stage (cohorts, rank         - FIE article refs
   placement                               ranges, seeding)             - "why pick this one"
                                          - advancement between          text
                                            stages (exemptions,        - scope (fie/club)
                                            survivor targets)          - param defaults
                                                                       Many catalog entries
                                                                       can alias ONE shape.
```

- **Rule file** (`rules/*.json`) — describes a single phase in isolation. A pool rule
  doesn't know it might feed a DE afterward; a DE rule doesn't know if it's the whole
  competition or one stage of something bigger.
- **Format shape** (`formats/*.json`, not `catalog.json`) — describes the *pipeline*:
  which rule file each stage uses, what order stages run in (or whether some run in
  parallel), and how competitors flow from one stage into the next. A format shape's
  own `id`/`description` are rarely shown to a director directly (see catalog below).
- **Catalog entry** (one entry inside `formats/catalog.json`) — a named, presentable
  alias for a shape, with FIE article references and human-reviewed explanatory text.
  Multiple catalog entries can point at the same shape file — e.g. "World Championships",
  "World Cup", and "Grand Prix" are three catalog entries that all alias the one
  `grand-prix-fie` shape, because FIE's own rules describe all three as the same pipeline
  under o.83-88.

A competition's `format_id` (stored on the `competitions` row) is normally a catalog
entry id. `services/formats.js`'s `loadFormat()` tries the catalog first, and falls back
to treating the id as a raw shape filename if no catalog entry matches — this is also
what happens for a self-authored shape with no catalog entry at all: it still works, and
`listFormats()` surfaces it automatically as a `scope: "custom"` entry so it's still
selectable in the UI without ever touching `catalog.json`.

---

## 2. Quick-start: build a brand-new dedicated format end to end

Worked example — say your club wants: **one no-elimination pool round purely to rank
the field, then a split by pool result into an "Elite" division (top 12) that fences
with repechage, and a "Challenger" division (the rest) that fences a plain single
tableau** — two independent divisions that never play each other again after the pool
round.

### Step 1 — do the phases you need already exist as rule files?

You need: a pool rule with no elimination, a DE rule with repechage, and a plain DE
rule. Check `rules/`:
- `pool-standard.json` doesn't have `noElimination` baked in — that's set at the format
  layer (`advancement.noElimination`), not the rule file, so **no new pool rule file
  needed**.
- `rules/de-repechage-t32-t8.json` already exists (repechage T32→T8, bronze bout) — no
  new DE rule needed there either.
- `rules/de-standard.json` already exists for the Challenger division.

If none of the existing rule files fit (different touch target, different repechage
depth, different `allPlacesFenced` value), copy the closest one and adjust — see §3/§4
below for the full field reference. This example needs no new rule file at all.

### Step 2 — write the format shape

New file `formats/club-elite-challenger.json`:

```json
{
  "id": "club-elite-challenger",
  "description": "Pool Round then split by result into Elite (repechage) / Challenger (straight DE)",
  "stages": [
    {
      "id": "pools",
      "label": "Pool Round",
      "phaseType": "pool",
      "rule": "pool-standard.json",
      "participants": { "source": "initial" },
      "advancement": { "noElimination": true }
    },
    {
      "id": "elite",
      "label": "Elite Division (repechage)",
      "phaseType": "de",
      "rule": "de-repechage-t32-t8.json",
      "dependsOn": ["pools"],
      "participants": { "source": "rank_range", "basedOn": "last_pool", "from": 1, "to": 12 }
    },
    {
      "id": "challenger",
      "label": "Challenger Division",
      "phaseType": "de",
      "rule": "de-standard.json",
      "dependsOn": ["pools"],
      "participants": { "source": "rank_range", "basedOn": "last_pool", "from": 13, "to": null }
    }
  ]
}
```

What each piece is doing (full field reference in §5):
- `pools`: everyone enters by initial seed (`source: "initial"`), and
  `advancement.noElimination` means the phase produces a ranking but eliminates nobody
  — it exists purely to sort the field.
- `elite` and `challenger` both declare `dependsOn: ["pools"]` explicitly — this is what
  makes them **independent of each other**. Without it, the default dependency (the
  single preceding stage in the array) would wrongly make `challenger` depend on
  `elite`, gating one division on the other finishing first.
- `participants.source: "rank_range"` with `basedOn: "last_pool"` slices competitors by
  their finishing *position in the pool round* (not their pre-competition seed) —
  `from`/`to` are 1-indexed inclusive; `to: null` means "to the end of the field."

### Step 3 — add a catalog entry (optional, but recommended)

Without one, the shape still works and surfaces in the director's dropdown automatically
as a `scope: "custom"` entry, using the shape's own `id`/`description` verbatim. Add a
catalog entry when you want a friendlier label, FIE article references, scope tagging,
or explanatory text. In `formats/catalog.json`:

```json
{
  "id": "club-elite-challenger-foil",
  "label": "Club Championship — Elite / Challenger Split",
  "shape": "club-elite-challenger",
  "scope": "club",
  "eventType": "individual",
  "why": "Club-level alternative to a single tableau: ranks the whole field with one no-elimination pool round, then gives the top 12 a repechage tableau (a fairer, longer route for the strongest fencers) while everyone else fences a plain single-elimination tableau."
}
```

`scope: "club"` (not `"fie"`) means it's excluded from the director's "Official FIE
formats only" filter, and it won't need a `ruleRefs` FIE article citation — see §6.

### Step 4 — try it

Reload the competition detail page — the format now appears in the picker (grouped
under "Club / Regional" if `fieOnly` is on, since `scope` is `"club"`). Selecting it and
creating stages walks: Pool Round → (both Elite and Challenger become available at once,
since neither depends on the other) → close each independently. `services/results.js`
merges both terminal stages (`elite`, `challenger` — both are "terminal" since nothing
depends on either) into one results table automatically, no extra code needed.

That's the whole loop: rule file (reuse or new) → shape file (stages + participants +
advancement) → catalog entry (presentation). The rest of this document is the detailed
field reference for each layer.

---

## 3. Pool rule files (`rules/*.json`, `"type": "pool"`)

Every `.json` file in `rules/` with `"type": "pool"` automatically appears in the
**Add Phase** dropdown on the competition detail page — no registration step, no schema
validation, just save the file.

### Minimal example

```json
{
  "id": "pool-u17",
  "description": "U17 Pool Phase",
  "type": "pool",
  "poolFormation": {
    "algorithm": "serpentine-seeding",
    "allowedSizes": [6, 5],
    "singlePoolMaxN": 8,
    "separation": ["nationality"]
  },
  "advancement": {
    "method": "percentage",
    "value": 80,
    "eliminateAfterPhase": true
  },
  "seeding": {
    "criteria": [
      "victory_ratio_desc",
      "indicator_desc",
      "touches_scored_desc",
      "touches_received_asc",
      "initial_seed_asc"
    ]
  },
  "bout": {
    "touchTarget": 5,
    "timeLimitMinutes": 3
  }
}
```

### Top-level fields

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Unique identifier. Used internally. No spaces. |
| `description` | string | yes | Human-readable label shown in the dropdown. |
| `type` | string | yes | Must be `"pool"` for pool phases. |

### `poolFormation`

Controls how fencers are distributed into pools.

| Field | Type | Required | Description |
|---|---|---|---|
| `algorithm` | string | yes | Must be `"serpentine-seeding"`. Assigns fencers to pools in a snake pattern by seed (1→pool1, 2→pool2, …, back). |
| `allowedSizes` | number[] | yes | Pool sizes in priority order, largest first. The system picks the best combination. Common values: `[7,6,5]`, `[6,5]`, `[5,4]`. |
| `singlePoolMaxN` | number | yes | If the total number of active fencers is ≤ this value, a "single pool of N" option is also offered to the organiser. Set to `0` to never offer it. |
| `separation` | string[] | yes | Fields to try to separate when placing fencers. Fencers sharing values in these fields are placed in different pools when possible. Allowed values: `"nationality"`, `"club"`. Order matters: the first field is prioritised. Use `[]` for no separation. |

**Use `["nationality"]` only for any FIE-format rule file.** The same `separation`
array also decides when `lib/boutOrder.js` applies FIE's special nationality-conflict
bout-order tables (o.70) — those tables are officially defined for *nationality*
conflicts only. If `"club"` is included and two fencers who share a club (but not a
nationality) land in the same pool, Atlas will apply the special tables anyway — a
real, silent deviation from what an actual FIE-sanctioned event would produce, not
just a formation-time preference. `"club"` remains a supported option for genuinely
non-FIE, domestic/club-level rule files where keeping training partners apart is a
deliberate choice — just don't combine it with a rule file meant to replicate an
official FIE formula. `pool-standard.json` and `level-pools.json` both use
`["nationality"]` only.

**How `allowedSizes` works**

The system tries to fill all pools using only the sizes you list, in this order of preference:
1. All pools the same size using the largest allowed size.
2. All pools the same size using the second-largest.
3. A combination using only the top two sizes.
4. If nothing works, it falls back to all listed sizes.

When more than one valid combination exists, the organiser is shown a choice. When only
one combination exists, it is used automatically.

**Examples for `allowedSizes: [7, 6, 5]`:**

| Fencers | Result |
|---|---|
| 21 | 3 pools of 7 (automatic) |
| 18 | 3 pools of 6 (automatic) |
| 20 | Choice: 2×7+1×6 or 1×7+3×6... shown to organiser |
| 8 | 1×7+1×8 not possible → 1×5+1×3 not possible → falls back to single pool (if ≤ singlePoolMaxN) |

### `advancement`

Controls how many fencers advance to the next phase when the phase is closed with
its *default* rule (a format stage, or the director at close time, can override this —
see below).

| Field | Type | Required | Description |
|---|---|---|---|
| `method` | string | yes | How the cutoff is calculated. See below. |
| `value` | number | yes | The threshold value. Meaning depends on `method`. |
| `roundTo` | number | no | Only used with `"percentage"`. Rounds the computed cutoff up to the next multiple of this value. E.g. `value: 70, roundTo: 8` with 45 fencers advances the next multiple of 8 at or above 70% of 45. |
| `eliminateAfterPhase` | boolean | yes | `true` = only the advancing fencers continue. `false` = all fencers continue (e.g. a ranking-only round used before a full DE). |

**`method` values:**

| Value | Meaning |
|---|---|
| `"percentage"` | Top N% of fencers advance. E.g. `value: 70` means the best 70% advance (rounded to a whole number, then optionally up to `roundTo`). |
| `"count"` | Exactly `value` fencers advance regardless of pool count. |
| `"multiple"` | Advances the largest multiple of `multipleOf` that is ≤ the total fencer count. |

**Director override at close time.** Regardless of what a rule file's `advancement`
says, `public/phase.html` always shows an "Advance:" control when closing an active pool
phase, letting the director override the method (`rule` / `percentage` / `count` /
`multiple`) and value for that specific close — including a `roundTo` field when
`percentage` is selected. This is the standing mechanism for "pick the cutoff based on
how the actual field of fencers turned out"; there's no separate per-rule-file
"pick from a curated menu" mechanism, and there doesn't need to be — the override already
covers every method a rule file can express.

**When a phase belongs to a format stage** (its `rule_doc` is driven by a `formats/*.json`
stage rather than chosen ad hoc), the format's own `advancement` block on that stage
(`exemptTop`, `noElimination`, `isFinalRanking`, `useParam` — see §5) takes priority over
this rule file's `advancement`, unless the director explicitly overrides at close time.
If the stage sets none of those (or omits `advancement` entirely, or sets it to
`{ "useRule": true }` as a self-documenting no-op), this rule file's own `advancement`
is used directly.

### `seeding`

Defines how fencers are ranked after pools. The ranking is used to seed the next phase
(further pool rounds or the DE tableau).

| Field | Type | Required | Description |
|---|---|---|---|
| `criteria` | string[] | yes | Ordered list of sort keys. Applied in sequence as tiebreakers. |

**Allowed criteria values** (use in this order for FIE compliance):

| Value | Meaning |
|---|---|
| `"victory_ratio_desc"` | V/M — victories ÷ bouts fenced, highest first. **Use this, not `victories_desc`**, so that fencers with fewer bouts (e.g. opponent withdrew) are not unfairly treated. |
| `"victories_desc"` | Raw victory count, highest first. |
| `"indicator_desc"` | Indicator (touches scored − touches received), highest first. |
| `"touches_scored_desc"` | Total touches scored, highest first. |
| `"touches_received_asc"` | Total touches received, lowest first. |
| `"initial_seed_asc"` | Pre-competition seed number, lowest first. Reliable final tiebreaker. |

The standard FIE order is:
```json
["victory_ratio_desc", "indicator_desc", "touches_scored_desc", "touches_received_asc", "initial_seed_asc"]
```

### `bout`

Parameters for individual pool bouts.

| Field | Type | Required | Description |
|---|---|---|---|
| `touchTarget` | number | yes | Number of touches needed to win (e.g. `5` for pools, `15` for individual DE, `45` for team). |
| `timeLimitMinutes` | number | yes | Time limit per bout in minutes. `3` is standard for pools. |

### Creating a new pool rule file

1. Copy `pool-standard.json` to a new file, e.g. `pool-veterans.json`.
2. Change `id` and `description`.
3. Adjust the fields you need.
4. Save — the file appears in the dropdown immediately on the next page load (no server restart needed).

---

## 4. DE rule files (`rules/*.json`, `"type": "de"`)

Rule files in `rules/` with `"type": "de"` appear in the **Add Phase → Direct
Elimination** dropdown on the competition detail page.

### Minimal example

```json
{
  "id": "de-custom",
  "description": "My custom DE",
  "type": "de",
  "bout": {
    "touchTarget": 15,
    "timeLimitMinutes": 9,
    "overtime": { "enabled": true, "durationSeconds": 60 }
  },
  "tableau": { "size": null, "seeding": "fie-serpentine" },
  "repechage": { "enabled": false },
  "placement": { "thirdPlaceBout": true, "allPlacesFenced": null }
}
```

### Full example with repechage and all-places-fenced

```json
{
  "id": "de-repechage-t32-t8",
  "description": "Individual DE — repechage T32→T8, fence every place from T16",
  "type": "de",
  "bout": {
    "touchTarget": 15,
    "timeLimitMinutes": 9,
    "overtime": { "enabled": true, "durationSeconds": 60 }
  },
  "tableau": { "size": null, "seeding": "fie-serpentine" },
  "repechage": {
    "enabled": true,
    "fromTableau": 32,
    "reentryAt": 8
  },
  "placement": {
    "thirdPlaceBout": true,
    "allPlacesFenced": 16
  }
}
```

### Top-level fields

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Unique identifier. No spaces. |
| `description` | string | yes | Human-readable label shown in the dropdown. |
| `type` | string | yes | Must be `"de"`. |

### `bout`

| Field | Type | Required | Description |
|---|---|---|---|
| `touchTarget` | number | yes | Winning score. `5` pools · `10` or `15` individual DE · `45` team. |
| `timeLimitMinutes` | number | yes | Time limit per bout. `3` pools · `6` 10-touch DE · `9` 15-touch DE. |
| `overtime.enabled` | boolean | no | Default `true`. When scores are tied at time, fence sudden-death with random priority. Always `false` in pools (ties are allowed). |
| `overtime.durationSeconds` | number | no | Default `60`. Duration of the overtime period. |

### `tableau`

| Field | Type | Required | Description |
|---|---|---|---|
| `size` | number \| null | no | Force a specific tableau size (e.g. `64`). `null` = auto: smallest power of 2 ≥ N active fencers. Byes fill from the top seeds down. |
| `seeding` | string | no | Default `"fie-serpentine"`. Seed 1 and seed T at opposite ends; seeds 1 and 2 can only meet in the final; seeds 2 and 3 can only meet in the semifinal. No other value is currently supported. |

### `repechage`

Fencers who lose in the main tableau re-enter a parallel repechage tableau. Winners of
the final repechage round rejoin the main tableau at `reentryAt`, forming the finals
together with the main-tableau survivors.

**Tableau size and repechage rounds**

The actual tableau size `T` is always `getTableauSize(N)` — the smallest power of 2 ≥
the number of active fencers. `fromTableau` is informational only (it documents the
maximum N the rule was designed for) and is not used in any computation.

Number of repechage rounds = `log₂(T / reentryAt)` where T = `getTableauSize(N)`.
Minimum fencers required: `reentryAt × 2`.

| Field | Type | Required | Description |
|---|---|---|---|
| `enabled` | boolean | yes | `false` disables repechage entirely (default). |
| `fromTableau` | number | if enabled | Informational — maximum N this rule is designed for. Not used in tableau computation. |
| `reentryAt` | number | if enabled | Finals tableau size: repechage winners rejoin the main tableau here. Must be a power of 2. Minimum fencers = `reentryAt × 2`. |

**How the repechage tableau is built**

For each repechage cycle:

1. **Intra round** — R1-losers (or previous injection winners) fence each other.
2. **Injection round** — intra-winners are seeded below the new group of main-tableau losers and all fence together.

This repeats `log₂(T / reentryAt)` times. The last injection winners and the last
main-tableau survivors then fence the finals tableau together.

**Example — USA Fencing DE16 with repechage (T16→T8, 1 repechage cycle):**

```
Table A (T16 R1, 8 bouts)  →  Table B (QF, 4 bouts)
         ↓ losers                      ↓ losers
Table C (intra, 4 bouts)               |
         ↓ winners                     |
Table D (injection, 4 bouts) ──────────┘
         ↓ winners + B-winners
Table E/F/G (Finals T8)
```
8 R1-losers fence → 4 C-winners join 4 QF-losers in Table D → 4 D-winners enter Finals.

**Example — classic FIE épée historical (T64→T4, 4 repechage rounds):**

```json
"repechage": { "enabled": true, "fromTableau": 64, "reentryAt": 4 }
```
Losers from T64, T32, T16, T8 all feed repechage. 2 repechage winners join the 2
main-tableau finalists at T4.

### `placement`

Controls what happens to fencers who lose in the main tableau (and repechage, if
enabled) after the phase is complete.

| Field | Type | Required | Description |
|---|---|---|---|
| `thirdPlaceBout` | boolean | yes | `true` = semifinal losers fence for 3rd/4th. `false` = two bronze medals awarded, no bout. Ignored when `allPlacesFenced` is set. |
| `allPlacesFenced` | number \| null | no | `null` = no all-places-fenced. Set to a tableau size to fence for every unique place from that round onwards. Bronze is always implied when this is set. |

**`allPlacesFenced` values and effect:**

| Value | Rounds with placement bouts | Extra bouts |
|---|---|---|
| `null` | None. Places shared within each eliminated group. | 0 |
| `4` | Semifinal losers only (same as `thirdPlaceBout: true`). | 1 |
| `8` | T8 losers fence for 5th–8th · T4 losers fence for 3rd–4th. | 1 + 3 = 4 |
| `16` | T16 losers fence for 9th–16th · T8 for 5th–8th · T4 for 3rd–4th. | 7 + 3 + 1 = 11 |
| `32` | T32 losers for 17th–32nd · T16 for 9th–16th · … | 15 + 7 + 3 + 1 = 26 |

A group of N losers at a given round produces a mini-tableau of N−1 bouts (same as any
elimination tableau) and yields N unique places.

### Shipped DE rule files

| File | Description |
|---|---|
| `de-standard.json` | 15 touches · 9 min · bronze bout · no repechage |
| `de-no-bronze.json` | 15 touches · 9 min · two bronze medals · no repechage |
| `de-repechage-t32-t8.json` | 15 touches · repechage T32→T8 · bronze |
| `de-repechage-t64-t4.json` | 15 touches · repechage T64→T4 (classic FIE épée) · bronze |
| `de-all-places-t16.json` | 15 touches · all-places-fenced from T16 · no repechage |
| `de-prelim.json` | 15 touches · no bronze · no repechage — for use as a preliminary DE inside a multi-phase formula |

### Creating a new DE rule file

1. Copy the closest existing file.
2. Change `id` and `description`.
3. Adjust fields.
4. Save — the file appears in the dropdown immediately on next page load.

---

## 5. Format shape files (`formats/*.json`, not `catalog.json`)

A shape file chains rule files together into a multi-stage pipeline. Every stage in
`stages[]` becomes one phase when the director walks through creating the competition.

### Top-level fields

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Unique identifier. Also the filename (minus `.json`). Never rename an existing one — old competitions store this id directly in `competitions.format_id` if there's no catalog entry aliasing it. |
| `description` | string | yes | Fallback label, only shown directly if no catalog entry aliases this shape (see §6). |
| `params` | array | no | Director-facing tunable values (e.g. an advancement percentage) — see below. |
| `stages` | array | yes | The pipeline itself, in declaration order. |

### A stage object

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Unique within this format. Stored as `phases.format_stage` on the created phase. |
| `label` | string | yes | Shown as the phase's name in the UI. |
| `phaseType` | string | yes | `"pool"` or `"de"`. |
| `rule` | string | yes | Filename of the rule file this stage uses (from `rules/`), e.g. `"pool-standard.json"`. |
| `dependsOn` | string[] | no | Which other stage id(s) must be finished before this one can be created. **Omit this for the common case** — it then defaults to the single immediately-preceding stage in the array, which is what every linear format (pools → DE) wants. Set explicitly to `[]` for a stage with no prerequisite (independent/parallel tracks — see §2's example), or to a specific list for anything more exotic. |
| `participants` | object | yes | Who enters this stage and in what order — see below. |
| `advancement` | object | no | What happens when this stage is closed — see below. Omit entirely (or set `{ "useRule": true }`, a self-documenting no-op) to just use the rule file's own advancement untouched. |

### `participants` — who's in this stage

| Shape | Meaning |
|---|---|
| `{ "source": "initial" }` | Everyone, ordered by initial (pre-competition) seed. |
| `{ "source": "initial", "excludeTopByInitialSeed": N, "initialExemptCohort": "some_cohort" }` | Everyone except the top N by initial seed, who are instead tagged with the given cohort name (assigned once, idempotently) so a later stage's `cohorts` list (below) can pick them back up. |
| `{ "source": "rank_range", "from": N, "to": M }` | A slice of the field by **initial seed**, 1-indexed inclusive. `to: null` means open-ended (to the end of the field). Used for initial-seed-based parallel divisions (e.g. Division 1/2 — see §2's shape but with `basedOn` omitted). |
| `{ "source": "rank_range", "basedOn": "last_pool", "from": N, "to": M }` | Same slicing, but by **finishing position in the most recently finished pool phase** instead of initial seed. Requires a finished pool phase to exist — throws a clear error otherwise. Used for pool-result-based splits (§2's worked example). |
| `{ "source": "active_remainder" }` | Everyone currently active who hasn't been claimed by any cohort yet (see `exemptCohort`/`initialExemptCohort` below). Used for a preliminary DE stage that follows a pool stage with an exempt cohort carved out (e.g. Grand Prix's preliminary tableau). |
| `{ "seedingMethod": "last_pool" }` | Seeded by the ranking of the single most recently finished pool phase. Used for a stage that follows exactly one pool round. |
| `{ "seedingMethod": "combined" }` | Seeded by aggregate stats (V/M, indicator, touches) across **every** finished pool phase in the competition. Used when multiple pool rounds should combine into one seeding rather than each pool round independently narrowing the field. |
| `{ "cohorts": [ { "cohort": "name", "sortBy": "...", ... }, ... ] }` | The final stage of a format that assembled several separate cohorts earlier (exempt top seeds, pool survivors, preliminary-DE survivors, ...) — concatenates them in the listed order to seed one tableau. See the cohort spec table below. |

**Cohort spec fields** (only used inside a `cohorts` list):

| Field | Type | Required | Description |
|---|---|---|---|
| `cohort` | string | yes | The cohort name written earlier by `excludeTopByInitialSeed`/`initialExemptCohort`, or by an earlier stage's `advancement.exemptCohort`/`survivorCohort`. |
| `sortBy` | string | yes | `"initial_seed_asc"` or `"pool_rank_asc"`. |
| `poolStage` | string | if `sortBy: "pool_rank_asc"` | Which earlier stage's pool ranking to sort this cohort by. |
| `pairedLotDraw` | boolean | no | FIE o.87/o.102 "drawing lots in pairs": within this cohort, adjacent rank pairs (1st&2nd, 3rd&4th, …) get randomly swapped between their two assigned seed slots — those two slots are always equally-difficult bracket positions (siblings from the same seeding split), just not identical, so which specific one each fencer lands in is drawn by lot rather than fixed by rank. An odd one out (odd cohort size) keeps its slot. |

### `advancement` — what happens at stage close

| Field | Type | Required | Description |
|---|---|---|---|
| `noElimination` | boolean | no | Nobody is eliminated; the phase produces a ranking only. Used for a pure-seeding pool round before an independent split. |
| `isFinalRanking` | boolean | no | This stage **is** the final result — no further stage follows it, nothing is eliminated, but every ranking row is marked as the terminal placement (`advanced = 0` for everyone, which `services/results.js` reads as "this row is a genuine final rank," not "eliminated"). Used by `pool-level-pools.json`'s Level Pools stage. |
| `exemptTop` | number | no | The top N finishers of this stage are pulled out into a cohort (see `exemptCohort`) instead of continuing normally — e.g. Grand Prix exempting its top 16 pool finishers from the preliminary tableau. |
| `exemptCohort` | string | no | Name to tag the `exemptTop` competitors with (default `"pool_exempt"`). Referenced later by a `cohorts` participants list. |
| `survivorTarget` | number | no | Only valid on a DE stage. The stage closes early once exactly this many undefeated competitors remain — used for a preliminary tableau that's meant to narrow the field to a specific bracket size (e.g. down to 32) rather than run to completion. Closing validates that the stopping round is fully played and that survivor count matches exactly. |
| `survivorCohort` | string | no | Name to tag the survivors with (default `"de_survivors"`). Referenced later by a `cohorts` participants list. |
| `useParam` | string | no | Advancement percentage is read from this format's own `params` (below) instead of being fixed — lets the director choose a value (within the range you define) when they apply the format to a competition. |

If a stage's `advancement` sets none of the above (or is omitted, or is
`{ "useRule": true }`), the stage's own rule file's `advancement` block (§3) is used
directly — this is the common case for a stage that's just "a normal pool round with a
fixed cutoff," and there's no need to duplicate the rule file's percentage here.

### `params` — director-tunable values

```json
"params": [
  { "id": "pool_advancement_pct", "label": "Advancement after pools (%)", "type": "integer", "default": 70, "min": 10, "max": 100 }
]
```

Referenced from a stage via `advancement.useParam`. Shown to the director as an input
field when they select this format (or a catalog entry aliasing it) on the competition
detail page, defaulting to `default` — or to a catalog entry's `paramOverrides` value if
one is set (§6). The chosen value is stored on the competition (`format_params`) and
read back by `applyPoolClose` at close time.

### Stage dependency defaults, precisely

`_stageDependencies` in `services/formats.js`: if a stage has no `dependsOn` key at all,
its dependency is exactly `[format.stages[index - 1].id]` (or `[]` if it's the first
stage). This is why every pre-parallel-tracks format never needed to write `dependsOn`
at all — and why it's safe to leave it off for any ordinary linear stage today. Only
write `dependsOn` explicitly when you need something other than "the one stage right
before me in the array" — most commonly `[]` for a stage that can start as soon as *some
specific earlier* stage (not necessarily the immediately preceding one) is done, letting
two or more stages become available simultaneously.

**Terminal stages** (`getTerminalStages`) are every stage nothing else depends on — for
a linear format that's the one last stage; for parallel divisions it's every division's
own final stage. `services/results.js` ranks and merges exactly the terminal stages,
then walks every other (non-terminal) phase in reverse pipeline order appending whoever
was eliminated there. You never need to touch `results.js` when adding a new shape —
this is computed automatically from `dependsOn`.

---

## 6. Catalog entries (`formats/catalog.json`)

A JSON array of entries. Each aliases exactly one shape file (by the shape's own `id`,
the `shape` field below) with presentation metadata.

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Unique catalog id. This is what actually gets stored in `competitions.format_id` when a director picks this entry. |
| `label` | string | yes | What the director sees in the dropdown. |
| `shape` | string | yes | The `formats/*.json` shape file's own `id` this entry aliases (filename minus `.json`). |
| `scope` | string | yes | `"fie"` or `"club"`. Drives the "Official FIE formats only" filter and the `<optgroup>` grouping on the competition detail page. |
| `eventType` | string | no | E.g. `"individual"`, `"team"`. |
| `tier` | string | no | E.g. `"Grand Prix"`, `"World Cup"`, `"World Championships"`. Used for `<optgroup>` grouping under `scope: "fie"`. |
| `ageCategory` | string | no | E.g. `"senior"`, `"junior"`, `"cadet"`. Also used for grouping. |
| `ruleRefs` | string[] | `fie`-scoped only | FIE Organisation Rules article range this entry implements, e.g. `["o.83-88"]`. Shown inline in the picker. |
| `note` | string | no | Caveats/approximations shown inline — e.g. "uses the fixed 70% shape; the rules technically permit a 70-80% range, which isn't built yet." |
| `why` | string | recommended | Hand-written, human-reviewed: the specific reason to pick *this* entry over a near-duplicate sibling that shares the same or a very similar shape. Also becomes the `<option>`'s native hover tooltip. |
| `paramOverrides` | object | no | `{ paramId: value }` — overrides a shape param's `default` for this specific catalog entry only, without needing a second copy of the shape file. E.g. Veterans reusing the generic pools-then-DE shape but with `pool_advancement_pct` overridden to `100`. |

`mechanics` is **not** a field you write — `services/formats.js`'s `describePipeline()`
computes it live from the shape's actual stages/rules every time, specifically so it
can never drift out of sync with what the format really does. `why` is the
complementary hand-written half: `mechanics` says *what* happens, `why` says *when to
pick this one over that one*.

### Why alias instead of duplicating the shape file?

Because FIE's own rules describe several tiers (Worlds, World Cup, Grand Prix; or
Junior/Cadet Worlds under Mixed Formula B) as literally the same pipeline — duplicating
the shape file per tier would mean any future engine fix (a bug, a new capability) has
to be applied N times and re-verified N times instead of once. One shape, several
catalog entries, is the mechanism that keeps that from happening.

---

## 7. Checklist — creating a brand-new dedicated competition format

1. **Decide the phases.** How many stages, pool or DE, and in what order/dependency
   relationship (linear, or some independent/parallel)?
2. **Rule files** — for each stage, does an existing `rules/*.json` fit? If not, copy
   the closest one and adjust (§3 for pool, §4 for DE).
3. **Shape file** — write `formats/your-shape-id.json`: one stage object per phase,
   wiring `rule`, `participants` (§5), and `advancement` (§5) for each. Only set
   `dependsOn` where the default (single preceding stage) is wrong.
4. **Validate participant counts mentally** (or trust `validateCounts` to catch it at
   creation time) — especially for `survivorTarget`/`exemptTop` combinations, which
   need enough real fencers to produce the numbers you've configured.
5. **Catalog entry** (optional but recommended) — add an entry to `catalog.json`
   aliasing your shape, with a clear `label`, correct `scope`, and (if FIE-scoped)
   `ruleRefs` + a `why` explaining what distinguishes it from any near-duplicate sibling.
6. **Try it** — create a test competition, walk through stage creation, close each
   phase, and check `GET /api/competitions/:id/results` gives one unique rank per
   competitor with no gaps or duplicates.

---

## 8. Where things live

| Path | What |
|---|---|
| `rules/*.json` | Pool and DE rule files (§3, §4) |
| `formats/*.json` (except `catalog.json`) | Format shape files (§5) |
| `formats/catalog.json` | Catalog entries aliasing shapes (§6) |
| `services/formats.js` | Loads/resolves all of the above; `resolveParticipants`, `applyPoolClose`, `closeFormatDE`, `validateCounts`, `getFormatPlan`, `assertNextStage`, `getTerminalStages`, `describePipeline` |
| `services/phases.js` | Phase creation/close; delegates to `services/formats.js` when a phase has a `format_stage` |
| `services/results.js` | Merges terminal + non-terminal phases into one results table — format-agnostic, driven entirely by `getTerminalStages`/`dependsOn` |
| `public/competition-detail.html` | Format picker UI: scope filter, `<optgroup>` grouping, param inputs, stage-creation flow |
| `docs/format-system-comparison.md` | Historical investigation log (Engarde/FencingTime comparison, FIE rules cross-checks, dated bug fixes) — not an authoring guide; this document is |
