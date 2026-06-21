# DE sections data model

Reference for any UI that displays or navigates a Direct Elimination phase —
the competition overview (`de.html`), the remote control, the scoresheet tablet, etc.

---

## Endpoint

```
GET /api/phases/:id/sections
```

Returns:

```json
{
  "tableauSize": 64,
  "sections": [ ... ]
}
```

`tableauSize` — the full power-of-2 tableau size (e.g. 64 for 45–64 fencers).
Used client-side to compute seed numbers from `buildSeedPositions(T)`.

---

## Section object

```json
{
  "id":          "main",
  "label":       "Tableau",
  "displayHint": "bracket",
  "note":        null,
  "rounds":      [ ... ]
}
```

| Field | Values | Meaning |
|---|---|---|
| `id` | `"main"`, `"repechage"`, `"finals"`, `"placement-N"` | Stable identifier for filtering |
| `label` | Human string | Display title |
| `displayHint` | `"bracket"` or `"list"` | Suggested layout: bracket = columns with alignment, list = flat grid |
| `note` | string or null | Optional subtitle (e.g. "Losers enter repechage") |

### Section IDs by competition type

| Competition type | Sections produced |
|---|---|
| Standard DE | `main` |
| Repechage | `main`, `repechage`, `finals` |
| All-places-fenced | `main`, `placement-3`, `placement-5`, … |
| Repechage + all-places | `main`, `repechage`, `finals`, `placement-3`, … |

---

## Round object

```json
{
  "label":     "Round of 16",
  "note":      null,
  "stripSlot": { "bracket": "main", "tableau": 16, "partition": "full" },
  "bouts":     [ ... ]
}
```

`label` — display string (e.g. "Round of 64", "Quarterfinal", "Final",
"Table A", "Table D (Repechage)", "Table H (Final)").

`note` — secondary label shown below the round header; null in standard DE.

`stripSlot` — links this round to the pipeline.
- `bracket`: `"main"` or `"repechage"`
- `tableau`: the round-of-N size for this round (halves each round)
- `partition`: currently always `"full"`; future sub-half assignments will use `"a"`, `"b"`, etc.
- `null` when the round has no pipeline assignment (some repechage rounds).

Rounds are ordered earliest-to-latest (index 0 = first round of that section).

---

## Bout object

Each entry in `round.bouts`:

```json
{
  "id":               12,
  "de_round":         3,
  "tableau_position": 2,
  "bracket":          "main",
  "status":           "pending",
  "left_id":          7,
  "left_first":       "Jan",
  "left_last":        "Janssen",
  "right_id":         14,
  "right_first":      "Piet",
  "right_last":       "Pieters",
  "left_score":       null,
  "right_score":      null,
  "winner_id":        null,
  "place_rank":       null
}
```

`status` — `"pending"` | `"active"` | `"finished"`

`left_id` / `right_id` — competitor IDs; null means a bye slot or TBD (winner not yet known).

`tableau_position` — 1-based position within the round, in tableau order (not bout order).

`place_rank` — set only on placement bouts; the winning rank (e.g. 3 for the bronze bout).

**Bye detection:** `status === "finished"` AND (`left_id === null` OR `right_id === null`).

**TBD / empty:** both `left_id` and `right_id` are null.

---

## Seed numbers

Seed numbers are **not** stored in the bout rows. Compute them client-side:

```js
function buildSeedPositions(T) {
  let slots = [1, 2], cur = 2;
  while (cur < T) {
    cur *= 2;
    const next = [];
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      if (i % 2 === 0) next.push(s, cur + 1 - s);
      else             next.push(cur + 1 - s, s);
    }
    slots = next;
  }
  return slots;
}
```

From round-1 bouts (the first round of the `main` section):

```js
const seedSlots = buildSeedPositions(tableauSize);
const seedMap   = {};          // competitor_id → seed number
for (const b of firstRound.bouts) {
  const p = b.tableau_position;
  if (b.left_id)  seedMap[b.left_id]  = seedSlots[2 * (p - 1)];
  if (b.right_id) seedMap[b.right_id] = seedSlots[2 * (p - 1) + 1];
}
```

---

## Filtering model (as implemented in de.html)

Three independent filters, all client-side:

| Filter | State var | Scope |
|---|---|---|
| Section | `filterSectionId` (section id or `""`) | Hides all other section cards |
| From round | `filterFromRoundIdx` (0-based round index) | Hides rounds before the selected index within the active section |
| Piste | `filterStripId` (strip id or `""`) | Hides rounds not assigned to that piste in the pipeline |

`currentSectionForFilter` — the section the round filter applies to:
- `filterSectionId` set → use that section
- `filterSectionId` empty AND only one section → use that section (so the round filter works for a plain single-section DE without requiring a section selection first)
- otherwise → no round filter

Resetting: `filterFromRoundIdx` resets to 0 whenever `filterSectionId` changes.

---

## Real-time updates

```
GET /api/phases/:id/events   (SSE)
```

Event name: `bout-updated`
Data: a single bout object (same shape as above, partial fields updated).

Consumers should merge the updated bout into their local bout list by matching `id`.
