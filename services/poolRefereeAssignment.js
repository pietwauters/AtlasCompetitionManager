'use strict';
const db                = require('../db');
const Pool               = require('./pools');
const Competition        = require('./competitions');
const CompetitionReferee = require('./competitionReferees');
const { maxBipartiteMatching, findDeficientSet } = require('../lib/bipartiteMatching');

function parseSeparation(value) {
  return (value || '').split(',').map(s => s.trim()).filter(Boolean);
}

// Number of active referee_separation criteria this referee violates
// against a pool's fencers. A referee with no club is neutral for the
// `club` criterion — an unaffiliated/independent referee never "shares a
// club" with anyone, regardless of the fencers' own clubs.
function conflictCount(referee, fencers, criteria) {
  let n = 0;
  for (const c of criteria) {
    if (c === 'nationality') {
      if (referee.nationality && fencers.some(f => f.nationality === referee.nationality)) n++;
    } else if (c === 'club') {
      if (referee.club_id && fencers.some(f => f.club_id === referee.club_id)) n++;
    }
  }
  return n;
}

// Which nationalities/clubs a new referee would need to avoid to be clean
// for this pool — the actual, concrete answer to "what referee do I need to
// go find," not just an abstract conflict count.
function poolAttributes(pool) {
  const nationalities = [...new Set(pool.competitors.map(f => f.nationality).filter(Boolean))];
  const clubMap = new Map();
  for (const f of pool.competitors) {
    if (f.club_id) clubMap.set(f.club_id, f.club_name);
  }
  return {
    pool_id: pool.id,
    criteria: pool.__criteria,
    nationalities,
    clubs: [...clubMap.entries()].map(([club_id, club_name]) => ({ club_id, club_name })),
  };
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const stmtCombinablePoolPhases = db.prepare(`
  SELECT ph.id AS phase_id, ph.phase_order, ph.status AS phase_status,
         c.id AS competition_id, c.name AS competition_name, c.weapon, c.gender,
         COUNT(p.id) AS pool_count,
         SUM(CASE WHEN p.referee_id IS NOT NULL THEN 1 ELSE 0 END) AS pools_with_referee
  FROM phases ph
  JOIN competitions c ON c.id = ph.competition_id
  LEFT JOIN pools p ON p.phase_id = ph.id
  WHERE c.tournament_id = ? AND ph.type = 'pool'
  GROUP BY ph.id
  ORDER BY c.name, ph.phase_order
`);

const PoolRefereeAssignment = {
  // Every pool phase belonging to a competition in this tournament — the
  // candidate list for the "combine competitions" auto-assign UI. Callers
  // decide which of these actually run at the same time (see autoAssign's
  // own doc comment; Atlas has no schedule-aware model for pool phases to
  // verify this automatically yet).
  listCombinablePoolPhases(tournamentId) {
    return stmtCombinablePoolPhases.all(Number(tournamentId));
  },


  // Assigns a referee to every pool across one or more phases (all treated
  // as running at the same time, so no two pools may share a referee — see
  // CLAUDE.md's "Combined multi-competition pool referee auto-assignment"
  // for when/why you'd pass more than one phase id at once, e.g. several
  // competitions' pool rounds in the same tournament fencing simultaneously).
  // Each pool keeps its own competition's referee_separation criteria;
  // referees are drawn from the union of every involved competition's
  // effective roster (services/competitionReferees.js — "the referees
  // present", per FIE Technical Rules t.50.1).
  //
  // Per t.50.2, prefers a referee who shares none of the active criteria
  // (nationality/club) with any fencer in that pool "if possible" — the
  // rule gives no algorithm beyond "if possible", so this finds the true
  // maximum number of fully clean assignments first (bipartite matching,
  // not a greedy first-fit that could leave an avoidable conflict), then
  // only relaxes one conflict criterion at a time for whichever pools still
  // need it, using only referees not already used elsewhere in this solve.
  //
  // Returns:
  //   assigned:   [{pool_id, referee_id, conflicts}]
  //   unassigned: [pool_id, ...] — the roster genuinely doesn't have enough
  //               referees for every pool, regardless of conflicts
  //   shortfalls: [{threshold, pools, compatible_referee_ids, shortfall}]
  //               — a Hall/König deficiency certificate for every stage that
  //               couldn't fully resolve. `pools` is the cluster of pools
  //               that were, between them, competing for too few referees
  //               satisfying that threshold's conflict tolerance — each
  //               entry is {pool_id, criteria, nationalities, clubs}, the
  //               actual nationalities/clubs present among that pool's
  //               fencers (what tells the director *what kind* of referee to
  //               add, not just that one is missing). compatible_referee_ids is the
  //               limited pool of referees the whole cluster can currently
  //               draw from; shortfall = pools.length - compatible_referee_ids.length
  //               is how many more referees (avoiding those nationalities/
  //               clubs) are needed to fully resolve this cluster.
  autoAssign(phaseIds) {
    const ids = Array.isArray(phaseIds) ? phaseIds : [phaseIds];
    if (!ids.length) return { assigned: [], unassigned: [], shortfalls: [] };

    const phases = ids.map(id => {
      const phase = db.prepare('SELECT * FROM phases WHERE id = ?').get(id);
      if (!phase) throw Object.assign(new Error('Phase ' + id + ' not found'), { status: 404 });
      if (phase.type !== 'pool') throw Object.assign(new Error('Phase ' + id + ' is not a pool phase'), { status: 400 });
      return phase;
    });

    // One criteria array + roster contribution per distinct competition
    // involved (several phases can belong to the same competition).
    const criteriaByCompId = new Map();
    const refereeById = new Map(); // dedup union across all involved competitions
    for (const phase of phases) {
      if (criteriaByCompId.has(phase.competition_id)) continue;
      const comp = Competition.findById(phase.competition_id);
      criteriaByCompId.set(phase.competition_id, parseSeparation(comp?.referee_separation));
      for (const r of CompetitionReferee.findAll(phase.competition_id)) {
        refereeById.set(r.referee_id, r);
      }
    }

    const pools = [];
    for (const phase of phases) {
      for (const p of Pool.findByPhase(phase.id)) {
        const full = Pool.findById(p.id);
        pools.push({ ...full, __criteria: criteriaByCompId.get(phase.competition_id) });
      }
    }
    if (!pools.length) return { assigned: [], unassigned: [], shortfalls: [] };

    const roster = shuffle([...refereeById.values()]);

    let remainingPools    = pools.map((_, i) => i);
    let remainingReferees = roster.map((_, i) => i);
    const assignedRefIdx   = new Array(pools.length).fill(-1);
    const assignedConflict = new Array(pools.length).fill(null);
    const shortfalls = [];

    const maxThreshold = pools.reduce((m, p) => Math.max(m, p.__criteria.length), 0);
    for (let threshold = 0; threshold <= maxThreshold && remainingPools.length; threshold++) {
      const leftIds  = remainingPools;
      const rightIds = remainingReferees;
      const adjacency = leftIds.map(poolIdx => {
        const pool = pools[poolIdx];
        const out = [];
        rightIds.forEach((refIdx, localRightIdx) => {
          if (conflictCount(roster[refIdx], pool.competitors, pool.__criteria) <= threshold) out.push(localRightIdx);
        });
        return out;
      });

      const matchLeft = maxBipartiteMatching(leftIds.length, rightIds.length, adjacency);

      const stillUnmatchedLocal = [];
      matchLeft.forEach((localRightIdx, localLeftIdx) => {
        if (localRightIdx === -1) stillUnmatchedLocal.push(localLeftIdx);
      });

      if (stillUnmatchedLocal.length) {
        const { S, T } = findDeficientSet(leftIds.length, rightIds.length, adjacency, matchLeft);
        shortfalls.push({
          threshold,
          pools: S.map(i => poolAttributes(pools[leftIds[i]])),
          compatible_referee_ids: T.map(i => roster[rightIds[i]].referee_id),
          shortfall: S.length - T.length,
        });
      }

      const usedRightLocalIdx = new Set();
      matchLeft.forEach((localRightIdx, localLeftIdx) => {
        if (localRightIdx === -1) return;
        const poolIdx = leftIds[localLeftIdx];
        const refIdx  = rightIds[localRightIdx];
        assignedRefIdx[poolIdx]   = refIdx;
        assignedConflict[poolIdx] = conflictCount(roster[refIdx], pools[poolIdx].competitors, pools[poolIdx].__criteria);
        usedRightLocalIdx.add(localRightIdx);
      });

      remainingPools    = stillUnmatchedLocal.map(li => leftIds[li]);
      remainingReferees = rightIds.filter((_, i) => !usedRightLocalIdx.has(i));

      // No referees left at all — relaxing the conflict tolerance further
      // can never help, so stop instead of re-reporting the identical
      // shortfall at every remaining threshold level.
      if (!remainingReferees.length) break;
    }

    const assigned = [];
    const unassigned = [];
    pools.forEach((pool, poolIdx) => {
      if (assignedRefIdx[poolIdx] === -1) { unassigned.push(pool.id); return; }
      const referee = roster[assignedRefIdx[poolIdx]];
      Pool.update(pool.id, { referee_id: referee.referee_id });
      assigned.push({ pool_id: pool.id, referee_id: referee.referee_id, conflicts: assignedConflict[poolIdx] });
    });

    return { assigned, unassigned, shortfalls };
  },
};

module.exports = PoolRefereeAssignment;
