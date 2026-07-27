'use strict';
const db                = require('../db');
const Pool               = require('./pools');
const Competition        = require('./competitions');
const CompetitionReferee = require('./competitionReferees');
const { maxBipartiteMatching } = require('../lib/bipartiteMatching');

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

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const PoolRefereeAssignment = {
  // Assigns a referee to every pool in a phase, drawn from the competition's
  // registered roster (services/competitionReferees.js — "the referees
  // present", per FIE Technical Rules t.50.1). Per t.50.2, prefers a referee
  // who shares none of the competition's configured referee_separation
  // criteria (nationality/club) with any fencer in that pool "if possible"
  // — the rule gives no algorithm beyond "if possible", so this finds the
  // true maximum number of fully clean assignments first (bipartite
  // matching, not a greedy first-fit that could leave avoidable conflicts),
  // then only relaxes one conflict criterion at a time for whichever pools
  // still need it, using only referees not already used elsewhere in this
  // phase — every pool in a phase runs at the same time, so no two pools
  // can share a referee. Scoped to this phase only: it does not check for
  // a referee already double-booked on some other phase/competition at the
  // same time (that's `opp2.html`'s separate pipeline-scheduling conflict
  // check, which only applies once slots are actually scheduled).
  //
  // Returns { assigned: [{pool_id, referee_id, conflicts}], unassigned: [pool_id] }.
  // `unassigned` means the roster genuinely doesn't have enough referees for
  // every pool in this phase, regardless of conflicts — add more referees
  // to the roster or assign those pools by hand.
  autoAssign(phaseId) {
    const phase = db.prepare('SELECT * FROM phases WHERE id = ?').get(phaseId);
    if (!phase) throw Object.assign(new Error('Phase not found'), { status: 404 });
    if (phase.type !== 'pool') throw Object.assign(new Error('Not a pool phase'), { status: 400 });

    const comp = Competition.findById(phase.competition_id);
    const criteria = parseSeparation(comp?.referee_separation);

    const pools = Pool.findByPhase(phaseId).map(p => Pool.findById(p.id));
    if (!pools.length) return { assigned: [], unassigned: [] };

    const roster = shuffle(CompetitionReferee.findAll(phase.competition_id));

    let remainingPools    = pools.map((_, i) => i);
    let remainingReferees = roster.map((_, i) => i);
    const assignedRefIdx   = new Array(pools.length).fill(-1);
    const assignedConflict = new Array(pools.length).fill(null);

    const maxThreshold = criteria.length; // 0 = clean, up to criteria.length = every criterion violated
    for (let threshold = 0; threshold <= maxThreshold && remainingPools.length; threshold++) {
      const leftIds  = remainingPools;
      const rightIds = remainingReferees;
      const adjacency = leftIds.map(poolIdx => {
        const fencers = pools[poolIdx].competitors;
        const out = [];
        rightIds.forEach((refIdx, localRightIdx) => {
          if (conflictCount(roster[refIdx], fencers, criteria) <= threshold) out.push(localRightIdx);
        });
        return out;
      });

      const matchLeft = maxBipartiteMatching(leftIds.length, rightIds.length, adjacency);

      const stillUnmatchedPools = [];
      const usedRightLocalIdx = new Set();
      matchLeft.forEach((localRightIdx, localLeftIdx) => {
        const poolIdx = leftIds[localLeftIdx];
        if (localRightIdx === -1) { stillUnmatchedPools.push(poolIdx); return; }
        const refIdx = rightIds[localRightIdx];
        assignedRefIdx[poolIdx]   = refIdx;
        assignedConflict[poolIdx] = conflictCount(roster[refIdx], pools[poolIdx].competitors, criteria);
        usedRightLocalIdx.add(localRightIdx);
      });

      remainingPools    = stillUnmatchedPools;
      remainingReferees = rightIds.filter((_, i) => !usedRightLocalIdx.has(i));
    }

    const assigned = [];
    const unassigned = [];
    pools.forEach((pool, poolIdx) => {
      if (assignedRefIdx[poolIdx] === -1) { unassigned.push(pool.id); return; }
      const referee = roster[assignedRefIdx[poolIdx]];
      Pool.update(pool.id, { referee_id: referee.referee_id });
      assigned.push({ pool_id: pool.id, referee_id: referee.referee_id, conflicts: assignedConflict[poolIdx] });
    });

    return { assigned, unassigned };
  },
};

module.exports = PoolRefereeAssignment;
