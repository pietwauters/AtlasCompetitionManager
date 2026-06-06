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
//
// Repechage (rule.repechage.enabled):
//   T = getTableauSize(N); numRepRounds = log2(T/reentryAt).
//   Main bracket goes only to lastMainRound = numRepRounds+1.
//   Repechage tables D/E/F/G (bracket='repechage') follow, then Finals
//   bracket (bracket='main', de_round continuing from lastMainRound+1).
// ---------------------------------------------------------------------------
function buildFullBracket(competitors, rule) {
  const N = competitors.length;
  if (N < 2) throw Object.assign(new Error('Need at least 2 competitors for DE.'), { status: 400 });

  const isRepechage  = !!(rule.repechage?.enabled);
  const reT          = isRepechage ? rule.repechage.reentryAt : null;

  // T is always the smallest power of 2 ≥ N; numRepRounds scales with actual T
  // so the repechage structure is correct for any N (e.g. N=16 → T=16 → 1 rep round,
  // N=25 → T=32 → 2 rep rounds).  Forcing T=fromTableau caused all R1 bouts to be
  // byes when N ≤ fromTableau/2, leaving Table D empty.
  const T = getTableauSize(N);
  if (isRepechage && T < reT * 2)
    throw Object.assign(new Error(`Need at least ${reT * 2} competitors for this repechage format.`), { status: 400 });

  const numRepRounds  = isRepechage ? Math.round(Math.log2(T / reT)) : 0;
  const lastMainRound = isRepechage ? numRepRounds + 1 : null;

  // For repechage the main bracket runs only to lastMainRound; for standard DE
  // it runs all the way to the final.
  const mainRounds = isRepechage ? lastMainRound : Math.log2(T);

  const seedSlots = buildSeedPositions(T);

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

  // ── Main bracket ───────────────────────────────────────────────────────────

  const mainNodes = {};
  for (let round = 1; round <= mainRounds; round++) {
    mainNodes[round] = {};
    const boutsInRound = T / Math.pow(2, round);
    for (let pos = 1; pos <= boutsInRound; pos++) {
      mainNodes[round][pos] = newNode('main', round, pos, null);
    }
  }

  // Wire winner routing for all main rounds except the last
  // (repechage: lastMainRound winners feed Finals H, wired below)
  for (let round = 1; round < mainRounds; round++) {
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
  for (let round = 2; round <= mainRounds; round++) {
    const boutsInRound = T / Math.pow(2, round);
    for (let pos = 1; pos <= boutsInRound; pos++) {
      const node  = mainNodes[round][pos];
      const prevL = mainNodes[round - 1][2 * pos - 1];
      const prevR = mainNodes[round - 1][2 * pos];
      node.leftSeed  = Math.min(prevL.leftSeed, prevL.rightSeed);
      node.rightSeed = Math.min(prevR.leftSeed, prevR.rightSeed);
    }
  }

  // ── Repechage path ────────────────────────────────────────────────────────

  if (isRepechage) {
    // repBouts[de_round] = flat array of bout nodes for that repechage de_round.
    // de_round 1 = D (intra), 2 = E (injection), 3 = F (intra), 4 = G (injection), …
    const repBouts = {};

    // Table D: pair consecutive R1-losers by position (positions 2k-1 vs 2k)
    {
      const numR1 = T / 2;
      const r1arr = [];
      for (let pos = 1; pos <= numR1; pos++) r1arr.push(mainNodes[1][pos]);
      const dBouts = [];
      for (let k = 0; k < numR1 / 2; k++) {
        const bout = newNode('repechage', 1, k + 1, null);
        wireSrc({ node: r1arr[2 * k],     srcType: 'loser' }, bout, 'left');
        wireSrc({ node: r1arr[2 * k + 1], srcType: 'loser' }, bout, 'right');
        dBouts.push(bout);
      }
      repBouts[1] = dBouts;
    }

    // Tables E/G (injection) and F (intra between injection rounds)
    for (let inj = 0; inj < numRepRounds; inj++) {
      const injMainRound = inj + 2;        // main round whose losers inject: R2 for inj=0
      const prevRepRound = 2 * inj + 1;   // D=1, F=3
      const injRepRound  = 2 * inj + 2;   // E=2, G=4

      const numMainBouts = T / Math.pow(2, injMainRound);
      const mainLosers   = [];
      for (let pos = 1; pos <= numMainBouts; pos++) {
        mainLosers.push({ node: mainNodes[injMainRound][pos], srcType: 'loser' });
      }

      const prevWinners = repBouts[prevRepRound].map(b => ({ node: b, srcType: 'winner' }));

      // FIE seeding: mainLosers = seeds 1..M/2, prevWinners = seeds M/2+1..M
      const M        = mainLosers.length + prevWinners.length;
      const injSeeds = buildSeedPositions(M);
      const sources  = new Array(M + 1); // 1-indexed
      mainLosers.forEach((src, i)  => { sources[i + 1]         = src; });
      prevWinners.forEach((src, i) => { sources[M / 2 + i + 1] = src; });

      const injBouts = [];
      for (let k = 0; k < M / 2; k++) {
        const bout = newNode('repechage', injRepRound, k + 1, null);
        wireSrc(sources[injSeeds[2 * k]],     bout, 'left');
        wireSrc(sources[injSeeds[2 * k + 1]], bout, 'right');
        injBouts.push(bout);
      }
      repBouts[injRepRound] = injBouts;

      // Build next intra round (F) if there is another injection after this one
      if (inj < numRepRounds - 1) {
        const intraRepRound = injRepRound + 1;
        const intraBouts    = [];
        for (let k = 0; k < injBouts.length / 2; k++) {
          const bout = newNode('repechage', intraRepRound, k + 1, null);
          wireSrc({ node: injBouts[2 * k],     srcType: 'winner' }, bout, 'left');
          wireSrc({ node: injBouts[2 * k + 1], srcType: 'winner' }, bout, 'right');
          intraBouts.push(bout);
        }
        repBouts[intraRepRound] = intraBouts;
      }
    }

    // ── Finals bracket (H, I, J) — bracket='main', de_round = lastMainRound+1 … ──
    // Seeds 1..reT/2: main lastMainRound winners.
    // Seeds reT/2+1..reT: last repechage round winners (G-winners).
    const lastRepRound  = 2 * numRepRounds;
    const finalsRounds  = Math.log2(reT);
    const finalsSeedSlots = buildSeedPositions(reT);

    const numLastMain   = T / Math.pow(2, lastMainRound);
    const finalsSources = new Array(reT + 1); // 1-indexed
    for (let pos = 1; pos <= numLastMain; pos++) {
      finalsSources[pos] = { node: mainNodes[lastMainRound][pos], srcType: 'winner' };
    }
    repBouts[lastRepRound].forEach((b, i) => {
      finalsSources[numLastMain + i + 1] = { node: b, srcType: 'winner' };
    });

    // Create Finals nodes — bracket='main' so results.js sees them as the real final
    const finalsNodes = {};
    for (let fr = 1; fr <= finalsRounds; fr++) {
      const de_round = lastMainRound + fr;
      finalsNodes[fr] = {};
      const boutsInRound = reT / Math.pow(2, fr);
      for (let pos = 1; pos <= boutsInRound; pos++) {
        finalsNodes[fr][pos] = newNode('main', de_round, pos, null);
      }
    }

    // Wire winner routing within finals
    for (let fr = 1; fr < finalsRounds; fr++) {
      const boutsInRound = reT / Math.pow(2, fr);
      for (let pos = 1; pos <= boutsInRound; pos++) {
        const node    = finalsNodes[fr][pos];
        const nextPos = Math.ceil(pos / 2);
        const next    = finalsNodes[fr + 1][nextPos];
        node.winnerNextTempId = next.tempId;
        node.winnerNextSide   = pos % 2 === 1 ? 'left' : 'right';
      }
    }

    // Wire Finals H (fr=1) inputs using FIE reT seeding
    for (let k = 0; k < reT / 2; k++) {
      const pos   = k + 1;
      const lSeed = finalsSeedSlots[2 * k];
      const rSeed = finalsSeedSlots[2 * k + 1];
      wireSrc(finalsSources[lSeed], finalsNodes[1][pos], 'left');
      wireSrc(finalsSources[rSeed], finalsNodes[1][pos], 'right');
    }

    // Bronze bout from Finals SF losers (fr = finalsRounds - 1)
    if (rule.placement?.thirdPlaceBout !== false) {
      const sfRound     = finalsRounds - 1;
      const numSF       = reT / Math.pow(2, sfRound);
      const bronze      = newNode('placement', null, null, 3);
      for (let pos = 1; pos <= numSF; pos++) {
        wireSrc({ node: finalsNodes[sfRound][pos], srcType: 'loser' },
                bronze, pos === 1 ? 'left' : 'right');
      }
    }

    const totalRounds = lastMainRound + finalsRounds;
    return { nodes, tableauSize: T, totalRounds };
  }

  // ── Placement bracket (non-repechage) ─────────────────────────────────────

  const totalRounds = Math.log2(T);

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
