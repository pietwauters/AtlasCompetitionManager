# DE Rule Files — Author Guide

Rule files in `rules/` with `"type": "de"` appear in the
**Add Phase → Direct Elimination** dropdown on the competition detail page.

---

## Minimal example

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

---

## Full example with repechage and all-places-fenced

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

---

## Field reference

### Top-level fields

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Unique identifier. No spaces. |
| `description` | string | yes | Human-readable label shown in the dropdown. |
| `type` | string | yes | Must be `"de"`. |

---

### `bout`

| Field | Type | Required | Description |
|---|---|---|---|
| `touchTarget` | number | yes | Winning score. `5` pools · `10` or `15` individual DE · `45` team. |
| `timeLimitMinutes` | number | yes | Time limit per bout. `3` pools · `6` 10-touch DE · `9` 15-touch DE. |
| `overtime.enabled` | boolean | no | Default `true`. When scores are tied at time, fence sudden-death with random priority. Always `false` in pools (ties are allowed). |
| `overtime.durationSeconds` | number | no | Default `60`. Duration of the overtime period. |

---

### `tableau`

| Field | Type | Required | Description |
|---|---|---|---|
| `size` | number \| null | no | Force a specific tableau size (e.g. `64`). `null` = auto: smallest power of 2 ≥ N active fencers. Byes fill from the top seeds down. |
| `seeding` | string | no | Default `"fie-serpentine"`. Seed 1 and seed T at opposite ends; seeds 1 and 2 can only meet in the final; seeds 2 and 3 can only meet in the semifinal. No other value is currently supported. |

---

### `repechage`

Fencers who lose in the main tableau re-enter a parallel repechage tableau.
Winners of the final repechage round rejoin the main tableau at `reentryAt`,
forming the finals together with the main-tableau survivors.

**Tableau size and repechage rounds**

The actual tableau size `T` is always `getTableauSize(N)` — the smallest
power of 2 ≥ the number of active fencers. `fromTableau` is informational
only (it documents the maximum N the rule was designed for) and is not used
in any computation.

Number of repechage rounds = `log₂(T / reentryAt)` where T = getTableauSize(N).
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

This repeats `log₂(T / reentryAt)` times. The last injection winners and the
last main-tableau survivors then fence the finals tableau together.

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
Losers from T64, T32, T16, T8 all feed repechage.
2 repechage winners join the 2 main-tableau finalists at T4.

---

### `placement`

Controls what happens to fencers who lose in the main tableau (and repechage,
if enabled) after the phase is complete.

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

A group of N losers at a given round produces a mini-tableau of N−1 bouts
(same as any elimination tableau) and yields N unique places.

---

## Shipped rule files

| File | Description |
|---|---|
| `de-standard.json` | 15 touches · 9 min · bronze bout · no repechage |
| `de-no-bronze.json` | 15 touches · 9 min · two bronze medals · no repechage |
| `de-repechage-t32-t8.json` | 15 touches · repechage T32→T8 · bronze |
| `de-repechage-t64-t4.json` | 15 touches · repechage T64→T4 (classic FIE épée) · bronze |
| `de-all-places-t16.json` | 15 touches · all-places-fenced from T16 · no repechage |
| `de-prelim.json` | 15 touches · no bronze · no repechage — for use as a preliminary DE inside a multi-phase formula |

## Creating a new rule file

1. Copy the closest existing file.
2. Change `id` and `description`.
3. Adjust fields.
4. Save — the file appears in the dropdown immediately on next page load.
