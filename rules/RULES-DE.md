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

Fencers who lose in the main bracket between `fromTableau` and
`reentryAt × 2` (inclusive) are placed in a repechage bracket that runs
in parallel with the main bracket. Winners of the final repechage round
re-enter the main bracket at `reentryAt`.

The number of repechage rounds = log₂(fromTableau / reentryAt).

| Field | Type | Required | Description |
|---|---|---|---|
| `enabled` | boolean | yes | `false` disables repechage entirely (default). |
| `fromTableau` | number | if enabled | Tableau size of the first main-bracket round whose losers enter repechage. Must be a power of 2. |
| `reentryAt` | number | if enabled | Tableau size at which repechage winners rejoin the main bracket. Must be a power of 2 smaller than `fromTableau`. |

**How the repechage bracket is built**

Losers enter the repechage in the same round they were eliminated from the
main bracket. Earlier losers (larger tableau) fence each other first; their
winners wait for the next group of losers to arrive before fencing again.
This mirrors the FIE historical structure where losers from each half of the
draw form their own sub-bracket.

**Example — German regional T32→T8 (2 repechage rounds):**

```
Main:         T32 → T16 → T8 (QF) → T4 (SF) → Final
                ↓      ↓      ↑
Repechage:   T32L → QR1 ← T16L
             (16)    (8)   (8 join)
```
16 T32 losers fence → 8 survivors. 8 T16 losers join → 16 fence → 8 repechage
winners enter T8 alongside 8 main-bracket survivors.

**Example — classic FIE épée historical (T64→T4, 4 repechage rounds):**

```json
"repechage": { "enabled": true, "fromTableau": 64, "reentryAt": 4 }
```
Losers from T64, T32, T16, T8 all feed repechage.
2 repechage winners (one per half) join the 2 main-bracket finalists at T4.

---

### `placement`

Controls what happens to fencers who lose in the main bracket (and repechage,
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

A group of N losers at a given round produces a mini-bracket of N−1 bouts
(same as any elimination bracket) and yields N unique places.

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
