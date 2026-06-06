# Pool Rule Files — Author Guide

Rule files live in the `rules/` folder. Every `.json` file here automatically
appears in the **Add Phase** dropdown on the competition detail page. You can
have as many as you like.

---

## Minimal example

```json
{
  "id": "pool-u17",
  "description": "U17 Pool Phase",
  "type": "pool",
  "poolFormation": {
    "algorithm": "serpentine-seeding",
    "allowedSizes": [6, 5],
    "singlePoolMaxN": 8,
    "separation": ["nationality", "club"]
  },
  "advancement": {
    "method": "percentage",
    "value": 80,
    "minimumVictories": null,
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

---

## Field reference

### Top-level fields

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Unique identifier. Used internally. No spaces. |
| `description` | string | yes | Human-readable label shown in the dropdown. |
| `type` | string | yes | Must be `"pool"` for pool phases. |

---

### `poolFormation`

Controls how fencers are distributed into pools.

| Field | Type | Required | Description |
|---|---|---|---|
| `algorithm` | string | yes | Must be `"serpentine-seeding"`. Assigns fencers to pools in a snake pattern by seed (1→pool1, 2→pool2, …, back). |
| `allowedSizes` | number[] | yes | Pool sizes in priority order, largest first. The system picks the best combination. Common values: `[7,6,5]`, `[6,5]`, `[5,4]`. |
| `singlePoolMaxN` | number | yes | If the total number of active fencers is ≤ this value, a "single pool of N" option is also offered to the organiser. Set to `0` to never offer it. |
| `separation` | string[] | yes | Fields to try to separate when placing fencers. Fencers sharing values in these fields are placed in different pools when possible. Allowed values: `"nationality"`, `"club"`. Order matters: the first field is prioritised. Use `[]` for no separation. |

**How `allowedSizes` works**

The system tries to fill all pools using only the sizes you list, in this order of preference:
1. All pools the same size using the largest allowed size.
2. All pools the same size using the second-largest.
3. A combination using only the top two sizes.
4. If nothing works, it falls back to all listed sizes.

When more than one valid combination exists, the organiser is shown a choice.
When only one combination exists, it is used automatically.

**Examples for `allowedSizes: [7, 6, 5]`:**

| Fencers | Result |
|---|---|
| 21 | 3 pools of 7 (automatic) |
| 18 | 3 pools of 6 (automatic) |
| 20 | Choice: 2×7+1×6 or 1×7+3×6... shown to organiser |
| 8 | 1×7+1×8 not possible → 1×5+1×3 not possible → falls back to single pool (if ≤ singlePoolMaxN) |

---

### `advancement`

Controls how many fencers advance to the next phase.

| Field | Type | Required | Description |
|---|---|---|---|
| `method` | string | yes | How the cutoff is calculated. See below. |
| `value` | number | yes | The threshold value. Meaning depends on `method`. |
| `minimumVictories` | number \| null | no | If set, fencers with fewer victories than this are eliminated regardless of position. Set to `null` to disable. |
| `eliminateAfterPhase` | boolean | yes | `true` = only the advancing fencers continue. `false` = all fencers continue (e.g. a ranking-only round used before a full DE). |

**`method` values:**

| Value | Meaning |
|---|---|
| `"percentage"` | Top N% of fencers advance. E.g. `value: 70` means the best 70% advance (rounded to a whole number). |
| `"count"` | Exactly `value` fencers advance regardless of pool count. |
| `"top_per_pool"` | The top `value` fencers from each pool advance. |

---

### `seeding`

Defines how fencers are ranked after pools. The ranking is used to seed the
next phase (further pool rounds or the DE tableau).

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

---

### `bout`

Parameters for individual pool bouts.

| Field | Type | Required | Description |
|---|---|---|---|
| `touchTarget` | number | yes | Number of touches needed to win (e.g. `5` for pools, `15` for individual DE, `45` for team). |
| `timeLimitMinutes` | number | yes | Time limit per bout in minutes. `3` is standard for pools. |

---

## Creating a new rule file

1. Copy `pool-standard.json` to a new file, e.g. `pool-veterans.json`.
2. Change `id` and `description`.
3. Adjust the fields you need.
4. Save — the file appears in the dropdown immediately on the next page load (no server restart needed).

No registration or schema validation step is required.
