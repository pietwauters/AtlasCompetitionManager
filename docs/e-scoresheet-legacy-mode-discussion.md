# e-Scoresheet legacy/no-apparatus mode — discussion, paused 2026-07-15

**Status: paused mid-design, pending reconsideration by the user. Nothing implemented.
Non-normative — a working document, not a spec.**

## 1. The original ask

When a physical scoring apparatus isn't connected (or doesn't exist for a given piste),
having an e-scoresheet linked to the CMS should still make sense as a fallback. Needed
capabilities, as stated:

- Increment or correct scores
- Assign cards outright (not just record the *reason* for a card someone else already
  gave)
- Assign priority (P-card / coin toss) and log it
- Manually activate and end a specific match
- Retrieve a slot (pool or DE) — i.e. know what's next without an apparatus driving it

## 2. What already exists (grounding facts, verified against the code 2026-07-15)

- **Manual score entry already exists, independent of any apparatus.**
  `PATCH /api/bouts/:id` (`routes/bouts.js`, `Bout.updateScore` in `services/bouts.js`)
  is exactly what `pool.html`/`de.html` already call for a director scoring by hand.
  Gated by `writeOnly('director')` — a real Atlas session. Zero §23.4 correct-ending
  validation — accepts whatever `left_score`/`right_score`/`winner_id` is submitted.
- **Cards can only ever be created one way today.** `CardReason.record()`
  (`services/cardReasons.js`) is called from exactly one place:
  `lib/opp2Client.js`'s `detectCards()`, which diffs successive `apparatus/score`
  payloads. There is **no manual "assign a card" path anywhere** — not in the director's
  own web UI, not via any REST endpoint. `routes/opp2.js` only exposes a read (`GET
  /piste/:pisteId/card-reasons`).
- **Priority isn't persisted anywhere.** It exists only as a transient field
  (`"N"`/`"L"`/`"R"`) inside the `apparatus/score` / `software/score` MQTT payload,
  used in-memory by `lib/opp2Client.js` to gate the §23.4 ACK/NAK decision, then
  discarded. `bouts` has no priority column.
- **The e-scoresheet is MQTT-only and unauthenticated at the Atlas level.** A Tier B
  broker credential (see `docs/e-scoresheet-standalone-design.md` §4.3), no Atlas user
  session. It's read-only display + card-*reason*-annotation only — never a publisher
  of score/control/fencers.
- **BEGIN/NEXT/PREV/END and pipeline walking are apparatus-`control`-driven**,
  handled in `lib/opp2Client.js`, assuming a physical apparatus originates the
  `control` messages.
- This directly revives the three sub-problems already flagged as open (but never
  designed) in `docs/e-scoresheet-standalone-design.md` §5: offline bundle/pre-round
  export, local §23.4 enforcement when the CMS is unreachable, and stale-replay
  reconciliation on reconnect.

## 3. Decision points explored this session

Worked through as a series of forks — recorded here in case the conclusions still hold
once the reframing in §4 is resolved, but **do not treat these as final** until this
whole document is revisited.

| Axis | Decision | Reasoning |
|---|---|---|
| Authorization | Real Atlas login on the device (PIN, referee/director role) | Reuses the existing session/role system as-is; no new auth model needed |
| Activation trigger | Fallback only when apparatus is absent, not a standing parallel capability | Matches the "scoring devices not connected" framing; avoids needing a live-vs-manual precedence/arbitration rule |
| Where it lives | Extend the standalone e-scoresheet PWA, not `public/scoresheet.html` | Keeps it inside the OPP2/pairing ecosystem vision, even though extending the existing server-rendered scoresheet would have been the smaller/more pragmatic lift |
| DE vs pools | Pools only for this pass | DE needs Atlas's tableau/winner-advancement logic (`routeBoutResult`) duplicated client-side to keep working blind past round 1 — substantially bigger |
| Pipeline scope while offline | Frozen snapshot for one piste, pre-fetched before going offline | Bounded, cacheable; any pipeline reassignment mid-outage is a director's problem to reconcile afterward, not something the device can resolve blind |
| §23.4 correct-ending | Trust the referee, no local enforcement | Matches the *existing* manual-scoring precedent (`PATCH /api/bouts/:id` already has zero correct-ending validation) — priority still gets recorded as data, just not gate-enforced |
| Reconnect conflicts | Flag for a human, never auto-merge | Safe default — never silently discard a legitimate result from either source |
| Transport (tentative, not confirmed) | ~~Direct REST calls to Atlas for the sync/flush path~~ — **wrong, corrected 2026-07-16, see §5** | Once a local write-queue exists, the original "REST is fragile to network loss" objection is moot — the queue absorbs it regardless of transport. Building a virtual-apparatus OPP2 state machine would re-add exactly the clock/correct-ending machinery just agreed to skip. *(Reasoning about the queue still holds — the conclusion of "so use Atlas's own REST API" doesn't, per §5.)* |

## 4. The reframing that paused this (2026-07-15)

The user's objection, verbatim in spirit: **there is a fundamental, qualitative
difference between brief network instability and no connection to the broker for an
entire bout or pool.**

- **Brief instability, otherwise connected:** this is exactly where OPP2 earns its
  keep — real-time, time-accurate data (live clock, live score, live cards) flowing
  between apparatus/CMS/scoresheet/display. A persistent MQTT connection with
  reconnect + QoS 1 already handles this reasonably well. Worth engineering resilience
  for, because there's a real, distinctive capability being protected.
- **Sustained loss for a whole bout/pool:** in this regime, **OPP2 has nothing to
  offer** — there's no real-time data to be time-accurate about, since nothing is
  live. Trying to preserve OPP2 semantics (or build a local approximation of them)
  during this window is solving the wrong problem. The honest answer for this case is
  a much simpler **offline replacement for the paper scoresheet, synchronizing at
  exactly two points** (start of pool/bout, end of pool/bout) — not a scaled-down
  OPP2 client. This is already prior art: existing systems like **FencingTime** handle
  this today by exposing a REST API for exactly this two-sync-point pattern, with no
  attempt at a live protocol underneath.

**Implication, not yet resolved:** the "full offline, sustained-outage" design this
session converged toward (§3, local IndexedDB queue, frozen pipeline snapshot, etc.)
may have been solving too broad a problem by treating both failure regimes as one
continuum. The likely correct shape is probably **two genuinely separate modes**
rather than one offline-resilient design:

1. **Live/connected mode** — the new manual-scoring/cards/priority/activate-end
   capabilities (§1), still riding on MQTT/OPP2, resilient to brief blips only (no
   sustained-outage engineering needed here at all).
2. **A separate "digital paper scoresheet" mode** for genuine, sustained
   disconnection — two sync points only (fetch the pool/bout assignment at the start,
   push final results at the end), no attempt at real-time semantics in between, no
   OPP2 involvement during the disconnected window at all.

Whether mode 2 is even in scope for the standalone e-scoresheet PWA specifically
(vs. being its own, much smaller tool) is itself an open question again now — §3's
"where it lives" conclusion was reached before this reframing, under the assumption
that offline resilience was one problem, not two.

## 5. Correction (2026-07-16): the sync points must be OPP2 too, not Atlas REST

The transport recommendation in §3 was wrong, and for a reason that goes to the root of
this whole project, not just this feature: **it proposed calling Atlas's own REST API
for the mode-2 sync points, which means only an Atlas-specific e-scoresheet could ever
implement mode 2.** That directly violates the ecosystem-independence principle this
project holds everywhere else (see CLAUDE.md's "OPP2 design principle" section — no
Atlas internals in payloads, any compliant CMS/display must interoperate without
knowing anything about Atlas). A PWA or non-PWA e-scoresheet built against the spec
should be able to run mode 2 against *any* OPP2-compliant CMS — not just Atlas. Baking
the sync exchange into a private REST API means every CMS implementer needs their own
bespoke e-scoresheet integration, exactly the fragmentation OPP2 exists to prevent.

**The fix does not mean abandoning the two-sync-point idea — it means the sync points
themselves must be expressed as standardized OPP2 messages, not raw REST calls to
Atlas.** MQTT doesn't require a continuously-live connection to be "OPP2" — the
e-scoresheet can connect briefly, do the pull, disconnect, score locally, reconnect
briefly, do the push, disconnect again. That's still fully protocol-pure; only the
*connection lifecycle* changes (brief-connect/sync/disconnect instead of
continuously-live), not the protocol. This reframes §4's "no OPP2 involvement during
the disconnected window" as accurate only for the window itself — the two endpoints of
that window are still OPP2.

**Open, now that this is corrected:** whether the pull (piste's pool/bout assignment)
and push (final scores/cards/priority for bouts scored offline) can be expressed with
*existing* OPP2 message types (e.g. something built on `software/record`/
`scoresheet/record`'s retained-topic pattern, or a request/response exchange similar in
shape to the Tier A provisioning exchange's reserved topics), or whether this needs a
genuine spec extension — new message types, upstreamed to `OpenPiste/protocols` the
same way `software/clock`/`software/uw2f`/Tier A provisioning were. Given the pull step
needs pipeline/pool-structure data no existing OPP2 message currently carries, a real
spec extension seems likely — needs its own design pass.

## 6. Open, for next time

- Does splitting into two modes (§4) hold up? If so, does mode 2 still belong in the
  e-scoresheet PWA, or is it a smaller, separate tool (closer to what FencingTime
  already does)?
- If mode 2 is pursued: what exactly are the two sync points — pool/bout assignment
  pull at the start, and what payload shape at the end (final scores only, or scores +
  cards + priority together)? **Per §5, both must be standardized OPP2 messages, not
  Atlas-specific REST — likely a genuine spec extension**, since existing OPP2 has no
  message carrying pipeline/pool-structure data today.
- Mode 1 (live-mode manual capabilities) may be worth designing and shipping
  independently of mode 2 — it doesn't depend on resolving the offline question at
  all, and closes real gaps (manual card assignment, priority persistence) that matter
  even in the fully-connected case.
- The transport/auth/activation/DE-scope conclusions in §3 were reached in the
  single-continuum framing — revisit whether they still apply once mode 1 and mode 2
  are treated separately.
