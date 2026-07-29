'use strict';

const db          = require('../db');
const { loadRule }        = require('../lib/rules');
const { buildTeamTableau } = require('../lib/teamFormation');
const TeamMatch   = require('./teamMatches');

const stmtActiveTeamsForCompetition = db.prepare(`
  SELECT id, seed FROM teams
  WHERE competition_id = ? AND status = 'active'
  ORDER BY seed, name
`);
const stmtMaxPhaseOrder = db.prepare(
  'SELECT COALESCE(MAX(phase_order), 0) AS m FROM phases WHERE competition_id = ?'
);
const stmtPrevPhaseStatus = db.prepare(
  'SELECT status FROM phases WHERE competition_id = ? ORDER BY phase_order DESC LIMIT 1'
);
const stmtInsertPhase = db.prepare(`
  INSERT INTO phases (competition_id, phase_order, type, rule_doc, status)
  VALUES (?, ?, 'team_de', ?, 'active')
`);
const stmtInsertMatch = db.prepare(`
  INSERT INTO team_matches
    (phase_id, left_team_id, right_team_id, status, match_order,
     de_round, tableau_position, winner_team_id, place_rank)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const stmtUpdateRouting = db.prepare(`
  UPDATE team_matches
  SET winner_next_match_id = ?, winner_next_side = ?,
      loser_next_match_id  = ?, loser_next_side  = ?
  WHERE id = ?
`);
const stmtSetLeftTeam = db.prepare('UPDATE team_matches SET left_team_id  = ? WHERE id = ?');
const stmtSetRightTeam = db.prepare('UPDATE team_matches SET right_team_id = ? WHERE id = ?');
const stmtInsertRelay = db.prepare(`
  INSERT INTO relays (team_match_id, relay_number, target, left_position, right_position, status)
  VALUES (?, ?, ?, ?, ?, 'pending')
`);
const stmtPhaseById = db.prepare('SELECT * FROM phases WHERE id = ?');
const stmtMatchesForPhase = db.prepare(`
  SELECT tm.*, tl.name AS left_team_name, tr.name AS right_team_name
  FROM team_matches tm
  LEFT JOIN teams tl ON tl.id = tm.left_team_id
  LEFT JOIN teams tr ON tr.id = tm.right_team_id
  WHERE tm.phase_id = ?
  ORDER BY tm.match_order
`);
const stmtRelayCountForMatch = db.prepare(
  'SELECT COUNT(*) AS n FROM relays WHERE team_match_id = ?'
);
const stmtFinishedRelayCountForMatch = db.prepare(
  "SELECT COUNT(*) AS n FROM relays WHERE team_match_id = ? AND status = 'finished'"
);
const stmtDeRoundMatchesForPhase = db.prepare(`
  SELECT * FROM team_matches WHERE phase_id = ? AND de_round IS NOT NULL
`);
const stmtFinalMatch = db.prepare(`
  SELECT * FROM team_matches
  WHERE phase_id = ? AND de_round = (SELECT MAX(de_round) FROM team_matches WHERE phase_id = ? AND de_round IS NOT NULL)
  ORDER BY tableau_position LIMIT 1
`);
const stmtSetRank1 = db.prepare('UPDATE teams SET final_rank = 1 WHERE id = ?');
const stmtSetRank2 = db.prepare('UPDATE teams SET final_rank = 2 WHERE id = ?');
const stmtBronzeMatch = db.prepare(
  'SELECT * FROM team_matches WHERE phase_id = ? AND place_rank = 3'
);
const stmtSetRank3 = db.prepare('UPDATE teams SET final_rank = 3 WHERE id = ?');
const stmtSetRank4 = db.prepare('UPDATE teams SET final_rank = 4 WHERE id = ?');
const stmtDistinctRounds = db.prepare(
  'SELECT DISTINCT de_round FROM team_matches WHERE phase_id = ? AND de_round IS NOT NULL ORDER BY de_round'
);
const stmtMatchesForRound = db.prepare(
  'SELECT * FROM team_matches WHERE phase_id = ? AND de_round = ?'
);
const stmtTeamFinalRank = db.prepare('SELECT final_rank FROM teams WHERE id = ?');
const stmtSetRankGeneric = db.prepare('UPDATE teams SET final_rank = ? WHERE id = ?');
const stmtFinishPhase = db.prepare("UPDATE phases SET status = 'finished' WHERE id = ?");
const stmtMaxDeRound = db.prepare(
  'SELECT MAX(de_round) AS m FROM team_matches WHERE phase_id = ? AND de_round IS NOT NULL'
);
const stmtPendingMatchesForRound = db.prepare(`
  SELECT id FROM team_matches
  WHERE phase_id = ? AND de_round = ? AND status = 'pending'
  ORDER BY tableau_position
`);
const stmtBronzePending = db.prepare(
  "SELECT id FROM team_matches WHERE phase_id = ? AND place_rank = 3 AND status = 'pending'"
);

const TeamPhase = {
  // Create a team_de phase for the competition.
  // Reads active teams (must be seeded), builds the tableau, inserts matches + relays.
  create(competitionId, ruleDoc) {
    const rule = loadRule(ruleDoc);
    if (rule.type !== 'team_de') {
      throw Object.assign(new Error('Rule document is not a team_de type.'), { status: 400 });
    }

    const teams = stmtActiveTeamsForCompetition.all(competitionId);

    if (teams.length < 2) throw Object.assign(
      new Error('At least 2 active teams with seeds are required.'), { status: 400 }
    );
    if (teams.some(t => !t.seed)) throw Object.assign(
      new Error('All active teams must be seeded before creating a phase.'), { status: 400 }
    );

    const { nodes, tableauSize } = buildTeamTableau(teams, rule);

    const phaseId = db.transaction(() => {
      const maxOrder = stmtMaxPhaseOrder.get(competitionId).m;

      if (maxOrder > 0) {
        const prev = stmtPrevPhaseStatus.get(competitionId);
        if (prev && prev.status !== 'finished') throw Object.assign(
          new Error('Previous phase must be finished before creating a new one.'), { status: 400 }
        );
      }

      const { lastInsertRowid: phaseId } = stmtInsertPhase.run(competitionId, maxOrder + 1, ruleDoc);

      // Pass 1 — insert all team_match rows, collect DB ids by tempId
      const dbIds = new Array(nodes.length);
      for (const n of nodes) {
        const { lastInsertRowid } = stmtInsertMatch.run(
          phaseId,
          n.leftTeamId,
          n.rightTeamId,
          n.status,
          n.match_order,
          n.de_round,
          n.tableau_position,
          n.winner_team_id,
          n.place_rank,
        );
        dbIds[n.tempId] = lastInsertRowid;
        n.dbId = lastInsertRowid;
      }

      // Pass 2 — wire routing pointers
      for (const n of nodes) {
        if (n.winnerNextTempId === null && n.loserNextTempId === null) continue;
        stmtUpdateRouting.run(
          n.winnerNextTempId !== null ? dbIds[n.winnerNextTempId] : null,
          n.winnerNextSide   ?? null,
          n.loserNextTempId  !== null ? dbIds[n.loserNextTempId]  : null,
          n.loserNextSide    ?? null,
          n.dbId,
        );
      }

      // Pass 3 — wire bye winners into their next-round slots immediately
      for (const n of nodes) {
        if (n.status !== 'finished' || !n.winner_team_id || n.winnerNextTempId === null) continue;
        const nextDbId = dbIds[n.winnerNextTempId];
        if (n.winnerNextSide === 'left') stmtSetLeftTeam.run(n.winner_team_id, nextDbId);
        else                             stmtSetRightTeam.run(n.winner_team_id, nextDbId);
      }

      // Insert relay rows for each non-bye match
      for (const n of nodes) {
        if (n.status === 'finished') continue; // bye match — no relays needed
        if (!n.de_round && !n.place_rank) continue; // safety check
        for (const relayDef of rule.relays) {
          stmtInsertRelay.run(n.dbId, relayDef.relay, relayDef.target, relayDef.left, relayDef.right);
        }
      }

      return phaseId;
    })();

    return this.findById(phaseId);
  },

  findById(phaseId) {
    const phase = stmtPhaseById.get(phaseId);
    if (!phase) return null;

    const matches = stmtMatchesForPhase.all(phaseId);

    const totalRelays  = matches.reduce((s, m) => s + (m.status === 'finished' ? 0 : stmtRelayCountForMatch.get(m.id).n), 0);
    const finishedRelays = matches.reduce((s, m) => s + stmtFinishedRelayCountForMatch.get(m.id).n, 0);

    // Real matches have relays; byes were inserted as 'finished' with no relays.
    const realMatchIds = matches.length === 0 ? new Set() : new Set(
      // dynamic-sql-ok: IN(...) placeholder count varies with matches.length
      db.prepare('SELECT DISTINCT team_match_id FROM relays WHERE team_match_id IN ('+matches.map(()=>'?').join(',')+')')
        .all(...matches.map(m=>m.id)).map(r=>r.team_match_id)
    );
    phase.matches         = matches;
    phase.matches_total   = matches.filter(m => realMatchIds.has(m.id)).length;
    phase.matches_complete = matches.filter(m => realMatchIds.has(m.id) && m.status === 'finished').length;

    return phase;
  },

  close(phaseId) {
    const phase = stmtPhaseById.get(phaseId);
    if (!phase) throw Object.assign(new Error('Phase not found.'), { status: 404 });
    if (phase.type !== 'team_de') throw Object.assign(new Error('Not a team_de phase.'), { status: 400 });

    const matches = stmtDeRoundMatchesForPhase.all(phaseId);

    const unfinished = matches.filter(m => m.status !== 'finished');
    if (unfinished.length > 0) throw Object.assign(
      new Error('All matches must be finished before closing the phase.'), { status: 400 }
    );

    // Assign final_rank to teams:
    // 1st/2nd from the final; 3rd from bronze bout winner/loser; others by de_round exit
    db.transaction(() => {
      // Find the final (highest de_round, tableau_position 1)
      const final = stmtFinalMatch.get(phaseId, phaseId);

      if (final) {
        stmtSetRank1.run(final.winner_team_id);
        const runnerUp = final.winner_team_id === final.left_team_id
          ? final.right_team_id : final.left_team_id;
        stmtSetRank2.run(runnerUp);
      }

      // Bronze bout
      const bronze = stmtBronzeMatch.get(phaseId);
      if (bronze) {
        stmtSetRank3.run(bronze.winner_team_id);
        const fourthId = bronze.winner_team_id === bronze.left_team_id
          ? bronze.right_team_id : bronze.left_team_id;
        stmtSetRank4.run(fourthId);
      }

      // Remaining teams: rank by the de_round they exited (lower round = worse rank)
      // Group losers by round and assign shared ranks
      const allRounds = stmtDistinctRounds.all(phaseId).map(r => r.de_round);

      let currentRank = bronze ? 5 : 3;
      for (const round of allRounds) {
        const roundMatches = stmtMatchesForRound.all(phaseId, round);
        const losers = roundMatches.map(m =>
          m.winner_team_id === m.left_team_id ? m.right_team_id : m.left_team_id
        ).filter(id => {
          const existing = stmtTeamFinalRank.get(id);
          return !existing?.final_rank;
        });
        for (const loserId of losers) {
          stmtSetRankGeneric.run(currentRank, loserId);
        }
        if (losers.length) currentRank += losers.length;
      }

      stmtFinishPhase.run(phaseId);
    })();

    return this.findById(phaseId);
  },

  // Simulate the full phase: process matches in round order, auto-drawing and scoring each.
  simulate(phaseId) {
    const phase = stmtPhaseById.get(phaseId);
    if (!phase) throw Object.assign(new Error('Phase not found.'), { status: 404 });

    // Process rounds in order (byes are already finished)
    const maxRound = stmtMaxDeRound.get(phaseId).m;

    for (let round = 1; round <= maxRound; round++) {
      const pending = stmtPendingMatchesForRound.all(phaseId, round);

      for (const { id } of pending) {
        TeamMatch.simulate(id);
      }
    }

    // Bronze bout
    const bronze = stmtBronzePending.get(phaseId);
    if (bronze) TeamMatch.simulate(bronze.id);
  },
};

module.exports = TeamPhase;
