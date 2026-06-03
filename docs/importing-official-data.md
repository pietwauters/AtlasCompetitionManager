# Importing Official Competition Data

This document records the design decisions for importing fencer and official data
from external sources (FIE, national federations, confederations, etc.) into Atlas.
It serves as the authoritative reference before implementing any import feature.

---

## Context

Atlas manages competitions that may draw fencers from outside the local club database.
Entry lists for official competitions are published by the organising body (FIE, national
federation, confederation) in various file formats. These files contain the authoritative
entry list, world/national ranking, and sometimes officials.

The challenge is that:
- Formats differ per body (FIE XML, national CSV, Engarde XML, JSON, future unknowns)
- Ranking is competition- and weapon-specific, not a persistent global property
- Most fencers in an international file will never appear in the local people database
- The same fencer may appear in many competitions over time under the same FIE ID

---

## Known formats

### FIE — `BaseCompetitionIndividuelle` XML

File naming convention observed: `Fencers-{year}-{FIE_competition_id}-{event_title}.xml`

Root element attributes (competition metadata):

| Attribute | Meaning | Example |
|---|---|---|
| `ID` | FIE competition ID | `741` |
| `Arme` | Weapon: F=Fleuret, E=Épée, S=Sabre | `F` |
| `Sexe` | Gender: M/F | `M` |
| `Domaine` | **I=Individuel, E=Équipe** (team) | `I` |
| `Federation` | Organising federation | `FRA` |
| `Categorie` | Age category: S=Senior, J=Junior, C=Cadet, V=Vétéran | `S` |
| `TitreLong` | Full event title | `Championnats d'Europe` |
| `Annee` | Season (FIE year runs Sep–Aug) | `2025/2026` |
| `Date` | Competition date DD.MM.YYYY | `18.06.2026` |

Fencer element (`<Tireur>`) attributes:

| Attribute | Meaning | Maps to |
|---|---|---|
| `ID` | FIE global person ID | `competitors.fie_id` |
| `Nom` / `Prenom` | Last / first name | `competitors.last_name` / `first_name` |
| `Sexe` | Gender M/F | `competitors.gender` |
| `Nation` | NOC 3-letter code | `competitors.nationality` |
| `Licence` | Federation licence number | `competitors.licence` |
| `Lateralite` | Handedness: D=Droite, G=Gauche | `competitors.handedness` |
| `DateNaissance` | DOB, format DD.MM.YYYY | `competitors.date_of_birth` |
| `Classement` | World ranking position (integer; 9999 = unranked) | `competitors.ranking_value` |
| `Points` | FIE world ranking points (decimal, e.g. 11.500) | `competitors.ranking_points` |
| `Statut` | Entry status (N=normal; others TBD) | `competitors.status` |

Special NOC codes: `_AIN` and `AIN_` = Authorized Independent Nations
(Russian / Belarusian athletes competing under neutral status). Both must be
treated as valid nationality codes, not errors.

### FIE — `Accreditations` XML

File naming: `Officials-{year}-{FIE_competition_id}-{event_title}.xml`

Root: `<Accreditations TitreLong="…" Date="…" DateFichierXML="…">`

Each `<Accreditation>` uses **child elements** (not attributes — different parser needed
from the Fencers XML):

| Element | Meaning |
|---|---|
| `<ID>` | FIE global person ID (same namespace as Tireur.ID) |
| `<Nom>` / `<Prenom>` | Name |
| `<Nation>` | NOC code |
| `<Role>` | Accreditation role (see below) |
| `<PictureUrl>` | Photo hosted on static.fie.org |

Known role codes (FIE French terminology):

| Code | French | English |
|---|---|---|
| `ENT` | Entraîneur | Coach / trainer |
| `ARB` | Arbitre | Referee |
| `MED` | Médecin | Medical |
| `DEL` | Délégué | Federation delegate |
| `JUR` | Jury | Table of honour |
| `OFF` | Officiel | Generic official |

Note: the Accreditations file carries less data per person than the Fencers file
(no gender, no licence, no DOB). The FIE ID is the cross-reference key between them.

---

## Schema changes required

| Change | Reason |
|---|---|
| `competitors.fencer_id` → nullable | D1/D2: imported competitors have no people record |
| Add inline fields to `competitors` (see D2) | D2: standalone competitor data |
| Add `competitors.ranking_value REAL` | D3: per-competition ranking |
| Add `competitors.ranking_points REAL` | D3: FIE decimal points (separate from ordinal rank) |
| `fencers.points` INTEGER → REAL | FIE points are decimal; current type silently truncates |
| Add `competitions.seeding_mode` | D4: `'auto'` \| `'manual'` \| `'locked'` |
| Add `competitions.date` | Missing; present in FIE XML |
| Add `competitions.fie_id`, `domain`, `season` | Low priority FIE metadata |
| Add `age_categories.fie_code` | Map S/J/C/V → existing rows on import |

Lower priority (not blocking import):
- `people.fie_id` — useful for local club members registered with FIE, but import
  does not touch the people table (D1), so not on the critical path
- `people.picture_url` — FIE CDN URLs may expire; low value

---

## Design decisions

### D1 — Import target: competition only, never the people table

**Why this decision is needed:**
An official entry list contains fencers from all over the world. Most will never
appear in the local club database and should not pollute it. The people table is
for managing your own club members and local registrations.

**Options considered:**
- A) Import directly into people table (current CSV import behaviour)
- B) Import into competition only; no people records ever created or touched
- C) Import into competition; optionally link to existing people records if matched

**Decision: two separate entry paths, each with its own behaviour.**

- **Import path (file upload):** always creates standalone competitors — no people
  records are created or looked up. All data lives on the competitor record itself.
- **Manual add path (from people DB):** creates linked competitors as today —
  `fencer_id` is set, data comes from the people/fencers tables.

Rationale: option C (optional linking) adds matching complexity and edge cases for
no practical gain in competition management. Result tracking across competitions is
a future concern (O1); it does not justify coupling import to the people table now.

---

### D2 — Competitor record: standalone or always linked to Person

**Why this decision is needed:**
The current `competitors` table only holds `fencer_id` (a foreign key to `fencers`).
Imported standalone competitors have no people record to link to.

**Options considered:**
- A) Always require a people/fencer record (auto-create if needed — contradicts D1)
- B) Make `fencer_id` nullable; add inline fields to `competitors` for standalone entries
- C) Separate table for imported entries alongside the existing competitors table

**Decision: B — `fencer_id` nullable; inline fields on `competitors`.**

Fields added to `competitors` for standalone entries (populated when `fencer_id` is NULL):
- `last_name`, `first_name`
- `nationality` (NOC code)
- `date_of_birth`
- `fie_id` (FIE global person ID — primary deduplication key for re-import)
- `licence`
- `handedness`
- `gender`

When `fencer_id` IS NOT NULL (manual add from people DB), these fields are ignored
and data is read from `people` / `fencers` as today. One table, one code path for
all pool, DE, and results logic.

---

### D3 — Ranking: per-competition on `competitors`, seeded from different sources

**Why this decision is needed:**
`fencers.ranking` is weapon-agnostic and cannot represent FIE world ranking (which
changes after every event and is weapon-specific). It also cannot accommodate two
separate ranking lists when categories are joined.

**Options considered:**
- A) Keep `fencers.ranking` as the single source; ignore for official imports
- B) Weapon-scoped columns on fencers (`ranking_foil`, `ranking_epee`, `ranking_sabre`)
- C) Move ranking entirely to `competitors`; remove from fencers

**Decision: ranking lives on `competitors`; `fencers.ranking` kept as local default.**

Two fields added to `competitors`:
- `ranking_value REAL` — the ordinal position used for seeding (FIE `Classement`;
  national position; or copy of `fencers.ranking` for local competitions).
  Absent or unknown → stored as **9999** (FIE convention for unranked).
- `ranking_points REAL` — the underlying points value where available (FIE `Points`).
  Informational only; not used for seeding order.

Seeding source by competition type:
- **Import file present:** `Classement` → `ranking_value`; `Points` → `ranking_points`.
  Missing ranking → 9999. Local `fencers.ranking` is irrelevant and ignored.
- **Local competition (manual add from people DB):** `fencers.ranking` is copied
  into `competitors.ranking_value` as the starting point. The manager can then
  reorder the list manually before phase creation. Once reordered and locked,
  `fencers.ranking` is no longer consulted.

`fencers.ranking` is NOT deprecated — it remains the input for local competition
seeding. It just never overrides an import file.

---

### D4 — No ranking file / joined categories: manual seeding mode

**Why this decision is needed:**
Not every competition has an import file. Some competitions combine multiple age
categories (e.g. Senior + U20), making a single authoritative ranking list impossible.

**Decision:** `competitions.seeding_mode` field with three values:
- `'auto'` — seeds come from import file or `fencers.ranking`; auto-seed is available
- `'manual'` — no authoritative ranking; manager orders the list before phase creation;
  auto-seed button is disabled and a prominent warning is shown
- `'locked'` — seeds are set and frozen; phase creation is allowed

A competition is set to `'manual'` when:
- No import file has been loaded and no `fencers.ranking` data is available, or
- The manager explicitly overrides to manual mode (e.g. joined categories)

---

### D5 — Import adapter architecture: canonical shape + isolated adapters

**Why this decision is needed:**
FIE XML, national federation CSV, Engarde XML, JSON, and future formats all need to
feed the same competition-loading logic. Ad-hoc per-format DB writes leak quirks
everywhere and make adding new formats expensive.

**Decision: each adapter produces a canonical JS object; one shared service handles DB writes.**

Adapter output shape:

```js
{
  competition: {           // all fields optional — only override if present in file
    title,
    weapon,                // 'foil' | 'epee' | 'sabre'
    gender,                // 'M' | 'F'
    category_fie_code,     // 'S' | 'J' | 'C' | 'V'
    date,                  // ISO YYYY-MM-DD
    fie_id,
    domain,                // 'I' | 'E'
    season,                // e.g. '2025/2026'
  },
  competitors: [
    {
      last_name, first_name,
      gender,              // 'M' | 'F'
      nationality,         // NOC code, e.g. 'BEL', '_AIN'
      date_of_birth,       // ISO YYYY-MM-DD
      licence,
      fie_id,
      handedness,          // 'R' | 'L'  (normalised from D/G or Right/Left)
      ranking_value,       // integer or 9999 if absent
      ranking_points,      // REAL or null
      status,              // 'active' | 'withdrawn'
    },
  ],
}
```

`adapters/fie-xml.js`, `adapters/national-csv.js`, etc. each parse their format
and return this shape. `services/competitionImport.js` is the single entry point
for DB writes, matching, and seeding_mode logic.
Format detection (XML root element name, CSV headers, JSON shape) happens at the
route level before calling an adapter.

---

### D6 — Re-import: merge with full inconsistency report

**Why this decision is needed:**
Official entry lists are revised up to competition day (late entries, withdrawals,
name corrections). A second import must not create duplicates but must also not
silently overwrite data the manager has corrected manually.

**Decision: merge strategy, blocked after phase 1 starts, with a mandatory diff report.**

Matching order (within the competition, not against the people table):
1. `fie_id` — most reliable; survives name changes
2. `licence` — reliable within a federation
3. `last_name + date_of_birth` — fallback for formats without IDs

Before committing a re-import, Atlas produces a diff report showing every inconsistency:

| Change type | Example |
|---|---|
| **Added** | New fencer in file, not yet in competition |
| **Withdrawn** | In competition but absent from new file → will be marked `withdrawn` |
| **Data changed** | Name spelling, DOB, nationality difference between file and DB |
| **Unmatched** | Entry in file that cannot be matched to any existing competitor |

The manager must review and confirm the report before changes are applied.
Re-import is blocked once phase 1 has started; manual add/withdraw only from that point.

---

### D7 — Manual additions always allowed before phase 1

**Decision:** The competition manager can always add a competitor by hand before
phase 1 starts, regardless of whether an import was done. Minimum required:
`last_name` + `nationality`. Such entries have `fencer_id = NULL` and `fie_id = NULL`
and behave identically to imported standalone competitors for all seeding and
competition logic.

---

### D8 — Withdrawal and status values

**Decision:** `competitors.status` values:
- `'active'` — default; competing normally (`Tireur.Statut = 'N'` maps here)
- `'withdrawn'` — scratched before competition starts; excluded from pool formation
- `'dns'` — did not start; arrived, was seeded, but did not fence (scores as a loss)
- `'eliminated'` — existing value; set during competition by pool/DE logic

All non-active statuses are preserved in the DB for record-keeping. Withdrawn and
DNS competitors are excluded from pool formation but appear in final results at the
bottom of the ranking.

---

### D9 — Nationality as pool separation criterion

**Why this decision is needed:**
Current pool separation logic uses `club_id`. Imported competitors have no club
data — only nationality.

**Decision:** Pool separation already supports `'nationality'` as a mode. Verify
that the separation query reads the inline `competitors.nationality` field when
`fencer_id` is NULL, and `people.nationality` when linked. No schema change needed;
confirm in implementation.

---

### D10 — Results export

**Decision:** Out of scope for now. Do not design against it (i.e. do not make
decisions that would make a future FIE-compatible export impossible), but do not
implement or plan it yet.

---

### X1 — Tie-breaking for equal `ranking_value`

**Why this decision is needed:**
When multiple fencers share the same `ranking_value` (most commonly 9999 for
unranked), the serpentine pool seeding algorithm requires a strict total order.
The FIE sometimes specifies "random draw" but in practice implements it as a
deterministic alphabetical sort — allowing different software to produce identical
output from the same input and making results reproducible and verifiable.

**Decision: tie-breaking method is a configurable option on the competition,
defaulting to alphabetical by last name.**

Available options (stored as `competitions.tiebreak_method`):
- `'alpha'` — alphabetical by last name, then first name *(default)*
- `'dob'` — older fencer ranked higher (used in some veteran competitions)
- `'licence'` — by licence number (fully deterministic, format-neutral)
- `'random'` — shuffled at import time; seed stored so the draw is reproducible
  if re-imported with the same file

The method is set when configuring the competition or during the import flow,
before seeds are locked. It applies whenever `ranking_value` values are equal,
not just for 9999.

---

### X2 — Import file metadata conflicts with competition settings

**Why this decision is needed:**
An import file may specify weapon, gender, or category that differs from what is
already configured on the competition in Atlas (e.g. file says Épée, competition
says Foil).

**Decision: warn the operator and require explicit confirmation before proceeding.**

The import UI shows a conflict table listing every field that differs between the
file and the competition record. The operator chooses one of:
- **Keep Atlas values** — ignore the file's metadata, import competitors only
- **Apply file values** — overwrite the competition's metadata fields with the file's
- **Abort** — cancel the import

Silent overwrite and silent ignore are both disallowed. The operator must always
make an active choice when a conflict exists.

---

### X3 — Computing `initial_seed` from `ranking_value`

**Why this decision is needed:**
`initial_seed` (the ordinal 1, 2, 3… used for FIE serpentine pool seeding) must be
derived from `ranking_value`. This can fail or be ambiguous in manual-seeding mode.

**Decision: auto-compute whenever possible; warn and block phase creation if not.**

- After import or after `fencers.ranking` copy-in: sort competitors by `ranking_value`
  ASC (ties broken by `tiebreak_method`, X1), assign `initial_seed` 1…N, mark
  `seeding_mode = 'auto'`.
- In manual mode (D4): `initial_seed` is assigned by the manager via drag-reorder
  or up/down controls. Phase creation is blocked until all active competitors have
  a unique `initial_seed`. A prominent warning remains visible until this is done.
- If auto-compute produces a partial result (some competitors have 9999, some have
  real values), auto-compute still runs — 9999 fencers sort to the bottom — but a
  warning is shown: "X fencers have no ranking and have been placed at the end.
  Review the seeding order before proceeding."

---

### X4 — Referees in the `<Arbitres>` section

**Why this decision is needed:**
The FIE fencers XML includes an `<Arbitres>` section which, when populated, lists
referees assigned to the competition. Atlas needs to decide what to do with them.

**Decision: import referees from `<Arbitres>` into the competition's available
referee pool.**

- Each referee is created as a standalone entry (same D1/D2 logic as competitors):
  no people record is created; data lives on a referee assignment record.
- They become selectable in pool strip assignments and pipeline referee scheduling.
- If a referee already exists in the people/referees table (matched by licence or
  FIE ID), they are linked rather than duplicated.
- The `<Arbitres>` section is optional; an empty section is silently ignored.

---

### X5 — Multiple file imports for the same competition

This is fully covered by **D6** (merge strategy). Importing a second file into a
competition that already has competitors triggers the diff report and merge flow.
There is no concept of a single "authoritative file" — the competition's competitor
list is the source of truth; files are updates to it.

---

### X6 — Unknown NOC codes on import

**Why this decision is needed:**
Import files may contain NOC codes not present in the Atlas NOCs table
(obscure federations, newly admitted nations, or typos).

**Decision: warn and require manual resolution, with a pre-approved exception list.**

- **Pre-approved codes** that are always accepted without intervention:
  `AIN`, `_AIN`, `AIN_` (Authorized Independent Nations — Russian/Belarusian
  athletes under neutral status). These are stored as-is; no NOC record required.
- **All other unknown codes:** the import is paused and the operator is shown a
  list of unrecognised codes. For each, they can:
  - Map it to an existing NOC in Atlas
  - Create a minimal NOC record (code + name) and continue
  - Abort the import
- Unknown codes are never silently accepted or silently dropped.

---

## Open questions

| # | Question |
|---|---|
| O1 | Accreditations (coaches, delegates): import into Atlas or ignore? Leaning ignore — no functional use in competition management. |
| O2 | `people.picture_url`: store the FIE photo URL on people records? Low priority; CDN URLs expire. |
| O3 | Engarde XML: priority format? Widely used at Belgian national events — likely needed before FIE XML in practice. |
| O4 | Should `fencers.ranking` have a label/note field so the manager knows what ranking system it refers to? (e.g. "BEL national foil 2025/2026") |
