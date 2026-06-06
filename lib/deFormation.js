'use strict';

// Smallest power of 2 that is >= n.
function getTableauSize(n) {
  if (n <= 2) return 2;
  let T = 2;
  while (T < n) T *= 2;
  return T;
}

// Returns an array of length T where each element is the seed rank (1-indexed)
// assigned to that tableau slot. Consecutive pairs are R1 bouts:
//   slots[0] vs slots[1], slots[2] vs slots[3], …
// Properties:
//   - Seed 1 is at slot 0 (position 1), seed 2 is at slot T-1 (position T).
//   - If every higher seed wins, seeds 1 and 2 meet only in the final,
//     seeds 2 and 3 meet only in the semi-final, etc.
// Algorithm: at each doubling, odd-indexed slots expand as [s, T+1-s]
// and even-indexed slots expand as [T+1-s, s], keeping seed 2 anchored
// at the last slot through every level.
function buildSeedPositions(T) {
  let slots = [1, 2];
  let cur = 2;
  while (cur < T) {
    cur *= 2;
    const next = [];
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      if (i % 2 === 0) next.push(s, cur + 1 - s);
      else             next.push(cur + 1 - s, s);
    }
    slots = next;
  }
  return slots;
}

// Build the DE structure from a ranked competitors array (index 0 = best rank).
// Returns:
//   tableauSize  – power-of-2 size of the bracket
//   byeCount     – number of top seeds that get a first-round bye
//   totalRounds  – log2(tableauSize)
//   r1Bouts      – array of R1 bout descriptors
function buildDE(competitors) {
  const N = competitors.length;
  if (N < 2) throw Object.assign(new Error('Need at least 2 competitors for DE.'), { status: 400 });

  const T        = getTableauSize(N);
  const byeCount = T - N;
  const seedSlots = buildSeedPositions(T);
  const bySeed    = {};
  for (let i = 0; i < N; i++) bySeed[i + 1] = competitors[i];

  const r1Bouts = [];
  for (let i = 0; i < T; i += 2) {
    r1Bouts.push({
      left:            bySeed[seedSlots[i]]     || null,
      right:           bySeed[seedSlots[i + 1]] || null,
      tableauPosition: i / 2 + 1,
      leftSeed:        seedSlots[i],
      rightSeed:       seedSlots[i + 1],
    });
  }

  return { tableauSize: T, byeCount, totalRounds: Math.log2(T), r1Bouts };
}

// ---------------------------------------------------------------------------
// Build the full bracket tree — main bracket + all placement sub-brackets —
// as a flat array of bout descriptor nodes with all routing pointers wired.
//
// Node fields (tempId = index in the returned array):
//   bracket, de_round, tableau_position, bout_order
//   leftCompetitorId, rightCompetitorId  (set for main R1; null otherwise)
//   leftSeed, rightSeed   (expected seeds; for derivation only, not stored in DB)
//   status, winner_id, left_score, right_score  (pre-set for bye bouts)
//   winnerNextTempId, winnerNextSide  ('left'|'right'|null)
//   loserNextTempId,  loserNextSide
//   place_rank  (terminal placement bouts only: first place being contested)
//
// AP (allPlacesFenced) determines which main-bracket rounds produce loser groups:
//   AP = rule.placement.allPlacesFenced ?? (thirdPlaceBout ? 4 : 2)
// A round R qualifies when: T / 2^(R-1) ≤ AP  (effectiveTableau ≤ AP)
// Start place for that group = T / 2^R + 1
// ---------------------------------------------------------------------------
function buildFullBracket(competitors, rule) {
  const N = competitors.length;
  if (N < 2) throw Object.assign(new Error('Need at least 2 competitors for DE.'), { status: 400 });

  const T           = getTableauSize(N);
  const totalRounds = Math.log2(T);
  const seedSlots   = buildSeedPositions(T);

  const AP = rule.placement?.allPlacesFenced
    ?? (rule.placement?.thirdPlaceBout ? 4 : 2);

  const nodes = [];
  let boutOrderSeq = 1;

  function newNode(bracket, de_round, tableau_position, place_rank) {
    const n = {
      tempId: nodes.length,
      bracket,
      de_round:          de_round  ?? null,
      tableau_position:  tableau_position ?? null,
      bout_order:        boutOrderSeq++,
      leftCompetitorId:  null,
      rightCompetitorId: null,
      leftSeed:          null,
      rightSeed:         null,
      status:    'pending',
      winner_id: null,
      left_score:  null,
      right_score: null,
      winnerNextTempId: null,
      winnerNextSide:   null,
      loserNextTempId:  null,
      loserNextSide:    null,
      place_rank: place_rank ?? null,
    };
    nodes.push(n);
    return n;
  }

  // ── Main bracket ───────────────────────────────────────────────────────────

  const mainNodes = {};
  for (let round = 1; round <= totalRounds; round++) {
    mainNodes[round] = {};
    const boutsInRound = T / Math.pow(2, round);
    for (let pos = 1; pos <= boutsInRound; pos++) {
      mainNodes[round][pos] = newNode('main', round, pos, null);
    }
  }

  // Wire winner routing for all main rounds except the final
  for (let round = 1; round < totalRounds; round++) {
    const boutsInRound = T / Math.pow(2, round);
    for (let pos = 1; pos <= boutsInRound; pos++) {
      const node    = mainNodes[round][pos];
      const nextPos = Math.ceil(pos / 2);
      const next    = mainNodes[round + 1][nextPos];
      node.winnerNextTempId = next.tempId;
      node.winnerNextSide   = pos % 2 === 1 ? 'left' : 'right';
    }
  }

  // Populate R1 participants, seeds, and byes
  const bySeed = {};
  for (let i = 0; i < N; i++) bySeed[i + 1] = competitors[i];

  for (let i = 0; i < T; i += 2) {
    const pos   = i / 2 + 1;
    const lSeed = seedSlots[i];
    const rSeed = seedSlots[i + 1];
    const node  = mainNodes[1][pos];
    const lComp = bySeed[lSeed] || null;
    const rComp = bySeed[rSeed] || null;

    node.leftCompetitorId  = lComp?.competitor_id ?? null;
    node.rightCompetitorId = rComp?.competitor_id ?? null;
    node.leftSeed  = lSeed;
    node.rightSeed = rSeed;

    if (!lComp || !rComp) {
      const winner   = lComp ?? rComp;
      node.status    = 'finished';
      node.winner_id = winner.competitor_id;
      node.left_score  = lComp ? 1 : 0;
      node.right_score = rComp ? 1 : 0;
    }
  }

  // Propagate expected seeds to all subsequent main-bracket rounds
  for (let round = 2; round <= totalRounds; round++) {
    const boutsInRound = T / Math.pow(2, round);
    for (let pos = 1; pos <= boutsInRound; pos++) {
      const node  = mainNodes[round][pos];
      const prevL = mainNodes[round - 1][2 * pos - 1];
      const prevR = mainNodes[round - 1][2 * pos];
      node.leftSeed  = Math.min(prevL.leftSeed, prevL.rightSeed);
      node.rightSeed = Math.min(prevR.leftSeed, prevR.rightSeed);
    }
  }

  // ── Placement bracket ─────────────────────────────────────────────────────
  //
  // source: { node, srcType: 'winner'|'loser', origSeed }
  // Wires src's winner or loser into targetBout[side].
  function wireSrc(src, targetBout, side) {
    if (src.srcType === 'winner') {
      src.node.winnerNextTempId = targetBout.tempId;
      src.node.winnerNextSide   = side;
    } else {
      src.node.loserNextTempId = targetBout.tempId;
      src.node.loserNextSide   = side;
    }
  }

  // Recursively build a placement group for sortedSources (sorted by origSeed
  // ascending, index 0 = best).  startPlace = first place being contested.
  function buildGroup(sortedSources, startPlace) {
    const M = sortedSources.length; // always a power of 2, M >= 2

    if (M === 2) {
      const bout = newNode('placement', null, null, startPlace);
      wireSrc(sortedSources[0], bout, 'left');
      wireSrc(sortedSources[1], bout, 'right');
      return;
    }

    const slots   = buildSeedPositions(M);
    const r1Nodes = [];

    for (let k = 0; k < M / 2; k++) {
      const lSrc = sortedSources[slots[2 * k]     - 1]; // slots is 1-based
      const rSrc = sortedSources[slots[2 * k + 1] - 1];
      const bout = newNode('placement', null, null, null);

      wireSrc(lSrc, bout, 'left');
      wireSrc(rSrc, bout, 'right');

      r1Nodes.push({
        node:               bout,
        expectedWinnerSeed: Math.min(lSrc.origSeed, rSrc.origSeed),
        expectedLoserSeed:  Math.max(lSrc.origSeed, rSrc.origSeed),
      });
    }

    // Upper sub-group: winners, sorted by expectedWinnerSeed (best first)
    const winnerSrcs = r1Nodes
      .slice()
      .sort((a, b) => a.expectedWinnerSeed - b.expectedWinnerSeed)
      .map(r => ({ node: r.node, srcType: 'winner', origSeed: r.expectedWinnerSeed }));

    // Lower sub-group: losers, sorted by expectedLoserSeed (best first)
    const loserSrcs = r1Nodes
      .slice()
      .sort((a, b) => a.expectedLoserSeed - b.expectedLoserSeed)
      .map(r => ({ node: r.node, srcType: 'loser', origSeed: r.expectedLoserSeed }));

    buildGroup(winnerSrcs, startPlace);           // places startPlace..startPlace+M/2-1
    buildGroup(loserSrcs,  startPlace + M / 2);  // places startPlace+M/2..startPlace+M-1
  }

  // For each qualifying main-bracket round, gather its expected losers and build
  // the placement sub-bracket.
  for (let round = 1; round < totalRounds; round++) {
    const effectiveTableau = T / Math.pow(2, round - 1);
    if (effectiveTableau > AP) continue;

    const groupSize  = T / Math.pow(2, round);
    const startPlace = groupSize + 1;

    const loserSrcs = [];
    for (let pos = 1; pos <= groupSize; pos++) {
      const node            = mainNodes[round][pos];
      const expectedLoserSeed = Math.max(node.leftSeed, node.rightSeed);
      loserSrcs.push({ node, srcType: 'loser', origSeed: expectedLoserSeed });
    }
    loserSrcs.sort((a, b) => a.origSeed - b.origSeed); // best loser first

    buildGroup(loserSrcs, startPlace);
  }

  return { nodes, tableauSize: T, totalRounds };
}

module.exports = { getTableauSize, buildSeedPositions, buildDE, buildFullBracket };
