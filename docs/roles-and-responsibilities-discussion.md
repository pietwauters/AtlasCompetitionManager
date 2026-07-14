# OPP2 roles and responsibilities — a discussion document

**Status: draft for external discussion. Not part of the spec yet.** Nothing in this
document is normative. It exists to align on principle before any spec language is
written — see Section 8.

---

## 1. The problem

The protocols OPP2 descends from — EFP1.1 (Cyrano) and RS422-FPA — were built for an
ecosystem of exactly two kinds of participant: a scoring device, and one other element
(a CMS in Cyrano's case; a video system or repeater display in RS422-FPA's). Every
function a bout needs — registering touches, keeping score, tracking cards and
priority, running the clock, advancing to the next bout, displaying the result — had to
live *somewhere* physically real, and the scoring device was the only digital element
on the strip. So it did all of it. Not because keeping score or advancing between bouts
is inherently a scoring-device responsibility, but because there was no other candidate
box to put it on.

OPP2 changes the premise: the ecosystem is open-ended. A scoresheet tablet, a remote
control, a display, a CMS, a video-review station can each be an independent MQTT
publisher/subscriber, built by different, mutually unaware implementers. An earlier
draft of this document tried to resolve that by asking, function by function, "who
owns this" — and the answer kept coming out the same way, argued freshly each time,
with an awkward "fallback owner" story bolted on for every function whose usual owner
might not be deployed. That was a symptom of asking the wrong question. This version
asks a different one, and most of the complexity falls out on its own.

---

## 2. The model: intent, execution, state, display

### 2.1 Intent *is* the referee's decision

Almost every function in a bout — score, cards, priority, when to advance to the next
bout — is not something any device measures. It is a decision the referee makes, off
protocol, as a human being. OPP2 doesn't need to decide who is *allowed* to decide the
score; that's always the referee, and that was never actually in question. What OPP2
has to model is much narrower: once the referee has made a decision, how does it get
expressed as a message (an **intent**), and what happens to it after that.

Two functions are the genuine exception, and it's worth naming them precisely because
they're not decisions at all: **touch/hit sensing** and **the match-clock interlock**
(refusing a touch once time has expired) are things the apparatus directly senses or
computes in real time. Nobody decides them; they're facts, not intents. Everything else
in this document is a referee decision expressed as an intent.

### 2.2 Execution: the locality principle

An intent has to be turned into the system's actual state by *something* — validated,
applied, and republished so everyone else can pick it up. Call that element the
**executor**. The question "who executes this" sounds like it needs its own argument
per function, the way the old draft treated it. It doesn't. One rule covers every case
we've found:

> **The executor for a given intent is whichever element already has to hold the
> resulting state anyway, for a reason that has nothing to do with this propagation
> problem.**

Two elements qualify, and only two:

- **The CMS** executes anything that requires knowledge of the tournament structure or
  the permanent record — which bout is next on this piste, who's in the roster, what
  the final, persisted result is. Nothing else *can* compute these correctly; only the
  CMS holds the pipeline and the database. `control` (§24, NEXT/PREV/BEGIN/END),
  bout/fencer assignment (§15, including corrections), and team roster substitution all
  fall out this way.
- **The apparatus** executes score, cards, and priority — not because it's been
  promoted to "authority" over them, but because it already has to hold that state
  continuously, for its own hard, unrelated real-time job: driving its own display and
  enforcing the clock interlock (see Section 3). Making it the publisher-of-record for
  everyone else to mirror costs nothing extra; the state already lives there.

No other element is ever a candidate executor. A scoresheet, a remote control, or a
second referee's tablet is always just an **input surface** — a way for the referee's
decision to reach whichever executor owns that kind of intent. Removing an input
surface never changes who executes anything; it only removes one of the ways to talk
to the executor. This is the piece that made the old draft's per-function "fallback
owner" table unnecessary: there was never a fallback *owner*, because there's exactly
one executor per function regardless of what else is deployed.

### 2.3 State and display: everyone converges on one fact

Once the executor validates and applies an intent, the result is a fact — a state
transition, not a request. That fact gets published, and everything else (CMS, other
displays, a scoresheet's own read-only view) simply subscribes and mirrors it. Display
is never an owner of anything; it's the terminal case of "subscribe and show whatever
the executor most recently said is true."

### 2.4 Conflict handling: mostly free, by construction

Because there is exactly one executor per function, most of what looked like a hard
distributed-conflict problem in the old draft turns out to be ordinary single-writer
serialization: two intents arriving at the same executor close together are just
applied in the order they arrive, each validated against whatever the current state is
at that moment — the same as any state machine with one writer. There is no
multi-master negotiation to design.

What *is* still open is what happens when the executor **can't be reached at all**
(Section 3) — that's a real problem, but it's a connectivity problem, not an ownership
or negotiation problem, and it's treated separately below rather than smeared across
every function.

### 2.5 Retention: only current-state facts, never instructions or events

A topic should be retained if and only if it is a **current-state fact** that some
subscriber needs to bootstrap on connect or reconnect. It should not be retained if it
is either a **one-shot instruction directed at an autonomously-acting device** (that
device cannot tell "this is stale, from an earlier session" from "this is live, act
now"), or a **point-in-time event** with no persisting "current value" of its own (a
blade contact, an annotation being logged) — the durable trace of such an event, if any,
lives in a separate state topic that aggregates it.

This is *not* the same rule as "retain only the executor's own output" — that framing
looks right for one function and wrong for another:

- **Score/cards/priority**: the executor (apparatus) publishes the one current-state
  fact (`apparatus/score`, retained); the only other topic (`software/score`) is purely
  an instruction feeding into it. Here "the executor's output" and "the current-state
  fact" are the same topic, so the simpler framing happens to work.
- **Navigation/fencer assignment**: the executor (CMS) is right, but its own
  instructional output *to the apparatus* (`software/fencers`, `software/match`) is
  deliberately **not** retained — the spec already states why: *"a stale assignment
  from a previous session could be replayed to a newly connected apparatus... the
  apparatus cannot distinguish a retained message from a live one."* The topic that
  *is* retained here (`apparatus/fencers`) is published by the input surface, not the
  executor. "Retain the executor's path" would get this one backwards.

**Decision reached in this discussion: `software/score` (§13) should change from
`Retained: Yes` to `Retained: No`.** It is currently retained only because it predates
this model — it was added to the spec in its earliest form, symmetrically with
`apparatus/score`, before the command/fact distinction existed anywhere in this
project's thinking (`apparatus/fencers`'s later, correct asymmetric treatment was never
carried back to `score`). Making it non-retained brings it in line with
`software/fencers`/`software/match`, for the identical reason: a reconnecting apparatus
must never be able to replay and reapply a stale score/card correction it has no way to
know is old. This needs no new machinery — the spec already documents the recovery path
for exactly this shape of topic: *"The CMS republishes `software/fencers`,
`software/match`, and `software/record` on reconnect. QoS 1 ensures that messages
queued during the outage are delivered once connectivity is restored."* The same
pattern extends to `software/score` unmodified.

**Applied and merged, 2026-07-09:** `docs/level2.md` (Section 4.5, Section 6, Section 13)
updated in this repo, and the same diff merged upstream as
[OpenPiste/protocols#8](https://github.com/OpenPiste/protocols/pull/8).
`./scripts/sync-spec.sh` confirms the local mirror is byte-identical to the merged
upstream version. No Atlas code change was needed: `lib/opp2Transport.js`'s generic
`publish()` helper already defaults to `retain: false`, and both `software/score` call
sites in `lib/opp2Composer.js` already rely on that default — Atlas has been publishing
`software/score` non-retained all along, so this closed a spec/implementation mismatch,
not a behavior change.

### 2.6 Echo: a precise definition and a two-part rule

**Echo** is a *new, distinct, validly-delivered* message on a retained state-fact topic
whose value is already known to the receiving party — either because that party
originated the intent that produced it, or because it already learned the same value
through an earlier delivery. This is a different problem from duplicate delivery (§27's
`seq` mechanism, which discards a literal redelivery of the *same* message under MQTT
QoS 1's at-least-once guarantee) — echo is a second, distinct, non-duplicate message
that simply carries no *new* information for this particular subscriber. Duplicate
filtering by `seq` always runs first; the echo question only applies to whatever's left
after that.

Echo can only occur when all three of the following hold at once: (1) a fact is
published on a retained topic; (2) a party subscribes to that topic for a reason other
than having just caused the value (display, bootstrap, or watching for a further
change); (3) that same party originated the intent behind the fact's current value, or
already knew it from an earlier delivery. Non-retained command topics (`control`,
`software/fencers`, `software/match`, and — per 2.5 — `software/score`) cannot produce
an echo at all: nothing is ever delivered after the fact, and nothing subscribes to its
own outgoing command topic. So echo is confined entirely to the small, fixed set of
retained fact topics — nowhere else.

One general rule, in two parts, applies to every retained fact topic uniformly, with no
per-topic exception:

1. **Never react to a value already held.** Compare an incoming fact to the last-known
   value. Identical → no-op — not an error, not an anomaly, simply nothing to do.
   Different → proceed to (2).
2. **Never apply a changed value without validating it against current context.** A
   changed fact is applied only if it represents a legal transition given what's
   currently known (an active, unfinished bout on this piste; a coherent pairing;
   etc.). Valid → apply it as a genuine new event. Invalid → reject or flag it — never
   apply silently, never ignore silently.

Checked against the one place this is actually implemented today
(`handleApparatusFencers`'s empty / identical / clean-swap / anomaly branches): all four
collapse cleanly onto these two rules. "Empty" and "identical" are both rule (1) — no
new information, whether because nothing changed or because the party seeing it caused
the transition itself. "Clean swap" is rule (2) passing validation. "Anomaly" is rule
(2) failing validation. The four-way branch was never wrong; it was the general rule
worked out ad hoc for one function, rather than stated once for all of them.

---

## 3. A constraint that removes an entire axis of variability

FIE competition rules require a scoring apparatus — including its display of score,
time, cards, and priority — at every piste. This is not a deployment choice or an OPP2
design decision; it's a procedural requirement independent of the protocol.

That means "the apparatus might not be there" is never a real case. The only thing that
can actually vary is whether that apparatus is **networked**, and whether that network
connection is **currently up** — both squarely the resilience discussion's territory
(retained messages, reconnect-and-recover), not a new ownership question for this
document.

The one deployment axis that *is* genuinely variable is the **scoresheet**: some clubs
run one, some don't, and that's a real choice, not an FIE requirement. Per Section 2.2,
this doesn't change who executes score/cards/priority — the apparatus always does. It
only changes how many input surfaces exist for expressing the referee's intent.

**The practical consequence, stated plainly:** in many club deployments the scoring
apparatus will initially have no network connection at all — the common transition
state for a club adopting OPP2 gradually. In that case, information the referee wants
recorded electronically (on a scoresheet app, say) has to be entered twice: once at the
apparatus (which the referee or their assistant operates directly, unconnected, exactly
as they always have) and once wherever else it needs to live. That's not a gap to
engineer around — it's an unambiguous, well-understood limitation of running two
recording surfaces with no link between them. Reconciling two independently-kept
records after the fact (once a connection exists again) is a real problem, but it's the
resilience discussion's problem, not this document's.

---

## 4. Functions, revisited

| Function | Kind | Executor | Note |
|---|---|---|---|
| Touch/hit sensing | Fact, not a decision | Apparatus | Hard capability constraint — no other element can sense this |
| Match clock — record & interlock | Fact, not a decision | Apparatus | The interlock has to react inside the same real-time loop as hit-sensing; a network round trip is categorically too slow |
| Passivity timer (UW2F) / P-cards | Fact, not a decision | Apparatus | Same real-time reasoning as the clock interlock |
| Score record | Referee decision | Apparatus | Apparatus already holds this for its own display + clock interlock (2.2) |
| Cards (yellow/red/black) | Referee decision | Apparatus | Same as score; device entry is a legitimate input surface, not a lesser one |
| Priority assignment | Referee decision | Apparatus | Enforcement of any procedural consequence (e.g. sudden-death cutoff) stays with the same apparatus that holds the value |
| Match navigation (BEGIN/NEXT/PREV/END) | Referee decision | CMS | Only the CMS has pipeline knowledge and the permanent record; device, remote, and scoresheet are all equally legitimate input surfaces for the same decision |
| Fencer identity / handedness placement, incl. mid-bout swap | Referee decision | CMS | Worked, shipped precedent (`apparatus/fencers` ↔ `software/fencers`, OpenPiste/protocols#7) — CMS validates and persists, both directions wired |
| Bout/match metadata assignment | Not contested | CMS | Only the CMS has the tournament structure to know it |
| Team roster substitution (`declareSubstitution`) | Referee/captain decision | CMS | No device-side equivalent needed or expected — see Section 6 |
| Display (score/cards/priority/time) to fencers/public | No owner | — | Subscribes to whichever fact the relevant executor last published; the apparatus's own FIE-mandated display is one specific, always-present instance of this |
| Video review request/decision | Not contested | Video station (`var/*`) | Already modeled; raised only for completeness |
| Annotations (card reasons, medical timeouts, reserve entries) | Not contested | Scoresheet | No competing publisher exists |
| Piste/pipeline transfer (technical failure, scheduling) | Director decision | CMS | New territory — see Section 5; the one case where the executor itself has to change mid-bout |

Compared to the previous draft, most of the actual disagreement or design work left is
not "who owns this" (settled, one rule, Section 2.2) but **what the valid commands and
their validation rules are per function** — e.g. a score can't go negative, an END
can't be accepted without a decided winner or assigned priority (§25.4, already
implemented), a swap can't apply to a finished bout. That's normal, necessary
implementation work; it no longer needs to be argued as a responsibility question.

---

## 5. Piste transfer: moving a match, or a whole pipeline, to a different piste

A realistic operational case, distinct from anything covered so far: a piste's
apparatus fails, or a scheduling problem forces a piste to be freed up, mid-competition.
The director needs to move either a single ongoing match, or an entire pipeline (every
slot — past, current, and future — currently assigned to that piste), to a different
piste, without losing anything already recorded.

### 5.1 Who executes this: the CMS, unambiguously

Applying Section 2.2's rule directly: only the CMS holds the pipeline/tournament
structure needed to know which piste is being vacated, which piste is taking over, and
what the rest of that pipeline looks like once relocated. It's also the only element
that already has a passively-mirrored copy of the in-progress bout's live state
(`pisteState[pisteId].lastScore` / `lastUw2f` in `lib/opp2Client.js`, kept current from
`apparatus/score`/`apparatus/uw2f` regardless of this transfer). No apparatus,
scoresheet, or remote is ever a candidate executor here — same conclusion as every
other navigation-shaped function in Section 4's table, for the same reason.

### 5.2 Transferring a whole pipeline is mostly free

Every slot in a pipeline that hasn't started yet is pure CMS bookkeeping — reassigning
its piste field to the new piste. Nothing has ever been announced to any apparatus about
a future slot, so there is nothing to unwind or re-seed. This reduces "move a pipeline"
to "relocate the bookkeeping" (cheap, already the CMS's job) plus, at most, "move the one
bout currently in progress, if any" (the hard case below). The two are not the same
problem, and only the second one needs new protocol thinking.

### 5.3 Transferring the active bout: an executor handoff

This is new territory for the model: it requires the *executor itself* to change
mid-bout, from one physical apparatus instance to another. Every other function in this
document assumes a stable executor instance for the life of the bout; here the instance
changes while the referee's decisions so far have to survive the move intact.

The sequence, entirely CMS-driven:

1. **Halt first, transfer second.** Per Section 3's existing philosophy, this document
   doesn't try to design a live, race-free handoff. The referee halts fencing before the
   transfer is triggered — a physical-world action, not a protocol one — which removes
   the ordering problem outright: there's a clean instant after which the old
   apparatus's state is final.
2. **CMS captures the snapshot it already has.** Score, cards, and priority are already
   mirrored via `apparatus/score` (§13); UW2F/P-cards via `apparatus/uw2f` (§19). No
   round trip to the old apparatus is needed.
3. **CMS tells the old apparatus to relinquish the bout.** This is a genuine gap: every
   existing `control` value (BEGIN/NEXT/PREV/END, §24) assumes the bout is finishing
   normally. None of them mean "abandon this bout, mid-fight, with no result" — carried
   into Section 7's open questions.
4. **CMS starts the new apparatus exactly like any new bout** — `software/fencers` +
   `software/match` (§15/§16), unchanged.
5. **CMS seeds the new apparatus's score/cards/priority** via `software/score` (§13) —
   the identical mechanism already shipped for team-relay cumulative-score seeding
   (`_sendRelayData` in `opp2Composer.js`), just with "wherever the old apparatus left
   off" instead of "zero." This only works cleanly because `software/score` is now
   non-retained (Section 2.5) — a one-time correction, not a replay risk.
6. **Clock and UW2F have no seeding mechanism at all.** `clock` (§11) and `uw2f` (§19)
   are apparatus-only in the spec — there is no `software/clock` or `software/uw2f`
   correction counterpart, unlike score and fencers. Atlas's team-relay code already
   writes to `software/clock` directly (`opp2Composer.js`), but off-spec, and only ever
   to reset a fresh relay to 3:00 — never to resume an arbitrary elapsed time.
   Preserving "everything else in the state" for a mid-bout transfer needs a real spec
   message here.
7. **Atlas doesn't even mirror the clock today.** `pisteState` in `lib/opp2Client.js`
   tracks `lastScore` and `lastUw2f` but has no `apparatus/clock` handler at all — an
   implementation gap underneath the spec gap.
8. **`software/record`'s existing piste-transfer mechanism (§17) carries over
   unmodified.** It already republishes slot structure, results-so-far, and accumulated
   annotations to the new piste's topic on a piste transfer — built for between-bout
   transfers, but nothing about it assumes the bout is finished. The transferred bout's
   own `bouts[n].result` simply stays `null` until it's actually completed, on the new
   piste.

### 5.4 What this leaves open

Two concrete, protocol-shaped gaps, not just an implementation TODO:

- A documented software→apparatus seeding message for clock and UW2F, symmetric to
  `software/score`.
- A `control` value (or equivalent) meaning "relinquish this bout, no result" — distinct
  from every existing value, all of which assume normal completion.

Both are carried into Section 7's open questions rather than resolved here.

---

## 6. Team relays need no separate framework

Team matches run through a separate code path (`services/teamMatches.js`,
`teamPhases.js`) from individual bouts, which raises the obvious question of whether
they need their own version of this whole discussion. They don't — every relay is just
another pipeline slot, walked through the same generic `control` handling as any pool
or DE bout, so navigation is CMS-executed exactly as in Section 4, with no relay-
specific code path.

Two things about relays are genuinely worth flagging, not because the model breaks but
because they're easy to miss:

- **Score is still apparatus-executed, but the shape of the state is harder.** FIE
  relay scoring is cumulative across the whole match (relay 1 to 5, relay 2 to 10, ...
  the final relay to 45), not a per-relay absolute number, so a correction to an early
  relay changes every cumulative figure reported afterward. The executor is unchanged;
  the validation logic the executor runs is more involved.
- **Roster substitution is a function this document's earlier drafts hadn't named
  explicitly.** A team captain substituting a reserve fencer "effective from relay N"
  changes who's up for a future relay — adjacent to navigation, but a roster/
  eligibility decision, not a live-bout control command. Under the locality principle
  it's obviously CMS-executed: only the CMS holds roster/eligibility data, and there's
  no natural apparatus interface for "which of six fencers occupies which relay slot."
  Listed in Section 4's table now rather than left implicit.

---

## 7. Open questions carried into this discussion

These are the pieces the model above doesn't resolve by itself — they need an actual
decision, not just a framing:

- **Reconciliation after a disconnected apparatus (or scoresheet) reconnects.** Section
  3 accepts double-entry as an unambiguous, known limitation while disconnected: it does
  *not* say how the two independently-kept records get reconciled once a connection
  exists again. That's the resilience discussion's open item, not solved here.
- **Firmware capability.** Can a real, deployed apparatus actually apply a command that
  arrived over the network (e.g. a card entered on a scoresheet) and correctly refresh
  its own existing display — or is that a genuine gap on hardware in the field today?
  Worth checking against a real implementation before assuming it's just a protocol
  question.
- **Genuine duplicate intents, as opposed to echoes.** Section 2.6's rule handles a
  party seeing its own published change come back. It does not, and shouldn't try to,
  handle two people genuinely both entering "+1" for the same touch — that's a human
  double-entry error, correctable by the referee like any wrong score entry, not
  something the protocol needs to prevent.
- **No software→apparatus seeding message for clock or UW2F** (Section 5.3, step 6).
  `score` and `fencers` both have a documented software-side correction/assignment
  counterpart; `clock` and `uw2f` don't. Needed for a mid-bout piste transfer to
  preserve the clock and passivity-timer state, not just score/cards/priority.
- **No "relinquish this bout" control value** (Section 5.3, step 3). Every existing
  `control` value assumes the bout is finishing normally (a result, or a navigation
  step). A piste transfer needs the old apparatus to stand down from a bout with no
  result at all — something outside every current value's meaning.

**Resolved in this discussion (no longer open):** whether `software/score` should be
retained (Section 2.5 — decided: no, matching `software/fencers`/`software/match`), and
what "echo" precisely means and how to handle it (Section 2.6 — a two-part rule: never
react to an unchanged value, never apply a changed one without validating it).

---

## 8. What this document is not

No protocol changes are proposed here. No spec section is being edited yet. This is
meant to be read, argued with, and revised before a single line of `docs/level2.md`
changes — the point is a defensible, written position on why each function ends up with
the executor it has, so that whatever is eventually decided reads as a reasoned
consequence of the model in Section 2, not an arbitrary implementer's opinion.
