# Format system — comparison with Engarde and FencingTime

**Atlas Competition Manager — design and analysis document**

---

## 1. Background

The `Engarde/` folder (repo root, git-ignored reference material) contains two unrelated
sets of files dropped in by the user for a comparative study, both nested under `Engarde/`
for convenience:

- `Engarde/Formules/{en,fr}/*.fta` — Engarde's own competition-formula ("formule") files,
  plus `Description_of_fta_files.txt` explaining the format.
- `Engarde/Data/*.xml` — **FencingTime** configuration files (all carry a
  `Fencing Time / By Daniel Berke` header despite the folder name): `EventTemplates.xml`
  (formula catalog), `SeedingRules.xml`, `*CsvFormats.xml`, `EventClassificationChart.xml`,
  `AuthorityList.xml`, `CountryList.xml`, `Text_*.xml`.

This document records what each program's format model looks like, how Atlas's
`formats/*.json` + `rules/*.json` system compares, and what's worth changing. It is the
companion to `docs/importing-official-data.md` (which covers entry-list import, not
competition-formula structure).

---

## 2. Engarde's `.fta` model

A formula file is a flat list of typed blocks (`classe`), each with a unique per-class
integer `cle` (key). Four `classe` types exist:

1. **`suite_tableaux`** (mandatory) — one per "stage". Key fields observed across the
   Engarde-supplied catalog:
   - `critere_constitution` — how entrants are seeded into this stage: `classement_initial`
     (by rank), `progression_naturelle` (by bracket position — repechage/placement
     sub-brackets), `classement_initial_par_groupes` (re-seed by rank *within* an injection
     group — repechage-specific)
   - `origine1` / `origine2` — input streams: `"classement_initial 1-32"`,
     `"battus-tableau A16"` (losers of a specific round), `"vainqueurs-suite B"` (overall
     winners of another stage)
   - `qualifies N` — how many exit this stage as qualified/classified vs. feed forward
   - `hasard_par_2` / `protege_debut` — randomization controls when re-seeding merged
     groups, with an escape hatch to protect the very top seeds from randomization
     (see §5 — this maps directly onto a real FIE rule)
   - `minimum` — stage doesn't activate below N entrants (e.g. a 9th-place repechage
     requires ≥17 fencers)
   - `tableaux_par_niveau` — splits the field into parallel same-size tableaux by rank
     block ("levels")

2. **`description_tableau`** (optional) — per-bracket-round overrides: `nombre_entites`,
   `destination_vainqueurs` / `destination_battus` (explicit winner/loser routing by
   tableau name), and critically `groupe_clasmt_vainqueur` / `groupe_clasmt_battus` +
   `rang_premier_vainqueur` / `rang_premier_battu` + `nb_vainqueurs_clas` / `nb_battus_clas`
   — a fully generic, round-by-round declaration of which round produces which final ranks.

3/4. **`multi_affichage`** and **`fichier_web`** — pure display/print/web-export grouping
   (which tableaux appear together on one page). No domain logic.

**Formula catalog** (24 English `.fta` files): straight DE (±bronze), pools→DE (±bronze),
two-pool-rounds ("Brazilian"), preliminary-tableau-with-exemptions-then-main-tableau (the
GP shape), all-places-fenced (from T8/T16/T32), repechage (single-cycle T32→T8, T16/T32→9th
place, and the classic 4-cycle T64→T4 épée form), "tableaux by levels" (parallel same-size
brackets by rank block), and "Division 1 / Division 2" (two independent full events run off
one ranking split).

---

## 3. FencingTime's model (`EventTemplates.xml`)

Structurally simpler than Engarde: no graph of named tableaux, just a **linear list of
`<Round>` elements**, each `pool`, `DE`, `Rep`, or `APF`, with a `Promote` clause:

- `fromPercent` / `toPercent` — a *range* (e.g. 70–80%), letting the director pick the
  exact cut within FIE-legal bounds
- `top="N"` — cut to an exact count instead of a percentage
- `minForCut` — guard: don't cut anyone if the field is below this size
- `combine` — aggregate results across pool rounds (the "Brazilian" mechanic)
- `byes` — explicit bye count feeding top seeds straight past a round
- `subtype="sharksminnows"` / `subtype="grouped"` — alternate pool-formation strategies
- DE-round `fenceTo` — stop the bracket early at N survivors (Atlas's `survivorTarget`);
  `randomizeTop` — randomize seeding among the top N when merging pool-exempts with
  bracket survivors; `fo3` — bronze bout on/off

35 named formulas ship, each a 1–4 line pipeline (e.g. `SR_GP`: pool round with 16 byes →
DE to 32 survivors → final DE of 64 — the exact GP shape Atlas already implements as
`formats/grand-prix-fie.json`).

Alongside the formula catalog, FencingTime's `Data/` folder also has:

- `SeedingRules.xml` — **named seeding strategies** tied to external point lists
  (`SeedByRankAndRating`, `SeedByTwoRanks` combining two ranking lists, `NumToProtect`
  locking top seeds against a secondary list) — richer than Atlas's flat `initial_seed`.
- `*CsvFormats.xml` — per-authority (USFA/CFF/…) configurable CSV column mappings for
  club/fencer/referee/point-rank import.
- `EventClassificationChart.xml` — placement → ranking-points conversion per event tier
  (feeds a persistent national/international ranking system).

---

## 4. Comparison with Atlas

| | Engarde | FencingTime | Atlas today |
|---|---|---|---|
| Multi-stage pipeline | graph of named tableaux | linear `Round` list | `formats/*.json` stages — matches FencingTime's shape closely |
| GP-style exempt+DE+DE | ✓ `FIE-senior-individual.fta` | ✓ `SR_GP` | ✓ `grand-prix-fie.json` — verified against real XML |
| Two-pool-round combine | n/a | ✓ `combine="1"` | ✓ `two-pool-rounds.json` (`seedingMethod: combined`) |
| Repechage | ✓ fully general via `description_tableau` | ✓ but opaque (`type="Rep"`, no params) | ✓ `repechage.fromTableau`/`reentryAt` — general enough for both classic shapes, round-trip verified |
| All-places-fenced | ✓ via classification groups | ✓ `type="APF" from="N"` | ✓ `placement.allPlacesFenced` |
| Percentage-range cut (`fromPercent`–`toPercent`) | n/a | ✓ | ✗ — `advancement.method: "percentage"` is a single value |
| `minForCut` guard | n/a | ✓ | ✗ — not implemented |
| `top_per_pool` / `minimumVictories` cut methods | n/a | partial | **documented in `rules/RULES.md` but not implemented** in `services/phases.js:408-426` — dead documentation |
| User-chosen advancement at phase-creation time | n/a | n/a (baked into formula) | **stubbed, unwired**: `rules/pool-advancement-choices.json` has literal `"?"` placeholder values; nothing in `services/formats.js` reads `choices`/`prompt` |
| "Tableaux by levels" / parallel same-size brackets | ✓ `tableaux_par_niveau` | ✓ `subtype="grouped"` | partial — `pool-level-pools.json` does this for **pools**, nothing does it for **DE** |
| Sharks-and-minnows pools | n/a | ✓ | ✗ |
| Named external seeding strategies (rating lists, protect-top-N) | n/a | ✓ `SeedingRules.xml` | ✗ — Atlas seeds purely from `initial_seed` |
| Configurable CSV import mapping per authority | n/a | ✓ | ✗ — `services/personImport.js` has one fixed column layout |
| Results/placement → ranking points | n/a | ✓ `EventClassificationChart.xml` | ✗ (no persistent ranking system — out of scope) |
| Pairwise lot-draw seeding at bracket merge (FIE o.87/o.102 — see §5) | ✓ `hasard_par_2` | ✓ `randomizeTop` | ✗ — Atlas's `buildSeedPositions` is always fully deterministic |
| Engarde/FencingTime file import or export | — | — | ✗ — only FIE start-list XML import exists (`services/fieImport.js`); zero export capability |

**Where Atlas is already ahead:** the DE rule schema (`rules/RULES-DE.md`) is more legible
than either competitor — `repechage`/`placement` as small orthogonal JSON blocks vs.
Engarde's dozen hand-authored `description_tableau` blocks per formula — and cohort-based
multi-source seeding (`formats/grand-prix-fie.json`'s `cohorts` array) is cleaner than
FencingTime's implicit `randomizeTop` merge behavior.

---

## 5. Resolved: what `hasard_par_2` / `randomizeTop` actually is (FIE Organisation Rules)

Source: FIE *Organisation Rules* (English), `https://static.fie.org/uploads/38/190670-Organisation%20rules%20ang.pdf`,
December 2025 edition. Confirmed via full-text extraction (index entry: *"Drawing lots (in
pairs): o.87, o.102"*).

**Individual events — o.87.2** (Mixed Formula A: Senior World Championships, Senior World
Cups, Grand Prix — the exact shape of `grand-prix-fie.json`):

> "The seeded fencers exempted from the preliminary phase occupy places 1–16 in this
> table, **drawing lots in pairs in the order of their official FIE classification**."

Context: o.85 exempts the top 16 ranked fencers from the preliminary phase entirely; o.87
places them into the T64 main table. Rather than deterministically mapping seed 1 → bracket
position 1, seed 2 → position 64, etc., FIE physically draws lots **in pairs**: bracket
slots that are symmetric in difficulty (the same seed-pair under `buildSeedPositions`) have
their two members assigned by lot rather than by strict seed order. This preserves the
seeding invariant (seed 2 and 3 still only meet in the semifinal, etc.) while adding a
literal randomization step at the venue. Everyone *else* in the T64 (places 17–32 = pool
exempts, places 33–64 = preliminary-DE survivors) is placed deterministically by index —
o.87.4/5 say "classified in the order of their indices," no lot drawing.

**Team events — o.102.1** (Senior/Junior Team World Cups and Zonal Championships):

> "The first four teams are placed in the direct elimination table according to the
> current official team ranking of the FIE; the remaining ranked teams will be placed in
> the table **by drawing of lots in pairs**."

So the same mechanic — pairwise lot draw among a specific top-ranked subgroup, strict
ranking elsewhere — recurs for team draws, confirming it isn't individual-only.

A separate, unrelated mechanic also appears twice: plain (non-paired) **"drawing of
lots"** for any group with no ranking basis at all — indices tied at the pool/DE cut line
(o.86.3, o.87.4), or entirely unranked teams (o.98.2, o.102.1) — which is an ordinary
tie-break, not bracket-merge randomization, and is a much smaller, unrelated gap (Atlas's
current tie-break chain ends in `initial_seed_asc`, which is deterministic but arbitrary
for genuinely unranked entrants — fine as-is).

**Verdict:** `hasard_par_2 oui` / `randomizeTop` is a real, named FIE mechanic
("drawing lots in pairs"), used for both individual (o.87) and team (o.102) events, but
**only** at the specific moment a small top-ranked, fully-exempt cohort is merged into a
larger bracket — not general-purpose bracket randomization. Atlas's `buildSeedPositions`
is always fully deterministic today, so Atlas produces a legitimate FIE-compliant
*seeding-difficulty* structure but not a byte-for-byte reproduction of an official draw
for GP/World Cup/World Championship individual events or Team World Cup/Zonal events. This
only matters if the goal is literal replication of an official FIE draw; for club/national
competitions built on `de-standard.json` it's irrelevant (Formula B and most non-elite
formulas use strict deterministic seeding — `hasard_par_2 non` — same as Atlas today).

**Implementation (2026-07-03, individual side only — see §7 for team follow-up).**
Chosen interpretation: "drawing lots in pairs in the order of their official FIE
classification" is processed as consecutive rank pairs — (rank 1, rank 2), (rank 3, rank
4), … — with a coin-flip per pair deciding which of the two gets the lower seed number.
This is deliberately *not* implemented by touching `buildSeedPositions` (too risky given
its history — see the `CLAUDE.md` warning). Instead it transforms the ranked list handed
to seeding, before seed numbers are ever assigned. This is sound because adjacent seed
numbers under `buildSeedPositions` are always siblings from the same tier split — verified
by hand for T=8 (seed pair (1,2): full mirror symmetry by construction) and for T=16
(seed pair (3,4), and the tier {5,6,7,8}: traced the chalk bracket and confirmed all four
members reach exactly the QF round before facing a top-4 seed — symmetric difficulty,
different specific opponents). Swapping within an adjacent pair changes nothing about
bracket fairness; it only changes which specific real entrant lands on which side.

Wired into `services/formats.js`'s `_resolveCohort` via an optional `pairedLotDraw: true`
flag on a cohort spec, applied only to `grand-prix-fie.json`'s `initial_exempt` cohort
(o.87.2's 16 preliminary-exempt seeds) — `pool_exempt` and `de_survivors` stay
deterministic, matching o.87.4/5 ("classified in the order of their indices," no lots).
The draw happens once, at DE-phase creation, the same moment FIE's real draw is finalized
(o.87.6: "in the presence of the Directoire Technique President") — Atlas has no separate
"draw" UI step, so phase creation *is* that moment.

---

## 6. FIE formula coverage — functional capability vs. defined presets

FIE defines individual competitions as three formulas (o.66) plus team formulas. Checked
each against both "can the engine represent this" and "is there a ready-made preset":

| Formula | FIE rule | Engine capable? | Preset exists? |
|---|---|---|---|
| **Mixed Formula A** (Senior Worlds/World Cup/GP: pools → prelim DE → main DE) | o.83-88 | ✓ | ✓ `formats/grand-prix-fie.json` |
| **Mixed Formula B** (Junior/Cadet Worlds, Cadet/Junior WC, Zonals: pools → single DE straight through, **no bronze bout**, shared 3rd) | o.89-94 | ✓ (`formats/pool-de.json` + `rules/de-no-bronze.json` both exist) | was ✗, now ✓ `formats/mixed-formula-b.json` (added 2026-07-03) — `pool-de.json` itself still wires to `de-standard.json` (bronze bout) and is left as-is since it's used elsewhere as a generic pool+DE preset |
| **Formula C** (Olympic Games) | o.95 | n/a | n/a — ad hoc, set by Executive Committee/IOC per Games, not a generic rule to encode. Correctly out of scope. |
| **Team World Championships** (straight DE by team ranking, no pools; places 1-16 all fought for; 17+ by initial bracket position) | o.97-98 | Partially — bracket seeding and "17th+ ranked by initial position" default already match (`services/results.js`'s "others by seed" behavior is exactly o.98.3) | ✗ — `rules/team-fie-standard.json` has no `repechage`/`allPlacesFenced`-equivalent field; individual DE has that richness (`rules/RULES-DE.md`), team DE doesn't |
| **Team World Cup/Zonal** (relay match, top 4 by ranking + rest by paired lot draw) | o.99-102 | Relay bout order ✓ **verified byte-exact** against o.99.3 (`rules/team-fie-standard.json`'s `relays` array reproduces the o.99.3 table pair for pair) | pairwise lot-draw seeding not yet implemented for teams — see §7 |
| **Veterans individual** (100% pool advancement — "no fencer is eliminated after pools"; poule-unique below 10; merge into next age category below 6; two-championship cumulative ranking-points seeding) | o.114-118 | Not modeled | ✗ — low priority unless veterans events become a target |
| **Veterans team** (own placement-table structure, similar in spirit to individual repechage) | o.119 | Same gap as Team Worlds above | ✗ |

**Note fixed in `CLAUDE.md` while researching this:** its "Out of scope for MVP" table still
listed `Team competitions | Out of scope`, but `services/teamMatches.js`,
`services/teamPhases.js`, `public/team-de.html`/`team-match.html`/`team-results.html`, and
`rules/team-fie-standard.json` all show team competitions are built to a meaningful
degree — that line was stale and has been corrected.

---

## 7. Other rules checked against the codebase

**Nationality/club pool separation (o.68.2) — confirmed correct.**
`lib/poolFormation.js:142-176` (`serpentineAssignWithSeparation`) implements the exact
algorithm: cascade the next non-conflicting fencer up in the queue, and if no fencer fits,
"remain in the original pool" — literally what the rule says (the code even comments
`FIE t.38`). Not a gap.

**Nationality-conflict bout-order tables (o.70) — confirmed correct, more thoroughly than
expected.** o.70 mandates entirely different bout sequences (not just reordering) when a
pool has 2/3/4 fencers sharing a nationality, with exact published tables for pools of 6
and 7. Byte-compared `lib/boutOrder.js`'s `TRIO_7`, `QUARTET_6`, and the "3-of-nationality-A"
table against the PDF's o.70.3.b/o.70.4.b tables (reading the PDF's multi-column layout
column-major — verified as the right convention via the next point) — all three matched
exactly, position for position, bout for bout.

**`STANDARD[6]` (default pool-of-6 bout order, no conflicts) — FIXED 2026-07-04, after
three back-and-forth rounds.** Final state: `lib/boutOrder.js`'s `STANDARD[6]` was wrong
and has been corrected; `TRIO_6` (previously an alias to `STANDARD[6]`) is now its own
explicit table holding the old value, which remains correct for the trio-conflict case.
The investigation, in order, because the reasoning matters more than the conclusion here:

1. **First pass:** cross-referencing the general FIE Organisation Rules PDF's condensed
   multi-column pool-of-6 table via a column-major reading (validated on several other
   tables) gave a sequence different from `STANDARD[6]` — flagged as a likely bug, not
   fixed, pending real data.
2. **Second pass:** found `lib/boutOrder.js`'s own header comment already cited a specific
   primary source — "FIE Order of Bouts — Individual Competitions, Revised January 2004"
   (Sheryl Eberhardt) — archived it at `docs/fie-order-of-bouts-2004.pdf`. Every table in
   `lib/boutOrder.js`, including `STANDARD[6]`, matched it byte-for-byte, including the
   "3 teammates" pool-of-6 section reusing the identical table as the plain case (matching
   the `TRIO_6 = STANDARD[6]` alias). Retracted the bug finding as a false alarm from
   misreading the harder-to-parse Organisation Rules figure.
3. **Third pass:** the user supplied 10 real competition results XMLs (Fencing Time,
   Engarde). Real Fencing-Time pool-of-6 output matched *neither* candidate table, and
   wasn't even self-consistent file-to-file — interesting, but didn't move the verdict
   either way (a vendor's own behavior isn't evidence about what the rule says). Two
   further Engarde files contained only pools of 7 (confirming `STANDARD[7]` a second way,
   no new pool-of-6 data point).
4. **Fourth pass, decisive:** the user added one more file — a real FIE World Cup (Lion of
   Bonn 2019, Ophardt-tagged export). Its pool-of-6 bouts matched, bout for bout, the
   *original* column-major reading from step 1 — i.e. a **third** candidate table,
   different from both the January-2004 document's value and from Fencing Time's output.
   With a real elite FIE competition and the current Organisation Rules document now
   independently agreeing, and the January-2004 document having zero real-competition
   confirmations across all 10 files checked, the evidence flipped: that January-2004
   document is very likely a USA Fencing domestic reference (hosted on a US sports-league
   CDN, US author) rather than the literal FIE-international standard, and it happens to
   share its trio-conflict table with its plain no-conflict table — which is where the
   original false-alarm-retraction in step 2 went wrong.

**Final tables** (all in `lib/boutOrder.js`):

| Table | Value | Evidence |
|---|---|---|
| `STANDARD[6]` (plain, no conflict) | `1-2,4-3,6-5,3-1,2-6,5-4,1-6,3-5,4-2,5-1,6-4,2-3,1-4,5-2,3-6` | Real Lion of Bonn 2019 World Cup (Ophardt) data, an independent real Engarde(PRO) export (Terrassa 2018, 3 clean pools, all identical), *and* column-major reading of the current (Dec 2025) Organisation Rules PDF — three agreeing sources |
| `TRIO_6` (3 teammates) | `1-2,4-5,2-3,5-6,3-1,6-4,2-5,1-4,5-3,1-6,4-2,3-6,5-1,3-4,6-2` | January-2004 document (both its plain and trio sections use this); current Organisation Rules' o.70.3.b trio table (column-major) |
| `STANDARD[7]`, `PAIRS_6`, `QUARTET_6`, `TRIO_7`, `STANDARD[8]`/`[12]` | unchanged | Byte-verified against the January-2004 document *and* real competition XML from 3 independent vendors (Fencing Time, Engarde, plus the Lion of Bonn export) — no discrepancies found anywhere for these |

**Lesson, properly stated this time:** a single document — however authoritative-looking,
however well it matches the code's own existing citation — is not enough when a table like
this has already been wrong once. What actually closed it was two *independent* sources
converging (real elite-competition data + the current official document via a
consistently-validated reading method), against a document with zero real-world
confirmations despite checking 10 real files. Documented provenance (who hosts it, who
wrote it) matters as much as whether it matches the code.

**Why trust column-major at all, independent of any vendor?** The reading convention
itself was never actually ambiguous — it's provable from the no-rest rule alone, no vendor
data needed. Row-major reading of the *same* multi-column table produces bouts where one
fencer appears in two consecutive slots (zero rest, physically impossible as a real
schedule): row-major on the plain pool-of-6 table produces 6 such violations (e.g. fencer 4
in bout 2 then immediately bout 3); row-major on the pool-of-7 table produces 10, starting
at bout 1→2. Column-major produces zero violations on both. So the *only* question was
ever "which document's table content is authoritative" (the January-2004 document vs. the
current Organisation Rules PDF disagree on pool-of-6 specifically), never "how do I parse
a multi-column table."

**Final vendor cross-check (three independent sources, all real competition data):**

| Vendor | Pool-of-7 | Pool-of-6 |
|---|---|---|
| Fencing Time (v4.6.0/4.6.1/4.7.0) | matches `STANDARD[7]` | different sequence, and not even self-consistent file-to-file |
| Ophardt (Lion of Bonn 2019 WC) | matches `STANDARD[7]` | matches `STANDARD[6]` (post-fix) |
| Engarde(PRO) (Terrassa 2018 + 3 other individual events) | matches `STANDARD[7]` | matches `STANDARD[6]` (post-fix) — 3 clean pools, all identical |

Two independent vendors (Engarde, Ophardt) agree with each other and with Atlas exactly.
Fencing Time is the sole outlier on pool-of-6, and disagrees with itself pool-to-pool.

**Still an open, non-blocking curiosity (user's personal follow-up, not an Atlas action
item):** why does real Fencing Time output for pool-of-6 match neither table, and isn't
even self-consistent within one Fencing-Time file, while its pool-of-7 output is byte-exact
correct, and two other independent vendors agree with each other and with Atlas? The user
intends to ask Fencing Time's author (Daniel Berke) directly.

**Checked one hypothesis for the Fencing Time inconsistency: an operator affiliation
mistake.** Within `193989-RESULTS_SRMF_2026-142.xml`, poule 22 used the "default" Fencing
Time sequence while poules 31/43 used a visibly different one — one that opens with
`(1,4),(2,5),(3,6)`, the same pairing convention as Atlas's own `PAIRS_6` (official
2/3-pair teammate-conflict table), suggesting *some* conflict-handling logic fired for
those two pools specifically. Checked all fencers in poules 22/31/43 for nation and
licence-number matches — no duplicates, no near-misses, nothing that would explain a
nationality conflict. Inconclusive rather than resolved: this Fencing Time export has no
`Club` field at all, so a club-level trigger (plausible, given Fencing Time is US-domestic-
focused software) can't be checked from this data. Folded into the question for Daniel
Berke above.

**Resulting policy decision (2026-07-05): FIE-format rule files must use
`separation: ["nationality"]` only, never `"club"`.** This is the same `separation` array
in `poolFormation` that decides both which fencers to keep apart across pools *and*
(`lib/boutOrder.js`'s `findTeammateGroups`) which pools get FIE's special
nationality-conflict bout-order tables (o.70). Those tables are officially defined for
nationality conflicts only — o.70 says "several fencers from the same **country**," never
club. If `"club"` is in the array and two fencers who share a club but not a nationality
land in the same pool, Atlas would silently apply the o.70 special tables to a pool o.70
was never written for — a real, undetectable-from-the-data deviation from what an actual
FIE-sanctioned event would produce, of exactly the kind that made the Fencing Time
inconsistency above hard to fully explain. `rules/pool-standard.json` and
`rules/level-pools.json` (the two shipped rule files with a `separation` field) were both
`["nationality", "club"]` and are now `["nationality"]`. `"club"` remains a supported,
documented option (`rules/RULES.md`) for genuinely non-FIE domestic/club-level rule files
that want it deliberately.

**Pool sheet position "decided by lots" (o.68.3) — minor, not done.** The rule says the
position number (1..N) a fencer occupies on the pool sheet — which drives bout *order*,
not who-fences-whom — is drawn by lot when no nationality-conflict constraint overrides
it. Atlas currently assigns position by seed order (serpentine array order = pool-sheet
position). Doesn't change any outcome or pairing, only which fencer gets which rest-gap
pattern. Connects to the existing note in `CLAUDE.md`'s Scoresheets section that
`pool_slot` isn't stored yet.

**Pool size floor (o.67.1: "no case may pools be fewer than 6") — a design question, not
clearly a bug.** `rules/pool-standard.json`'s `allowedSizes: [7,6,5]` permits a 5-fencer
pool as a fallback; strict elite-competition rules never intend that (they rebalance
instead). May be an intentional flexibility choice since Atlas also serves small club
events — worth a conscious decision rather than a silent fix.

**Team relay bout order (o.99.3) — confirmed correct**, byte-exact match against
`rules/team-fie-standard.json`'s `relays` array.

**Tie-break "drawing of lots" for genuinely unranked entrants** (o.86.3/87.4 individual,
o.98.2/102.1 team) — Atlas's tie-break chain ends deterministically at `initial_seed_asc`
rather than an actual lot draw. Functionally fine (still separates them), just not
literally randomized. Not worth chasing.

---

## 8. Proposed improvements, prioritized

1. **Fix the two documentation/implementation mismatches.** Either implement
   `minimumVictories` and `top_per_pool` in `services/phases.js`, or strike them from
   `rules/RULES.md`. Either delete `rules/pool-advancement-choices.json` (dead stub with
   `"?"` placeholders) or wire `choices`/`prompt` into phase creation. Not a new feature —
   existing docs currently promise behavior that silently doesn't happen.
2. **Add `minForCut` to the pool `advancement` schema.** Small, low-risk, matches
   FencingTime's guard exactly, prevents a degenerate all-or-nothing cut on a small field.
3. **Percentage range (`fromPercent`/`toPercent`).** FIE rules often specify a range
   (e.g. o.86.1: "20%–30%"); letting the director land on a round number within the legal
   range is a real, moderate-effort win.
4. **"Tableaux by levels" for DE** (Engarde `tableaux_par_niveau` / FencingTime
   `subtype="grouped"`). Splits the field into parallel same-size independent DE brackets
   by rank block. Not expressible in Atlas today; real gap for club/regional events.
5. ~~**Pairwise lot-draw seeding** (§5).~~ **DONE 2026-07-03 for the individual side**
   (`grand-prix-fie.json`'s `initial_exempt` cohort, via `services/formats.js`'s
   `pairedLotDraw` cohort flag). **Not done for team draws** (o.102.1) — team seeding goes
   through a completely different path (`services/teamPhases.js` reads a manually-assigned
   `teams.seed` column directly, no cohort/format-resolution concept at all), so this needs
   its own design pass rather than reusing the individual-side code. Worth doing given it's
   the same FIE mechanic, just needs someone to trace where `teams.seed` actually gets set
   first.
6. ~~**Mixed Formula B preset.**~~ **DONE 2026-07-03** — `formats/mixed-formula-b.json`.
7. **Team DE placement/repechage richness** (§6) — `rules/team-fie-standard.json` has no
   equivalent of individual DE's `repechage`/`allPlacesFenced` fields, so Team World
   Championships' "all places to 16th fought for" (o.98.1) can't be expressed. Same shape
   of work as the individual DE rule schema, applied to teams.
8. **Sharks-and-minnows pool formation.** Niche (US-specific), low priority absent a
   concrete need.
9. **Engarde/FencingTime import.** Closes the loop with `docs/importing-official-data.md`'s
   "Known formats" table (currently FIE XML only). Real practical win — clubs migrating off
   either program could bring entry lists straight in. Export is a heavier lift (would need
   to emit each program's native XML/CSV well enough to re-import) and lower value than
   import unless the goal is specifically interoperability with tournaments still run in
   Engarde/FencingTime alongside Atlas.
10. **External/combined seeding lists** (FencingTime's `SeedingRules.xml`) and
    **ranking-points classification** are real features but assume Atlas becomes a *ranking
    authority* across events, not just a single-event CMS — a materially bigger scope change
    than anything else here. Treat as a separate future decision, not bundled into this pass.
11. ~~**`STANDARD[6]` bout-order table.**~~ **FIXED 2026-07-04**, after an initial false
    "no bug" retraction — real FIE World Cup data (Lion of Bonn 2019) settled it in favor
    of the original suspicion. `TRIO_6` is now its own explicit table (was aliased to
    `STANDARD[6]`). See §7 for the full four-round investigation.
12. **Pool-sheet position by lot** (o.68.3, §7) and **pool size floor** (o.67.1, §7) —
    minor/cosmetic, informational for now.
13. ~~**FIE-format rule files using `separation: ["nationality", "club"]`.**~~ **FIXED
    2026-07-05.** Club membership triggering FIE's nationality-specific o.70 special
    bout-order tables was a real, silent-deviation risk, not just a formation-time
    preference — see §7. `pool-standard.json` and `level-pools.json` now use
    `["nationality"]` only; `"club"` stays available for non-FIE rule files.

Remaining open items: 1, 2, 3, 4, 7, 8, 9, 10, 12. Item 5 is done for the individual side
(team side still open, folded into item 5's text above). Items 6, 11, and 13 are done.

---

## 9. Format catalog: an alias mechanism, not duplicated shape files (2026-07-05)

**Ask:** an entry in the format picker for every FIE competition type (Team/Individual ×
World Cup/Grand Prix/Zonal/World Championships × Senior/Junior/Cadet/Veteran) plus the
common Engarde/FencingTime club formats already catalogued in §2-3, navigable without a
30-item flat dropdown, with a scope flag to filter "pure FIE" vs. everything else, and
continued support for self-defined formats.

**Mechanism — two layers, not one.** Before this, `formats/*.json` conflated two things:
the stage-pipeline *shape* and the *identity* shown in the picker. Many named FIE
competitions are explicitly the same shape by rule — o.83 states Mixed Formula A "is used
for... Senior World Championships as well as... Senior World Cup... and Grand Prix,"
three competitions, one shape — so duplicating the shape file per name would mean any
future fix has to be applied N times. Split it instead:
- **Shapes**: `formats/*.json`, mechanism and ids unchanged (no renames — avoids touching
  `competitions.format_id`, a plain TEXT column with no FK, for anything already using a
  shape id directly).
- **Catalog**: new `formats/catalog.json`, a flat array of small tagged entries
  (`id`, `label`, `shape`, `scope`, `eventType`, `tier`, `ageCategory`, `ruleRefs`, `note`,
  `paramOverrides`). Multiple entries may point at the same shape — e.g. three entries
  ("World Championships — Individual", "World Cup — Individual", "Grand Prix —
  Individual") all alias `grand-prix-fie`. `paramOverrides` lets an entry fix a shape's
  exposed param default without a new shape file (Veterans forces `pool_advancement_pct`
  to 100 on the generic `pool-de` shape this way).

`services/formats.js`: `loadFormat(id)` checks the catalog first; on a hit, resolves the
shape and merges `paramOverrides` into the params' `default`. On a miss, falls back to the
pre-catalog direct-file lookup unchanged — so every existing `format_id` (e.g.
`"grand-prix-fie"`, `"two-pool-rounds"`) keeps resolving exactly as before, no migration.
`listFormats()` returns catalog entries plus a synthesized `scope: "custom"` entry for any
shape file with no catalog entry pointing at it — hand-author a new `formats/*.json` shape
with no catalog entry and it shows up automatically, unchanged "self-defined formats" path.

**Bug found and fixed while populating content:** `grand-prix-fie.json`'s final stage used
`de-standard.json` (bronze bout), but o.88 says Mixed Formula A has none — semifinal
losers share 3rd. Confirmed against real data already in `docs/GP/`:
`201473-RESULTS_SRMF_2026-145.xml`'s `Tableau ID="B4"` (semifinals, 2 bouts) is followed
directly by `Tableau ID="B2"` (final, 1 bout) — no 3rd-place bout in the real bracket at
all. Fixed to `de-no-bronze.json`. Since three new catalog entries alias this exact shape,
this mattered more than it would have in isolation.

**Discovered while scoping team entries: team phases have no format/rule picker at all.**
The plan called for "Team World Cup"/"Team Zonal Championships" catalog entries aliasing
`team-fie-standard`, but team phase creation doesn't go through `services/formats.js` —
`public/competition-detail.html` hardcodes `rule_doc: 'team-fie-standard.json'` directly
(the multi-stage format system exists for individual pool→DE pipelines; team phases are a
single `TeamPhase.create(competitionId, ruleDoc)` call with no stage concept, since teams
are pre-seeded via `teams.seed`, not fenced through pools). Adding catalog entries for
something with no selection mechanism would be cosmetic. **Dropped from this pass** —
distinct from the already-tracked "team DE placement richness" gap (§6): this one is
"there's no picker at all," that one is "the one rule file that exists can't express
all-places-fenced." Both need addressing before Team World Cup/Zonal/Worlds can be
properly catalogued.

**Content shipped — 18 catalog entries, 5 new shape files** (`pool-de-repechage-t32-t8`,
`pool-de-repechage-t64-t4`, `pool-de-apf-t16`, `de-only-bronze`, `de-only-no-bronze`; all
follow `mixed-formula-b.json`'s existing pattern — reuse `pool-standard.json` for the pool
stage, point the final DE stage at an existing, already-verified DE rule file):

| Entries | Shape | Basis |
|---|---|---|
| World Championships / World Cup / Grand Prix — Senior Individual | `grand-prix-fie` (post-fix) | o.83-88 |
| World Championships Junior/Cadet, World Cup Junior/Cadet, Zonal Championships — Individual | `mixed-formula-b` | o.89-94 |
| Veterans — Individual | `pool-de` + `paramOverrides` | o.114-118 (approximation, see entry `note`) |
| Pools + DE (choose %), Two Pool Rounds ×2, Level Pools, Pools+repechage ×2, Pools+APF-T16, Straight DE ×2 | existing/new shapes | non-FIE, `scope: "club"` |

**Explicitly deferred, no entry added** (documented, not silently missing): Team World
Cup/Zonal/World Championships (needs both the picker above and, for Worlds specifically,
all-places-fenced richness in `rules/team-fie-standard.json`), Veterans Team, "tableaux by
levels" DE (parallel same-size brackets), sharks-and-minnows pools, Olympic Formula C
(ad hoc per Games, not a generic rule to encode).

**Verified 2026-07-05:** real end-to-end bracket builds (fresh throwaway competitions,
20 competitors, cleaned up after) for all three new pools+DE shapes plus the Veterans
override — zero stuck bouts, full completion in every case; Veterans confirmed
`advanced: 20, eliminated: 0`. Backward compatibility confirmed against real existing
competitions in the dev DB using pre-catalog `format_id` values directly (`grand-prix-fie`,
`two-pool-rounds`, `two-pool-rounds-round2`, `pool-level-pools`) — all resolve unchanged.
The picker UI's new grouping/filter logic verified in isolation (correct groups both with
and without the FIE-only filter) but not visually screenshotted — no headless browser
available in this environment.

**UI:** `public/competition-detail.html`'s format picker gained an "Official FIE formats
only" checkbox (default on) and `<optgroup>` grouping by `tier` (or age category where
tier is null, e.g. Veterans) within the filtered set; non-FIE entries group under "Club /
Regional." A selected entry's `note` (e.g. Grand Prix's fixed-70%-vs-70-80%-range caveat)
displays inline. `routes/formats.js` needed no changes — it already just passes through
`listFormats()`.
