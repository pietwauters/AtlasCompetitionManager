# Multi-Strip Pool Distribution

**Atlas Competition Manager — design and analysis document**

---

## 1. Background

Large pools (8+ fencers) take a long time to complete on a single strip. In practice,
competition directors assign two or more strips to a single pool, running bouts in parallel.
This document analyses the constraints, derives a distribution algorithm, and describes
the dynamic-reordering feature that Atlas implements.

---

## 2. The FIE bout order: design criteria

The FIE official bout orders (Article o.69, Organisation Rules) for pools of 4–12 fencers
are sequential tables designed for **single-strip execution**. A good bout order satisfies:

1. **Minimum rest** — every fencer has at least ⌊(N−3)/2⌋ idle bouts between consecutive
   appearances.
2. **Maximum rest** — no fencer waits more than ⌊N/2⌋ bouts (prevents unfair long waits).
3. **Near-uniform distribution** — the standard deviation of idle gaps should be as small
   as possible; ideally every fencer's gaps differ by at most ±1.
4. **No back-to-back** — for N ≥ 5 no fencer appears in two consecutive bouts. (For N = 4
   this is unavoidable by the pigeonhole principle.)
5. **Club/nationality separation** — teammates are placed at preferred positions so they
   fence each other early in the pool, spreading the scheduling constraint across the
   remaining bouts.

---

## 3. Rest-gap analysis of the FIE tables (single strip)

For each pool size the *gap* between two consecutive appearances of the same fencer is
the number of bouts between them (0 = back-to-back).

| Pool N | Bouts | Min gap | Max gap | Mean | Stddev | Notes |
|--------|-------|---------|---------|------|--------|-------|
| 4 | 6 | **0** | 2 | 1.00 | 0.71 | back-to-back unavoidable |
| 5 | 10 | 1 | 2 | 1.47 | 0.50 | ✓ |
| 6 | 15 | 1 | 3 | 1.96 | 0.84 | ✓ |
| 7 | 21 | 2 | 3 | 2.49 | 0.50 | ✓ excellent |
| 8 | 28 | 2 | 4 | 3.00 | 0.87 | ✓ |
| 9 | 36 | 3 | 4 | 3.49 | 0.50 | ✓ excellent |
| 10 | 45 | 3 | 5 | 3.99 | 0.92 | ✓ |
| 11 | 55 | **1** | **9** | 4.43 | **1.92** | ✗ large swing |
| 12 | 66 | 2 | **10** | 4.97 | **1.67** | ✗ large swing |

**Pools 11 and 12 are notably inferior.** A gap of 9–10 bouts means some fencers wait
nearly the entire pool before their next bout, while others have gaps of only 1–2. The FIE
tables for these sizes were clearly not designed with the same care as smaller pools.

---

## 4. Wave structure

A **wave** is a maximal set of consecutive bouts (taken from the ordered bout list) in which
no fencer appears more than once. All bouts in a wave can safely run simultaneously on
multiple strips.

Checking whether the FIE sequential order is naturally partitioned into perfect waves of
size ⌊N/2⌋:

| Pool | Wave size | Perfect? |
|------|-----------|---------|
| 7 | 3 | ✓ — 7 waves of 3 |
| 8 | 4 | ✓ — 7 waves of 4 |
| 9 | 4 | ✓ — 9 waves of 4 |
| 10 | 5 | ✗ — mix of 4 and 5 |
| 11 | 5 | ✗ — 3–5, irregular |
| 12 | 6 | ✗ — 4–6, irregular |

Pools 7–9 happen to have perfect round structure in the FIE tables; pools 10–12 do not.

---

## 5. Alternative bout order for pools 11 and 12

The standard **circle round-robin** algorithm produces N−1 rounds of N/2 bouts each, where
every round is a perfect matching (all fencers appear exactly once per round). For odd N,
add a virtual "bye" fencer; bouts involving the bye are omitted.

Rest-gap comparison for single-strip execution:

| Pool | Order | Min gap | Max gap | Stddev |
|------|-------|---------|---------|--------|
| 11 | FIE | 1 | 9 | 1.92 |
| 11 | Round-robin | 3 | 9 | 1.70 |
| 12 | FIE | 2 | 10 | 1.67 |
| **12** | **Round-robin** | **4** | **6** | **0.91** |

For pool 12, round-robin is dramatically better: max gap drops from 10 to 6 and stddev
nearly halves. For pool 11 the minimum gap improves from 1 to 3 with a modest stddev
improvement.

**Atlas uses FIE sequential order for N ≤ 10 and circle round-robin for N = 11–12.**

Note: club/nationality separation still applies — the round-robin algorithm orders fencers
using the same positional logic as the FIE tables. Teammates occupying preferred positions
will fence each other in the first wave.

---

## 6. When to offer multi-strip distribution

A pool is offered the multi-strip option when:

- Pool size N ≥ 8 (smaller pools finish fast enough on a single strip)
- Minimum useful workload per strip: **14 bouts** (so each strip justifies the overhead)

This threshold implies:

| Pool N | Total bouts | 2 strips (each) | 3 strips (each) | 4 strips (each) |
|--------|-------------|----------------|----------------|----------------|
| 8 | 28 | 14 ✓ | 9 ✗ | — |
| 9 | 36 | 18 ✓ | 12 ✗ | — |
| 10 | 45 | 23 ✓ | 15 ✓ | 11 ✗ |
| 11 | 55 | 28 ✓ | 18 ✓ | 14 ✓ |
| 12 | 66 | 33 ✓ | 22 ✓ | 17 ✓ |

---

## 7. Distribution algorithm

### Step 1 — Generate bout list

- N ≤ 10: use the FIE standard sequential order from `lib/boutOrder.js`.
- N = 11 or 12: generate using the circle round-robin algorithm (see `lib/multiStripPool.js`).

The bout list already encodes club/nationality separation through the position assignment
done during pool formation (see `lib/boutOrder.js`, `assignPoolPositions`).

### Step 2 — Extract waves

Scan the bout list in order. Add each bout to the current wave unless either fencer already
appears in that wave; if so, close the current wave and start a new one.

```
waves = []
current_wave = [], used = {}
for bout in bout_list:
    if bout.left in used or bout.right in used:
        waves.append(current_wave)
        current_wave = [], used = {}
    used.add(bout.left, bout.right)
    current_wave.append(bout)
waves.append(current_wave)
```

For FIE pools 8–9 and round-robin pools 11–12, all waves are uniform in size.

### Step 3 — Assign bouts to strips within each wave

Simple round-robin: bout 0 → strip 0, bout 1 → strip 1, …, bout K → strip 0, etc.

This is computed once when the pool is assigned to strips. The result is stored as
`bouts.strip_id` for each individual bout.

### Step 4 — Balance strip load

After the initial assignment, pool of 10 on 2 strips produces a 25/20 split due to uneven
wave sizes (mix of 4 and 5). A post-processing pass swaps bouts between adjacent waves to
bring each strip's count within ±1 of the mean, provided no swap creates a within-wave
fencer conflict.

### Step 5 — Rest-fix at wave boundaries

After assignment, scan every wave transition for **planned zero-rest cases**: a fencer who
is in the last time-slot of wave k AND the first time-slot of wave k+1 has zero planned
rest.

Fix attempt: try swapping the conflicted bout from the last slot of wave k with a bout from
an earlier slot in wave k, OR swap the conflicted bout from the first slot of wave k+1 with
a later bout in wave k+1 — provided neither swap introduces a within-wave conflict.

For some configurations (notably pool 8 / 2 strips) this is **provably unsolvable**: all
bouts in the last slot of wave k have fencers that also appear in the first slot of wave
k+1. In these cases the zero-rest flag remains and the referee is warned.

### Step 6 — Flag and display

Any planned zero-rest transition is flagged in the UI and shown to the operator, who
instructs the relevant piste referee to hold briefly before starting the next bout.

---

## 8. Rest guarantees (at 3 min/bout average)

| Pool | Strips | Bouts/strip | Min planned rest | Typical rest | Flags? |
|------|--------|-------------|-----------------|--------------|--------|
| 8 | 2 | 14/14 | 0–3 min | 3–6 min | possible |
| 9 | 2 | 18/18 | **3 min** | 3–6 min | none |
| 10 | 2 | 23/22 | **3 min** | 3–9 min | none |
| 10 | 3 | 15/15/15 | 0–3 min | 3–6 min | possible |
| 11 | 2 | 28/27 | **3 min** | 3–15 min | none |
| 11 | 3 | 19/19/17 | 0–3 min | 3–9 min | possible |
| 12 | 2 | 33/33 | **3 min** | 3–9 min | none |
| 12 | 3 | 22/22/22 | 0–3 min | 3–6 min | possible |
| 12 | 4 | 17/17/16/16 | 0–3 min | 3–6 min | possible |

The FIE minimum rest between bouts is 3 minutes. Where the system cannot guarantee this,
the referee is shown a warning and can impose a brief pause.

---

## 9. Dynamic bout reordering

### 9.1 Concept

The static distribution computed at pool-start is optimal given no information about actual
bout durations. In practice, bouts vary: one strip may run ahead, another fall behind. A
fencer who just finished a 5-minute bout on strip A may have only 30 seconds before their
next bout on strip B (if strip B was faster).

**Dynamic reordering** allows the CMS to monitor actual progress and make small adjustments:
when a fencer would have insufficient rest, the CMS swaps their upcoming bout with the
next bout on the same strip that does not involve them (or any other fencer with a rest
constraint).

### 9.2 Operator opt-in

Dynamic reordering is controlled by a per-pool checkbox in the pipeline builder:

> ☐ Allow dynamic bout reordering

When checked, the CMS actively manages the order; when unchecked, the static assignment
is used verbatim.

### 9.3 Algorithm (CMS side)

The CMS maintains for each piste:

- `lastFinishedAt[fencer]`: wall-clock time when that fencer's most recent bout ended
- `boutQueue[strip]`: remaining bouts for this strip, in planned order

When a bout ends on strip S at time T:

1. Update `lastFinishedAt` for both fencers.
2. Look at the next bout in `boutQueue[S]`.
3. For each fencer F in that next bout, compute `restAvailable = T - lastFinishedAt[F]`.
   (If F has never fenced, `restAvailable = ∞`.)
4. If `restAvailable < MIN_REST` for either fencer:
   - Scan forward in `boutQueue[S]` (up to a configurable lookahead, default 3 bouts)
     for the first bout where both fencers satisfy `restAvailable ≥ MIN_REST`.
   - If found, move that bout to the front of the queue; push the current next bout
     behind it.
   - If not found within lookahead: flag a warning ("fencer X needs rest — referee please
     wait") and proceed with the original next bout.
5. Publish the updated next bout to the piste's scoresheet via OPP2 NEXT.

`MIN_REST` defaults to 180 seconds (3 minutes). The operator can adjust it per competition.

### 9.4 Constraints and safeguards

- **Only swap within the same strip's queue.** Bouts never move between strips during
  dynamic reordering; only their order within one strip changes.
- **Lookahead limit.** Unlimited lookahead could radically reorder the pool, defeating
  the purpose of the original wave structure. Default lookahead = 3 bouts.
- **One-bout-ahead principle.** The swap is decided at the moment a bout ends, not
  pre-emptively. This keeps the logic simple and doesn't require predicting future bout
  durations.
- **Audit log.** Every dynamic reorder is logged with timestamp, strip, fencer, and reason,
  so the official bout record reflects what actually happened.

### 9.5 Interaction with OPP2

The CMS already handles `apparatus/control NEXT` per strip. With dynamic reordering
enabled, the NEXT handler consults `boutQueue[strip]` (which may have been reordered)
rather than the static DB order. The DB `bout_order` column is the *planned* order; the
dynamic queue is in-memory state in `opp2Client.js`.

If the CMS restarts mid-pool, the dynamic queue is rebuilt from remaining pending bouts
(DB order), which reverts to the static plan. This is a safe fallback.

---

## 10. Adjacent-piste recommendation

When a pool is split across multiple strips, fencers must physically move between pistes
after each bout. The system should:

1. **Warn** the operator if selected strips are not adjacent (strip numbers differ by more
   than 1).
2. **Suggest** using the lowest-numbered consecutive strip pair/group available.
3. For large pools on 3+ strips, suggest strips that form a contiguous block.

The rationale: a fencer finishing on piste 3 and immediately assigned to piste 8 will lose
time crossing the hall, potentially arriving late for their next bout. Adjacent pistes keep
travel time under 30 seconds.

---

## 11. Summary of design decisions

| Decision | Choice | Reason |
|----------|--------|--------|
| Minimum pool size for split | N ≥ 8 | Below 8, single strip completes quickly |
| Minimum bouts per strip | 14 | Below that, strip overhead isn't worthwhile |
| Bout order for N ≤ 10 | FIE sequential | Standard compliance; good rest properties |
| Bout order for N = 11–12 | Circle round-robin | FIE tables have gaps of 1–10; RR reduces to 3–6 |
| Wave extraction | Greedy independent sets | Preserves FIE/RR ordering; natural parallelism |
| Within-wave assignment | Round-robin across strips | Simple; load-balanced |
| Load balancing | Post-pass swap ±1 | Corrects 25/20 split in pool-of-10 |
| Zero-rest fix | Best-effort local swap | Eliminates most; residual flagged for referee |
| Dynamic reordering | Opt-in, lookahead 3 | Improves rest in real time without radical reordering |
| Strip selection UX | Warn if non-adjacent | Minimises fencer travel time |
