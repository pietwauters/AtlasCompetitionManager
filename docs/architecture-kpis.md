# Architecture & code-quality KPIs

Reference list for periodic architecture reviews (see CLAUDE.md's "Architecture / code
hygiene" section for the history of what's already been found/fixed). Split into two
kinds, because they need two different processes:

- **Mechanical** — checked automatically by `scripts/check-architecture.sh`. Run this
  before committing any change under `services/`, `routes/`, `lib/`, or `public/*.html`.
  It's cheap (sub-second, grep/awk-based) so there's no excuse to skip it.
- **Judgment-based** — can't be reduced to a script; need an actual read of the file(s).
  Reserved for periodic, explicitly-triggered reviews (like the 2026-07-28 one), not
  every commit — reading and reasoning about a whole file for every small change would
  be disproportionate.

Written down after the 2026-07-28 architecture review, whose findings motivated most of
these checks directly — several are here specifically because they're what that review
(and the script's own first run) actually caught.

## Mechanical (scripted)

1. **File size** — thresholds: `services/`, `routes/`, `lib/`, and `public/js/` JS
   files warn at 500 lines, flag as a god-file candidate at 800; `public/*.html` warn
   at 1000, flag at 1500 (HTML files run larger due to bundled markup/CSS/JS, hence
   the higher bar). Rationale: `pipeline.js`/`formats.js`/`phases.js`/`opp2.html` all
   crossed well past these thresholds before anyone noticed — the point is to catch it
   while it's still cheap to split, not after. `public/js/` was added to this check
   2026-07-29, the same day `opp2.html`'s split produced six new files there — the
   original check only scanned `services/routes/lib` for JS, so those new files would
   otherwise have been invisible to the very tool built to catch this class of drift.
2. **Prepared statements must be module-level** (CLAUDE.md hard rule) — any
   `db.prepare()` call indented (i.e. inside a function/method body) instead of a
   top-level `const stmtX = db.prepare(...)` is a violation. ~16x slower under load,
   per the incident that made this a hard rule in the first place.
3. **Raw SQL confined to services/** — `routes/*.js` must never call `db.prepare()`
   directly; a route should always call a service function. Found by the script's
   first real run (2026-07-28): `routes/opp2.js`, `routes/pools.js`,
   `routes/teamMatches.js`, `routes/tournaments.js` all violate this — not previously
   called out explicitly by the architecture review's own manual pass.
4. **Schema changes confined to `db/migrations/`** — no `ALTER TABLE` anywhere in
   `services/`, `routes/`, or `lib/`; a schema change is always a new numbered
   migration file, never mutated in application code.
5. **`'use strict'` present** as the first line of every file in `services/`,
   `routes/`, `lib/`.
6. **Duplicate function/method names within one file** — a cheap proxy for "this file
   has grown large enough that nobody notices things get redefined." Caught a real,
   verbatim duplicate (`opp2.html`'s `pendingSlotCount`, defined at both line ~1173 and
   ~1997) on the script's first run — since fixed by the 2026-07-29 `opp2.html` split
   (the duplicate simply doesn't exist anymore; `public/js/*.js` is now scanned here
   too, alongside `public/*.html`).
7. **Circular requires / layering** (`scripts/check-circular-requires.js`) — no cycle
   anywhere in the `services/routes/lib` require graph, and `services/`/`lib/` must
   never require anything under `routes/`. A file requiring itself (a lazy
   self-reference inside a function body, safe because Node's module cache already has
   the fully-assigned exports by call time — see `services/teamMatches.js:493`) is
   excluded as a known-benign idiom, not flagged.

## Judgment-based (periodic review only)

8. **Domain cohesion** — does each file own one clear domain concept, or has it become
   a container of loosely related features added by accretion? (`pipeline.js` bundling
   slot CRUD + bout-cursor state machine + DE partition math + officiating roster +
   kiosk resolution is the reference example of what this looks like once it's bad.)
9. **Side-effect transparency** — do functions named after one table silently write
   another (e.g. `addSlot`/`markDone`/`updateSlot` touching `pools`/`strips` beyond
   `pipeline_slots`)? If the side effect is real and intentional, is it documented at
   the call site or in a module comment, or does it just have to be discovered by
   reading the implementation?
10. **Transaction correctness** — is every multi-write sequence that must succeed or
    fail as a unit wrapped in `db.transaction()`? (CLAUDE.md hard rule; not mechanically
    checkable in general, since "belongs together" is a semantic judgment about the
    surrounding writes, not a syntactic pattern.)
11. **SSE write safety** — is every `res.write()` in an `emit()`/heartbeat loop guarded
    with `try/catch`? (Also a CLAUDE.md hard rule, same reason it's not scriptable —
    telling a "write that needs the guard" from an unrelated one requires context.)
12. **Filesystem-read caching** — are `readFileSync`/`existsSync`/`JSON.parse` calls
    reachable from a request path cached at module level, not re-read per request?
13. **Duplicated algorithms across files** — the same logic re-implemented in two
    places that can silently drift (the `_combinedSeeding` bug: `phases.js` and
    `formats.js` had near-identical copies, and only one had the `checked_in=1`
    filter). Not mechanically detectable in general — would need real semantic diffing,
    not just text matching — so this stays a "does this look familiar" read during
    review.
14. **Verification before "done"** — was a new/changed function actually exercised
    (a real ad-hoc test script, or genuine use) before being reported as complete? Per
    [[feedback_scope_cuts_need_confirmation]] — an untested "edge case" branch left
    silently unfixed once already caused a real user-facing gap (the presence-gate
    format-driven-path incident).
15. **Documentation currency** — does CLAUDE.md / memory describe what was actually
    built and verified, not what was intended or assumed? Re-check when in doubt rather
    than trusting a stale note (per the memory system's own "verify before
    recommending" guidance).

## Process

- Run `./scripts/check-architecture.sh` before any commit touching `services/`,
  `routes/`, `lib/`, or `public/*.html`; report new warnings/failures rather than
  silently fixing or silently ignoring them.
- If a file crosses a size threshold *during* an unrelated feature commit, flag it and
  ask whether to split now or defer — don't let it accumulate quietly until an
  explicit review is requested.
- The judgment-based list (8-15) is for periodic, explicitly-triggered reviews, not
  every commit.
