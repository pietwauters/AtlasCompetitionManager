'use strict';

// Greedy list-scheduling solver for the tournament schedule planner. Treats
// each stage as one resource block: it needs `pistesAssigned` pistes,
// simultaneously, for `durationMinutes`, no earlier than every stage it
// `dependsOn` has finished. Pistes are one interchangeable pool (real +
// abstract, see services/schedulePlans.js) — this is a standard parallel-
// identical-machines / variable-job-width list-scheduling heuristic, not a
// claim of optimality. It gives a reasonable starting layout; the director
// adjusts individual schedule_plan_slots by hand afterward, and any manual
// edit lasts until the plan is next re-solved (see the plan doc's "one
// evolving plan, re-solved as inputs change" model).
//
// Deliberately does not reason about individual pools/DE rounds within a
// stage (that finer-grained placement is what the real pipeline already
// solves once real pools exist — see services/pipelineSlots.js) — a stage
// here is always a single opaque block.
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

// stages: [{ id, dependsOn: [id, ...], order, durationMinutes, pistesAssigned }]
// options: { totalPistes, dayStart: 'HH:MM' }
// returns: { stageResults: [{id, start, end, pistesUsed: [0-based piste index, ...]}],
//            finishMinutes, finishTime, perCompetitionFinish: Map-like plain object
//            keyed by whatever the caller put in stage.competitionId (optional) }
function simulate(stages, { totalPistes, dayStart = '08:00' }) {
  if (!Number.isInteger(totalPistes) || totalPistes < 1) {
    throw Object.assign(new Error('totalPistes must be a positive integer'), { status: 400 });
  }
  const dayStartMin = toMinutes(dayStart);
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
  const pisteNextFree = new Array(totalPistes).fill(dayStartMin);
  const results = [];

  while (ready.length) {
    ready.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const stage = ready.shift();

    const K = Math.max(1, Math.min(stage.pistesAssigned || 1, totalPistes));
    const earliestStart = Math.max(
      dayStartMin,
      ...(stage.dependsOn || []).map(depId => finishOf.get(depId) ?? dayStartMin)
    );

    const byNextFree = pisteNextFree.map((t, i) => [t, i]).sort((a, b) => a[0] - b[0]);
    const chosen = byNextFree.slice(0, K);
    const kthFree = chosen[chosen.length - 1][0];
    const start = Math.max(earliestStart, kthFree);
    const end = start + Math.max(0, stage.durationMinutes || 0);
    for (const [, idx] of chosen) pisteNextFree[idx] = end;

    finishOf.set(stage.id, end);
    results.push({ id: stage.id, start, end, pistesUsed: chosen.map(([, i]) => i) });

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
    stageResults: results.map(r => ({ ...r, start: toHHMM(r.start), end: toHHMM(r.end) })),
    finishMinutes,
    finishTime: toHHMM(finishMinutes),
  };
}

// Given piste count -> finish time. Thin wrapper for symmetry with
// solveForDeadline below; both directions share the one simulate() core.
function solveForPistes(stages, totalPistes, dayStart) {
  return simulate(stages, { totalPistes, dayStart });
}

// Given a deadline -> minimum piste count that meets it. Linear search
// (tournament piste counts are small — dozens at most — so this is instant;
// no need for binary search sophistication).
function solveForDeadline(stages, deadlineTime, dayStart, { maxPistes = 40 } = {}) {
  const deadlineMin = toMinutes(deadlineTime);
  const largestSingleStageNeed = stages.reduce((m, s) => Math.max(m, s.pistesAssigned || 1), 1);
  for (let n = largestSingleStageNeed; n <= maxPistes; n++) {
    const result = simulate(stages, { totalPistes: n, dayStart });
    if (result.finishMinutes <= deadlineMin) {
      return { pistesNeeded: n, result };
    }
  }
  return { pistesNeeded: null, result: simulate(stages, { totalPistes: maxPistes, dayStart }) };
}

module.exports = { simulate, solveForPistes, solveForDeadline, toMinutes, toHHMM };
