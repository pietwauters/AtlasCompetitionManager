'use strict';

// Greedy list-scheduling solver for the tournament schedule planner. Treats
// each stage as one resource block: it needs `pistesAssigned` pistes,
// simultaneously, for `durationMinutes`, no earlier than every stage it
// `dependsOn` has finished and no earlier than its competition's own start
// floor (see competitionStart below). This is a standard parallel-identical-
// machines / variable-job-width list-scheduling heuristic, not a claim of
// optimality. It gives a reasonable starting layout; the director adjusts
// individual schedule_plan_slots by hand afterward, and any manual edit
// lasts until the plan is next re-solved (see the plan doc's "one evolving
// plan, re-solved as inputs change" model).
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
function isEligible(piste, unit) {
  if (unit.phaseType === 'pool') return !!piste.poolsAllowed;
  return !!piste.deAllowed
    && (piste.maxDeTableau == null || unit.tableauSize <= piste.maxDeTableau)
    && (piste.minDeTableau == null || unit.tableauSize >= piste.minDeTableau);
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

// A static "how many different kinds of work could this piste ever do"
// score, independent of any specific plan — used only to break ties in
// findEarliestSlot below when a unit has more than one eligible-and-free
// piste to pick from. A piste with no min/max restriction (e.g. a video
// piste with no round-size limit) can serve every DE round of every
// competition; a piste restricted to a narrow tableau-size band (e.g.
// min_de_tableau=32, only the big early rounds) can only ever serve a few.
// Preferring to consume the narrow piste first — even when both are
// eligible and idle — protects the broad piste for whichever later, more
// specialized unit turns out to have no other option (2026-08-27: without
// this, an unrestricted Women's Sabre T64 round would grab a colored/video
// piste just because it happened to be idle longest, needlessly delaying a
// Men's Foil T32 round that could ONLY use that piste, even though plenty
// of ordinary pistes were free and just as usable for the Sabre round).
function pisteBreadth(piste) {
  let score = piste.poolsAllowed ? 1 : 0;
  if (piste.deAllowed) {
    score += DE_TABLEAU_SIZES.filter(t =>
      (piste.maxDeTableau == null || t <= piste.maxDeTableau) &&
      (piste.minDeTableau == null || t >= piste.minDeTableau)
    ).length;
  }
  return score;
}

// Earliest common start >= earliestStart at which at least K of the given
// pistes are simultaneously free for `duration` minutes. Candidate starts
// are earliestStart itself plus every existing interval's end among the
// eligible pistes (availability can only change at those points) — a
// standard sweep, not a search over every minute.
function findEarliestSlot(eligibleIndices, pisteIntervals, earliestStart, duration, K, pisteBreadthScore) {
  const candidates = new Set([earliestStart]);
  for (const idx of eligibleIndices) {
    for (const [, e] of pisteIntervals[idx]) {
      if (e >= earliestStart) candidates.add(e);
    }
  }
  const sorted = [...candidates].sort((a, b) => a - b);
  for (const start of sorted) {
    const free = eligibleIndices.filter(idx => isFreeDuring(pisteIntervals[idx], start, start + duration));
    if (free.length >= K) {
      // Narrowest-eligibility pistes first (see pisteBreadth), then whoever
      // has been idle longest (their last interval ends earliest) — keeps
      // behavior close to the old "least-recently-used" tie-break among
      // pistes of equal breadth, e.g. spreading load across several
      // identical unrestricted pistes rather than always picking the same one.
      free.sort((a, b) => {
        const breadthDiff = pisteBreadthScore[a] - pisteBreadthScore[b];
        if (breadthDiff !== 0) return breadthDiff;
        const lastA = pisteIntervals[a].length ? pisteIntervals[a][pisteIntervals[a].length - 1][1] : -Infinity;
        const lastB = pisteIntervals[b].length ? pisteIntervals[b][pisteIntervals[b].length - 1][1] : -Infinity;
        return lastA - lastB || a - b;
      });
      return { start, chosen: free.slice(0, K) };
    }
  }
  return null; // unreachable when eligibleIndices.length >= K
}

// stages: [{ id, dependsOn: [id,...], order, durationMinutes, pistesAssigned,
//            phaseType: 'pool'|'de', tableauSize?, competitionId, restMinutes?, fixedStart? }]
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
// pistes: [{ poolsAllowed, deAllowed, maxDeTableau, minDeTableau }] — index in this array
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
  const pisteBreadthScore = pistes.map(pisteBreadth);
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
    const K = Math.max(1, Math.min(stage.pistesAssigned || 1, eligible.length));

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

    const duration = Math.max(0, stage.durationMinutes || 0);
    const slot = findEarliestSlot(eligible, pisteIntervals, earliestStart, duration, K, pisteBreadthScore);
    const { start, chosen } = slot;
    const end = start + duration;
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
