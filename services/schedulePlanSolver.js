'use strict';

// Greedy list-scheduling solver for the tournament schedule planner. Treats
// each stage as one resource block: it needs somewhere between
// `pistesAssigned` (a floor) and `maxPistesAssigned` (a ceiling, no benefit
// beyond it) pistes, simultaneously, for however long that many pistes take
// to get through `workMinutes` of total work — no earlier than every stage
// it `dependsOn` has finished and no earlier than its competition's own
// start floor (see competitionStart below). The piste count within that
// range is decided at solve time (see findBestSlot) based on what's
// actually free, not fixed in advance — a flights-capped round opportunis-
// tically grabs idle extra pistes to finish sooner rather than always
// settling for the flights-minimum even when nothing else needs them
// (2026-08-28). This is a standard parallel-identical-machines / variable-
// job-width list-scheduling heuristic, not a claim of optimality. It gives
// a reasonable starting layout; the director adjusts individual
// schedule_plan_slots by hand afterward, and any manual edit lasts until
// the plan is next re-solved (see docs/schedule-planner-algorithm.md's
// "one evolving plan, re-solved as inputs change" model).
//
// Deliberately does not reason about individual pools/DE rounds within a
// stage (that finer-grained placement is what the real pipeline already
// solves once real pools exist — see services/pipelineSlots.js) — a stage
// here is always a single opaque block (a DE stage becomes several blocks,
// one per tableau round — see services/schedulePlans.js's _buildSolverInput
// — but each one is still opaque to this file).
//
// Pistes are no longer a fully interchangeable pool (2026-08-27) — a piste
// can be restricted to certain kinds of work (services/strips.js's
// pools_allowed/de_allowed/max_de_tableau, e.g. "Podium only for the
// semis/final", "these pistes never host pools"). Each stage/unit declares
// what it needs (phaseType, and tableauSize for a DE round) and the solver
// only picks among pistes eligible for that specific need.
//
// Known Phase-1 simplification: models one continuous piste-time axis from
// dayStart with no day boundary — a schedule that runs past 24h shows an
// elapsed "HH:MM" past 24:00 (e.g. "26:15") rather than wrapping to a wrong
// clock time or splitting across calendar days. Fine for a single-day
// estimate; a genuinely multi-day tournament plan would need day-aware
// piste availability windows, which is out of scope for this pass.

function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

function toHHMM(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

// A piste is eligible for a unit when its capability flags allow that unit's
// kind of work — pool units just need poolsAllowed; a DE-round unit needs
// deAllowed and its tableau size within [minDeTableau, maxDeTableau] (either
// bound null = unrestricted on that side). maxDeTableau is "largest tableau
// this piste may host" (e.g. Podium, semis/final only); minDeTableau is the
// mirror — "smallest tableau this piste may host" — for the opposite case:
// a piste that must drop OUT once a round shrinks past some point (e.g. a
// non-video piste that may only run the earlier, larger rounds once video
// coverage becomes mandatory from T32 down).
//
// reservedForCompetitionId/reservedFromTableauSize (2026-08-28 discussion,
// DE-only — pools always want maximum piste availability, no narrowing
// there): a shared pool of pistes (e.g. 8 colored/video pistes) can be
// split between two concurrently-running competitions once their brackets
// shrink past a point, so neither one starves the other of pistes during
// the run-in to the semis/final. Above the threshold the reservation simply
// hasn't kicked in yet — piste behaves exactly as it would unreserved; at or
// below it, the piste is eligible ONLY for its reserved competition's own
// units, on top of whatever the min/max bounds already say.
function isEligible(piste, unit) {
  if (unit.phaseType === 'pool') return !!piste.poolsAllowed;
  const capable = !!piste.deAllowed
    && (piste.maxDeTableau == null || unit.tableauSize <= piste.maxDeTableau)
    && (piste.minDeTableau == null || unit.tableauSize >= piste.minDeTableau);
  if (!capable) return false;
  const reservationActive = piste.reservedForCompetitionId != null
    && (piste.reservedFromTableauSize == null || unit.tableauSize <= piste.reservedFromTableauSize);
  return !reservationActive || piste.reservedForCompetitionId === unit.competitionId;
}

// A piste's schedule is a list of real [start, end) busy intervals — not a
// single "next free" scalar. A single scalar can't tell a later-queued-but-
// earlier-finishing unit that a piste sitting idle *right now* is actually
// free, because it was last set to some other unit's end time regardless of
// how far in the future that was. Queue order (tie-broken by `order`) is not
// chronological order, so this distinction matters in practice — see the
// 2026-08-27 trace that found it (a T64 round blocked until 13:45 by a
// Sabre pool round that doesn't even start until 13:45 itself).
function isFreeDuring(intervals, start, end) {
  for (const [s, e] of intervals) {
    if (start < e && s < end) return false;
  }
  return true;
}

// Fixed reference range of tableau sizes, used only to size a piste's own
// static DE eligibility breadth (see pisteBreadth below) — not a lookahead
// into the actual units being solved, just wide enough to cover any
// realistic tournament (2 up to 256).
const DE_TABLEAU_SIZES = [2, 4, 8, 16, 32, 64, 128, 256];

// "How many different kinds of work could this piste still do for THIS
// competition" — used only to break ties in findBestSlot below when a unit
// has more than one eligible-and-free piste to pick from. A piste with no
// min/max restriction (e.g. a video piste with no round-size limit) can
// serve every DE round of every competition; a piste restricted to a narrow
// tableau-size band (e.g. min_de_tableau=32, only the big early rounds) can
// only ever serve a few. Preferring to consume the narrow piste first —
// even when both are eligible and idle — protects the broad piste for
// whichever later, more specialized unit turns out to have no other option
// (2026-08-27: without this, an unrestricted Women's Sabre T64 round would
// grab a colored/video piste just because it happened to be idle longest,
// needlessly delaying a Men's Foil T32 round that could ONLY use that
// piste, even though plenty of ordinary pistes were free and just as usable
// for the Sabre round).
//
// Takes the ASKING unit's own competitionId (2026-08-29) because a piste
// reservation (isEligible above) narrows a piste's usable range differently
// per competition — a piste reserved to competition X from some tableau
// size down is, from X's own perspective, unrestricted by that reservation
// (it's reserved *for* them), but from any OTHER competition's perspective
// it's just as narrow as a piste that's permanently restricted to that same
// range. Without this, a piste on track to become reserved away still LOOKS
// broadly useful on paper, and the tie-break would protect it as if it were
// — the opposite of the intent — instead of spending it now while it's
// still shared.
function pisteBreadth(piste, competitionId) {
  let score = piste.poolsAllowed ? 1 : 0;
  if (piste.deAllowed) {
    const reservedForOther = piste.reservedForCompetitionId != null && piste.reservedForCompetitionId !== competitionId;
    score += DE_TABLEAU_SIZES.filter(t =>
      (piste.maxDeTableau == null || t <= piste.maxDeTableau) &&
      (piste.minDeTableau == null || t >= piste.minDeTableau) &&
      (!reservedForOther || piste.reservedFromTableauSize == null || t > piste.reservedFromTableauSize)
    ).length;
  }
  return score;
}

function lastIntervalEnd(intervals) {
  return intervals.length ? intervals[intervals.length - 1][1] : -Infinity;
}

// Longest run of consecutive integers in a sorted array — used below to
// judge how "intact" a leftover cluster of pistes still is after a pick.
function largestContiguousRun(sortedValues) {
  if (!sortedValues.length) return 0;
  let best = 1, cur = 1;
  for (let i = 1; i < sortedValues.length; i++) {
    cur = sortedValues[i] === sortedValues[i - 1] + 1 ? cur + 1 : 1;
    if (cur > best) best = cur;
  }
  return best;
}

// Among a tied group of piste indices (same breadth, same idle time — the
// two dimensions that actually reflect scheduling value), pick `need` of
// them (2026-08-29). Restricted to a *consecutive* run within the sorted
// group — a scattered pick is never better than some compact one for
// either goal below, so there's no need to consider non-consecutive
// combinations.
//
// The goal isn't just "my own pick is compact" — the solver has no
// lookahead (see docs/schedule-planner-algorithm.md), so it can't know
// whether some other unit will want more pistes from this same tied pool
// later. What it CAN do without lookahead is avoid making that hypothetical
// future pick harder than it has to be: prefer whichever consecutive window
// leaves the LARGEST contiguous run among what's left over — taking from
// either end of a single contiguous group always does this (the remainder
// stays one intact run), but taking from the middle of one, or from a
// smaller cluster when a same-span pick from a bigger one would fully
// consume it, fragments the leftovers into disconnected pieces that are
// individually less useful to whoever claims them next. Span only breaks a
// further tie among equally-good remainders (prefer the tightest pick
// itself), and start position is the final, fully deterministic fallback.
function closestPistes(group, need) {
  const sortedByIndex = [...group].sort((a, b) => a - b);
  let best = null;
  for (let start = 0; start + need <= sortedByIndex.length; start++) {
    const chosen = sortedByIndex.slice(start, start + need);
    const span = chosen[chosen.length - 1] - chosen[0];
    const remainder = sortedByIndex.slice(0, start).concat(sortedByIndex.slice(start + need));
    const remainderBestRun = largestContiguousRun(remainder);
    if (!best
        || remainderBestRun > best.remainderBestRun
        || (remainderBestRun === best.remainderBestRun && span < best.span)) {
      best = { start, span, remainderBestRun };
    }
  }
  return sortedByIndex.slice(best.start, best.start + need);
}

// Among `free` pistes (all known to fit the chosen window), pick `k`:
// narrowest-eligibility first (see pisteBreadth), then whoever has been idle
// longest (their last interval ends earliest). Everything left tied on both
// (most often several pistes never yet used, all at -Infinity) is
// interchangeable from the solver's own perspective — WHICH of them get
// chosen is then free to optimize for physical proximity instead of just
// raw piste order (see closestPistes).
function pickPistes(free, k, pisteIntervals, pisteBreadthScore) {
  const sorted = [...free].sort((a, b) =>
    pisteBreadthScore[a] - pisteBreadthScore[b]
    || lastIntervalEnd(pisteIntervals[a]) - lastIntervalEnd(pisteIntervals[b])
  );

  const chosen = [];
  let i = 0;
  while (chosen.length < k && i < sorted.length) {
    let j = i + 1;
    while (
      j < sorted.length
      && pisteBreadthScore[sorted[j]] === pisteBreadthScore[sorted[i]]
      && lastIntervalEnd(pisteIntervals[sorted[j]]) === lastIntervalEnd(pisteIntervals[sorted[i]])
    ) j++;
    const group = sorted.slice(i, j);
    const need = k - chosen.length;
    chosen.push(...(group.length <= need ? group : closestPistes(group, need)));
    i = j;
  }
  return chosen;
}

// Finds the best (start, pisteCount) for a unit whose piste count is a
// *range* [minK, maxK], not a fixed number (2026-08-28: a flights-capped
// round previously always used exactly the flights-minimum piste count even
// when far more sat idle, making it run needlessly long — "never use more
// than needed" was true, but "never use more even when nothing else needs
// them" wasn't the intent). workMinutes is the round's total bout-minutes;
// duration for a candidate k is ceil(workMinutes / k) — more pistes, shorter
// duration, same total work. In FIXED mode (director-set pistes_assigned,
// not flights-derived) minK === maxK, so this degenerates to exactly
// today's single-K behavior.
//
// For a FIXED start time, a larger k always yields a shorter (or equal)
// duration than a smaller k, and a shorter window is only ever as-hard-or-
// easier to fit into existing gaps than a longer one — so at each candidate
// start, trying k from maxK down to minK and stopping at the first feasible
// one already finds that start's best (smallest-end) option; no need to
// keep checking smaller k there. Across candidate starts, the search keeps
// the overall earliest-finishing (start, k) pair — an earlier start with
// fewer pistes can lose to a later start that lands enough extra pistes to
// finish sooner, so both are genuinely compared rather than just taking the
// first start that works at all.
function findBestSlot(eligibleIndices, pisteIntervals, earliestStart, workMinutes, minK, maxK, pisteBreadthScore) {
  const candidates = new Set([earliestStart]);
  for (const idx of eligibleIndices) {
    for (const [, e] of pisteIntervals[idx]) {
      if (e >= earliestStart) candidates.add(e);
    }
  }
  const sortedStarts = [...candidates].sort((a, b) => a - b);

  let best = null; // { start, end, k, chosen }
  for (const start of sortedStarts) {
    if (best && start >= best.end) break; // no later start can beat an already-found finish
    for (let k = maxK; k >= minK; k--) {
      const duration = Math.ceil(workMinutes / k);
      const end = start + duration;
      // duration is non-increasing in k, so as k counts down from maxK,
      // `end` only grows — once it's no better than the current best,
      // every smaller k at this start is guaranteed no better either.
      if (best && end >= best.end) break;
      const free = eligibleIndices.filter(idx => isFreeDuring(pisteIntervals[idx], start, end));
      if (free.length >= k) {
        best = { start, end, k, chosen: pickPistes(free, k, pisteIntervals, pisteBreadthScore) };
        break; // largest feasible k at this start is its best — smaller k here can't improve on it
      }
    }
  }
  return best; // unreachable null when eligibleIndices.length >= minK
}

// stages: [{ id, dependsOn: [id,...], order, workMinutes, pistesAssigned,
//            maxPistesAssigned?, phaseType: 'pool'|'de', tableauSize?,
//            competitionId, restMinutes?, fixedStart? }]
//   workMinutes: total bout-minutes of work this unit represents — actual
//   duration is derived at solve time as ceil(workMinutes / pistesUsed),
//   not fixed in advance (2026-08-28: a flights-capped round previously
//   always ran its full multi-flight duration even when far more pistes
//   sat idle — see findBestSlot).
//   pistesAssigned: the MINIMUM piste count (the flights-cap floor, or the
//   director's own fixed number when no flights cap applies — in which
//   case maxPistesAssigned should equal it too, disabling the opportunistic
//   widening below).
//   maxPistesAssigned (optional, defaults to pistesAssigned): the piste
//   count beyond which more pistes give no benefit (one-flight-worth — see
//   services/schedulePlans.js's _buildSolverInput). The solver uses as many
//   pistes within [pistesAssigned, maxPistesAssigned] as are actually free
//   without unnecessarily delaying the start, shortening the round's
//   duration accordingly rather than always settling for the flights-floor.
//   restMinutes (optional, default 0): minimum gap added after each
//   dependency's finish time before this unit may start — a fencer-safety/
//   logistics buffer, not a piste constraint (see services/schedulePlans.js's
//   _buildSolverInput for how this combines an auto-calculated DE-round-to-
//   round value with any director-set explicit buffer — the longer wins).
//   fixedStart (optional, 'HH:MM'): a hard floor on this unit's own start —
//   broadcast/VIP timing, a different venue for the final, etc. Never
//   pushes the unit EARLIER than its natural dependency timing would allow;
//   when the natural timing is already past fixedStart, the request simply
//   couldn't be honored (see naturalStart on the result, used by
//   services/schedulePlans.js's resolve() to build a warning).
// pistes: [{ poolsAllowed, deAllowed, maxDeTableau, minDeTableau,
//            reservedForCompetitionId, reservedFromTableauSize }] — index in this array
//         is the 0-based piste index used in stageResults[].pistesUsed.
// options: { dayStart: 'HH:MM', competitionStart?: { [competitionId]: 'HH:MM' } }
// returns: { stageResults: [{id, start, end, naturalStart, pistesUsed: [0-based piste index, ...]}],
//            finishMinutes, finishTime }
//   naturalStart is the unit's dependency-driven earliest start BEFORE any
//   fixedStart floor is applied — always present, used to tell "started
//   right on its natural time" apart from "waited for a fixed start" when
//   the two happen to coincide with `start`.
function simulate(stages, { pistes, dayStart = '08:00', competitionStart = {} }) {
  if (!Array.isArray(pistes) || pistes.length < 1) {
    throw Object.assign(new Error('At least one piste is required'), { status: 400 });
  }
  const dayStartMin = toMinutes(dayStart);
  const competitionStartMin = {};
  for (const [compId, t] of Object.entries(competitionStart || {})) {
    if (t) competitionStartMin[compId] = toMinutes(t);
  }

  const byId = new Map(stages.map(s => [s.id, s]));

  const indegree   = new Map(stages.map(s => [s.id, 0]));
  const dependents = new Map(stages.map(s => [s.id, []]));
  for (const s of stages) {
    for (const depId of (s.dependsOn || [])) {
      if (!byId.has(depId)) continue; // ignore dangling refs defensively
      indegree.set(s.id, indegree.get(s.id) + 1);
      dependents.get(depId).push(s.id);
    }
  }

  let ready = stages.filter(s => indegree.get(s.id) === 0);
  const finishOf = new Map();
  const pisteIntervals = pistes.map(() => []); // per piste: [[start,end], ...] sorted by start
  const results = [];

  while (ready.length) {
    ready.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const stage = ready.shift();

    const eligible = pistes.map((p, i) => [p, i]).filter(([p]) => isEligible(p, stage)).map(([, i]) => i);
    if (!eligible.length) {
      const round = stage.tableauSize ? ` (T${stage.tableauSize})` : '';
      throw Object.assign(
        new Error(`No piste is eligible for "${stage.id}"'s ${stage.phaseType}${round} work — check piste capabilities.`),
        { status: 400 }
      );
    }
    // Recomputed per unit, not once up front — a piste's effective breadth
    // now depends on which competition is asking (see pisteBreadth).
    const pisteBreadthScore = pistes.map(p => pisteBreadth(p, stage.competitionId));
    // minPistes is the flights-cap floor (or the director's own fixed
    // pistes_assigned — see _buildSolverInput, where minK===maxK in that
    // case); maxPistes is the "no benefit beyond this" ceiling (one-flight-
    // worth). Both clamp down to however many pistes are actually eligible —
    // same graceful-degrade behavior as before, surfaced as a flights
    // warning by services/schedulePlans.js's resolve() when it bites.
    const minK = Math.max(1, Math.min(stage.pistesAssigned || 1, eligible.length));
    const maxK = Math.max(minK, Math.min(stage.maxPistesAssigned || minK, eligible.length));

    const compFloor = stage.competitionId != null && competitionStartMin[stage.competitionId] != null
      ? competitionStartMin[stage.competitionId]
      : dayStartMin;
    // restMinutes (services/schedulePlans.js's _buildSolverInput) is a
    // fencer-safety/logistics buffer, not a piste-availability constraint —
    // it just pushes this unit's earliest start out from its dependency's
    // finish time, same as compFloor does.
    const naturalStart = Math.max(
      compFloor,
      ...(stage.dependsOn || []).map(depId => (finishOf.get(depId) ?? compFloor) + (stage.restMinutes || 0))
    );
    // A fixedStart is a floor, never pulling the unit earlier than its
    // natural timing already allows — it can only push it later (or leave
    // it unchanged when natural timing is already past it, which is exactly
    // the "couldn't be honored" case resolve() reports as a warning).
    const fixedStartMin = stage.fixedStart ? toMinutes(stage.fixedStart) : null;
    const earliestStart = fixedStartMin != null ? Math.max(naturalStart, fixedStartMin) : naturalStart;

    const workMinutes = Math.max(0, stage.workMinutes || 0);
    const slot = findBestSlot(eligible, pisteIntervals, earliestStart, workMinutes, minK, maxK, pisteBreadthScore);
    const { start, end, chosen } = slot;
    for (const idx of chosen) {
      const intervals = pisteIntervals[idx];
      let i = intervals.length;
      while (i > 0 && intervals[i - 1][0] > start) i--;
      intervals.splice(i, 0, [start, end]);
    }

    finishOf.set(stage.id, end);
    results.push({ id: stage.id, start, end, naturalStart, pistesUsed: chosen });

    for (const depId of dependents.get(stage.id)) {
      indegree.set(depId, indegree.get(depId) - 1);
      if (indegree.get(depId) === 0) ready.push(byId.get(depId));
    }
  }

  if (results.length !== stages.length) {
    throw Object.assign(new Error('Cyclic or dangling stage dependency — cannot solve schedule'), { status: 400 });
  }

  const finishMinutes = results.length ? Math.max(...results.map(r => r.end)) : dayStartMin;
  return {
    stageResults: results.map(r => ({ ...r, start: toHHMM(r.start), end: toHHMM(r.end), naturalStart: toHHMM(r.naturalStart) })),
    finishMinutes,
    finishTime: toHHMM(finishMinutes),
  };
}

// Given a piste list -> finish time. Thin wrapper for symmetry with
// solveForDeadline below; both directions share the one simulate() core.
function solveForPistes(stages, pistes, dayStart, competitionStart) {
  return simulate(stages, { pistes, dayStart, competitionStart });
}

// Given a deadline -> minimum piste count that meets it. Linear search
// (tournament piste counts are small — dozens at most — so this is instant;
// no need for binary search sophistication). buildPistes(n) must return a
// pistes array of exactly length n — the caller (services/schedulePlans.js)
// owns turning "n" into real-strip-capabilities-plus-abstract-fill, since
// this file has no DB access of its own.
function solveForDeadline(stages, deadlineTime, dayStart, competitionStart, buildPistes, { maxPistes = 40 } = {}) {
  const deadlineMin = toMinutes(deadlineTime);
  const largestSingleStageNeed = stages.reduce((m, s) => Math.max(m, s.pistesAssigned || 1), 1);
  for (let n = largestSingleStageNeed; n <= maxPistes; n++) {
    const result = simulate(stages, { pistes: buildPistes(n), dayStart, competitionStart });
    if (result.finishMinutes <= deadlineMin) {
      return { pistesNeeded: n, result };
    }
  }
  return { pistesNeeded: null, result: simulate(stages, { pistes: buildPistes(maxPistes), dayStart, competitionStart }) };
}

module.exports = { simulate, solveForPistes, solveForDeadline, toMinutes, toHHMM };
