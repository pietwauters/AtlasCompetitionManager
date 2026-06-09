'use strict';

const { getTableauSize, buildSeedPositions } = require('./deFormation');

// Build a team DE tableau from a sorted teams array (index 0 = best seed).
// Returns { nodes, tableauSize, totalRounds } with the same two-pass insertion
// pattern used by buildFullBracket in deFormation.js.
//
// Node fields:
//   tempId, de_round, tableau_position, match_order
//   leftTeamId, rightTeamId  (null for empty bracket slots / byes)
//   leftSeed, rightSeed
//   status ('pending' or 'finished' for auto-bye matches)
//   winner_team_id  (set for bye matches only)
//   place_rank  (3 for bronze bout, null otherwise)
//   winnerNextTempId, winnerNextSide, loserNextTempId, loserNextSide
function buildTeamTableau(teams, rule) {
  const N = teams.length;
  if (N < 2) throw Object.assign(new Error('Need at least 2 teams for a team DE.'), { status: 400 });

  const T           = getTableauSize(N);
  const totalRounds = Math.log2(T);
  const seedSlots   = buildSeedPositions(T);

  const bySeed = {};
  for (let i = 0; i < N; i++) bySeed[i + 1] = teams[i];

  const nodes = [];
  let matchOrderSeq = 1;

  function newNode(de_round, tableau_position, place_rank) {
    const n = {
      tempId:           nodes.length,
      de_round:         de_round         ?? null,
      tableau_position: tableau_position ?? null,
      match_order:      matchOrderSeq++,
      leftTeamId:       null,
      rightTeamId:      null,
      leftSeed:         null,
      rightSeed:        null,
      status:           'pending',
      winner_team_id:   null,
      place_rank:       place_rank ?? null,
      winnerNextTempId: null,
      winnerNextSide:   null,
      loserNextTempId:  null,
      loserNextSide:    null,
    };
    nodes.push(n);
    return n;
  }

  // Create all main bracket nodes
  const mainNodes = {};
  for (let round = 1; round <= totalRounds; round++) {
    mainNodes[round] = {};
    const count = T / Math.pow(2, round);
    for (let pos = 1; pos <= count; pos++) {
      mainNodes[round][pos] = newNode(round, pos, null);
    }
  }

  // Wire winner routing through all rounds except the final
  for (let round = 1; round < totalRounds; round++) {
    const count = T / Math.pow(2, round);
    for (let pos = 1; pos <= count; pos++) {
      const node    = mainNodes[round][pos];
      const nextPos = Math.ceil(pos / 2);
      const next    = mainNodes[round + 1][nextPos];
      node.winnerNextTempId = next.tempId;
      node.winnerNextSide   = pos % 2 === 1 ? 'left' : 'right';
    }
  }

  // Populate R1 participants and mark byes as finished
  for (let i = 0; i < T; i += 2) {
    const pos   = i / 2 + 1;
    const lSeed = seedSlots[i];
    const rSeed = seedSlots[i + 1];
    const node  = mainNodes[1][pos];
    const lTeam = bySeed[lSeed] || null;
    const rTeam = bySeed[rSeed] || null;

    node.leftTeamId  = lTeam?.id ?? null;
    node.rightTeamId = rTeam?.id ?? null;
    node.leftSeed    = lSeed;
    node.rightSeed   = rSeed;

    if (!lTeam || !rTeam) {
      const winner        = lTeam ?? rTeam;
      node.status         = 'finished';
      node.winner_team_id = winner.id;
    }
  }

  // Bronze bout: losers of both semi-finals
  if (rule.placement?.thirdPlaceBout !== false && totalRounds >= 2) {
    const sfRound = totalRounds - 1;
    const numSF   = T / Math.pow(2, sfRound);
    const bronze  = newNode(null, null, 3);
    for (let pos = 1; pos <= numSF; pos++) {
      const sf             = mainNodes[sfRound][pos];
      sf.loserNextTempId   = bronze.tempId;
      sf.loserNextSide     = pos === 1 ? 'left' : 'right';
    }
  }

  return { nodes, tableauSize: T, totalRounds };
}

module.exports = { buildTeamTableau };
