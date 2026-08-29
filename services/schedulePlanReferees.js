'use strict';

// Referee-sufficiency analysis for the tournament schedule planner — a
// separate, non-blocking check layered on top of the solved piste layout
// (see services/schedulePlanSolver.js). A referee shortage is a flagged
// risk (FIE Technical Rules t.50 neutrality is "if possible"), not a hard
// scheduling constraint the way a piste shortage is, so this never feeds
// back into the piste solver itself.
//
// Reuses the same threshold-staged bipartite matching the live pool-referee
// auto-assigner uses (services/poolRefereeAssignment.js's solveAssignment),
// just fed simulated pools (built from real registered competitors, not
// real Pool rows) and a roster padded with abstract placeholder referees to
// cover whatever the real registered roster doesn't yet.

const db = require('../db');
const { formPools } = require('../lib/poolFormation');
const { loadRule } = require('../lib/rules');
const Competition = require('./competitions');
const CompetitionReferee = require('./competitionReferees');
const { computePoolStage, defaultRuleDoc } = require('./schedulePlanEstimate');
const { parseSeparation, solveAssignment } = require('./poolRefereeAssignment');
const { toMinutes } = require('./schedulePlanSolver');

const stmtRegisteredCompetitors = db.prepare(`
  SELECT comp.id AS competitor_id, comp.initial_seed, comp.nationality,
         p.club_id, cl.name AS club_name
  FROM competitors comp
  LEFT JOIN people p  ON p.id  = comp.person_id
  LEFT JOIN clubs  cl ON cl.id = p.club_id
  WHERE comp.competition_id = ? AND comp.status = 'active'
`);

// Groups pool-type stages whose solved [start,end) windows overlap into
// connected clusters — referees are drawn from one shared pool per cluster,
// same as PoolRefereeAssignment.autoAssign's "several phases running at the
// same time" combined-solve mode.
function clusterOverlappingStages(poolStages, resultById) {
  const n = poolStages.length;
  const parent = poolStages.map((_, i) => i);
  function find(i) { return parent[i] === i ? i : (parent[i] = find(parent[i])); }
  function union(i, j) { const a = find(i), b = find(j); if (a !== b) parent[a] = b; }

  const windows = poolStages.map(s => {
    const r = resultById.get(s.id);
    return r ? [toMinutes(r.start), toMinutes(r.end)] : null;
  });
  for (let i = 0; i < n; i++) {
    if (!windows[i]) continue;
    for (let j = i + 1; j < n; j++) {
      if (!windows[j]) continue;
      if (windows[i][0] < windows[j][1] && windows[j][0] < windows[i][1]) union(i, j);
    }
  }

  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(poolStages[i]);
  }
  return [...groups.values()];
}

// Builds a simulated pool split for one stage from its competition's real
// registered (not necessarily checked-in) competitors, using the same
// calcPoolOptions-derived sizing services/schedulePlanEstimate.js already
// computes for the piste/timing estimate — but against the real registered
// count, not the stage's (possibly hand-typed, aspirational) estimated_n.
// Returns null when nothing is registered yet ("insufficient data" — no
// fabricated worst-case distribution).
function simulatedPoolsForStage(stage, competition) {
  const rows = stmtRegisteredCompetitors.all(stage.competition_id);
  if (!rows.length) return null;

  const ruleDoc = stage.rule_doc || defaultRuleDoc('pool');
  const rule = loadRule(ruleDoc);
  const { poolSizes } = computePoolStage(rows.length, ruleDoc, competition.weapon, competition.gender);

  const fencerInput = rows.map((r, i) => ({
    id: r.competitor_id,
    initial_seed: r.initial_seed ?? (i + 1),
    nationality: r.nationality,
    club: r.club_name,     // pool-formation separation keys on club NAME (services/poolPhases.js's own convention)
    club_id: r.club_id,    // carried through unchanged, for the referee-conflict check below (which keys on club_id)
    club_name: r.club_name,
  }));

  const pools = formPools(fencerInput, poolSizes, rule.poolFormation);
  return pools.map((p, idx) => ({
    pool_id: `${stage.id}-p${idx + 1}`,
    fencers: p.fencers.map(f => ({ nationality: f.nationality, club_id: f.club_id, club_name: f.club_name })),
  }));
}

// stages: schedule_plan_stages rows (phase_type/rule_doc/competition_id).
// stageResults: solver output [{id, start, end}], keyed to the same stage ids.
// abstractRefereeCount: schedule_plans.abstract_referee_count — generic,
// no-conflict-info referees padding out whatever's really registered, per
// the "treat known/registered referees as real, pad the rest as abstract"
// design (see docs/schedule-planner-algorithm.md).
//
// Returns a Map<stage.id, {
//   status: 'ok' | 'insufficient_data',
//   registered_referees, abstract_referees_assumed,
//   shortfall,     // how many MORE, beyond registered+assumed, are needed for full neutral coverage
//   shortfalls,    // the Hall/König detail (which nationalities/clubs to avoid) — see solveAssignment
// }>
function computeShortfalls(stages, stageResults, abstractRefereeCount) {
  const resultById = new Map(stageResults.map(r => [r.id, r]));
  const poolStages = stages.filter(s => s.phase_type === 'pool');
  const clusters = clusterOverlappingStages(poolStages, resultById);

  const byStageId = new Map();

  for (const cluster of clusters) {
    const competitionCache = new Map();
    const competitionOf = compId => {
      if (!competitionCache.has(compId)) competitionCache.set(compId, Competition.findById(compId));
      return competitionCache.get(compId);
    };

    const pools = [];
    const insufficientStageIds = new Set();
    for (const stage of cluster) {
      const competition = competitionOf(stage.competition_id);
      const simulated = simulatedPoolsForStage(stage, competition);
      if (!simulated) { insufficientStageIds.add(stage.id); continue; }
      const criteria = parseSeparation(competition?.referee_separation);
      for (const p of simulated) pools.push({ ...p, criteria });
    }

    for (const id of insufficientStageIds) byStageId.set(id, { status: 'insufficient_data' });
    if (!pools.length) continue;

    // Real registered referees across every competition in this cluster,
    // deduped by referee_id — same union PoolRefereeAssignment.autoAssign
    // draws from for a combined multi-competition solve.
    const refereeById = new Map();
    const compIdsInCluster = [...new Set(cluster.map(s => s.competition_id))];
    for (const compId of compIdsInCluster) {
      for (const r of CompetitionReferee.findAll(compId)) refereeById.set(r.referee_id, r);
    }
    const referees = [...refereeById.values()];
    for (let i = 1; i <= abstractRefereeCount; i++) {
      referees.push({ referee_id: -i, nationality: null, club_id: null });
    }

    const result = solveAssignment(pools, referees);
    const shortfall = result.shortfalls.length
      ? Math.max(...result.shortfalls.map(s => s.shortfall))
      : 0;

    for (const stage of cluster) {
      if (insufficientStageIds.has(stage.id)) continue;
      byStageId.set(stage.id, {
        status: 'ok',
        registered_referees: refereeById.size,
        abstract_referees_assumed: abstractRefereeCount,
        shortfall,
        shortfalls: result.shortfalls,
      });
    }
  }

  return byStageId;
}

module.exports = { computeShortfalls, clusterOverlappingStages, simulatedPoolsForStage };
