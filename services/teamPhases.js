'use strict';

const db          = require('../db');
const { loadRule }        = require('../lib/rules');
const { buildTeamTableau } = require('../lib/teamFormation');
const TeamMatch   = require('./teamMatches');

const TeamPhase = {
  // Create a team_de phase for the competition.
  // Reads active teams (must be seeded), builds the tableau, inserts matches + relays.
  create(competitionId, ruleDoc) {
    const rule = loadRule(ruleDoc);
    if (rule.type !== 'team_de') {
      throw Object.assign(new Error('Rule document is not a team_de type.'), { status: 400 });
    }

    const teams = db.prepare(`
      SELECT id, seed FROM teams
      WHERE competition_id = ? AND status = 'active'
      ORDER BY seed, name
    `).all(competitionId);

    if (teams.length < 2) throw Object.assign(
      new Error('At least 2 active teams with seeds are required.'), { status: 400 }
    );
    if (teams.some(t => !t.seed)) throw Object.assign(
      new Error('All active teams must be seeded before creating a phase.'), { status: 400 }
    );

    const { nodes, tableauSize } = buildTeamTableau(teams, rule);

    const phaseId = db.transaction(() => {
      const maxOrder = db.prepare(
        'SELECT COALESCE(MAX(phase_order), 0) AS m FROM phases WHERE competition_id = ?'
      ).get(competitionId).m;

      if (maxOrder > 0) {
        const prev = db.prepare(
          'SELECT status FROM phases WHERE competition_id = ? ORDER BY phase_order DESC LIMIT 1'
        ).get(competitionId);
        if (prev && prev.status !== 'finished') throw Object.assign(
          new Error('Previous phase must be finished before creating a new one.'), { status: 400 }
        );
      }

      const { lastInsertRowid: phaseId } = db.prepare(`
        INSERT INTO phases (competition_id, phase_order, type, rule_doc, status)
        VALUES (?, ?, 'team_de', ?, 'pending')
      `).run(competitionId, maxOrder + 1, ruleDoc);

      // Pass 1 — insert all team_match rows, collect DB ids by tempId
      const insertMatch = db.prepare(`
        INSERT INTO team_matches
          (phase_id, left_team_id, right_team_id, status, match_order,
           de_round, tableau_position, winner_team_id, place_rank)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const dbIds = new Array(nodes.length);
      for (const n of nodes) {
        const { lastInsertRowid } = insertMatch.run(
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
      const updateRouting = db.prepare(`
        UPDATE team_matches
        SET winner_next_match_id = ?, winner_next_side = ?,
            loser_next_match_id  = ?, loser_next_side  = ?
        WHERE id = ?
      `);
      for (const n of nodes) {
        if (n.winnerNextTempId === null && n.loserNextTempId === null) continue;
        updateRouting.run(
          n.winnerNextTempId !== null ? dbIds[n.winnerNextTempId] : null,
          n.winnerNextSide   ?? null,
          n.loserNextTempId  !== null ? dbIds[n.loserNextTempId]  : null,
          n.loserNextSide    ?? null,
          n.dbId,
        );
      }

      // Pass 3 — wire bye winners into their next-round slots immediately
      const setLeft  = db.prepare('UPDATE team_matches SET left_team_id  = ? WHERE id = ?');
      const setRight = db.prepare('UPDATE team_matches SET right_team_id = ? WHERE id = ?');
      for (const n of nodes) {
        if (n.status !== 'finished' || !n.winner_team_id || n.winnerNextTempId === null) continue;
        const nextDbId = dbIds[n.winnerNextTempId];
        if (n.winnerNextSide === 'left') setLeft.run(n.winner_team_id, nextDbId);
        else                             setRight.run(n.winner_team_id, nextDbId);
      }

      // Insert relay rows for each non-bye match
      const insertRelay = db.prepare(`
        INSERT INTO relays (team_match_id, relay_number, target, left_position, right_position, status)
        VALUES (?, ?, ?, ?, ?, 'pending')
      `);
      for (const n of nodes) {
        if (n.status === 'finished') continue; // bye match — no relays needed
        if (!n.de_round && !n.place_rank) continue; // safety check
        for (const relayDef of rule.relays) {
          insertRelay.run(n.dbId, relayDef.relay, relayDef.target, relayDef.left, relayDef.right);
        }
      }

      return phaseId;
    })();

    return this.findById(phaseId);
  },

  findById(phaseId) {
    const phase = db.prepare('SELECT * FROM phases WHERE id = ?').get(phaseId);
    if (!phase) return null;

    const matches = db.prepare(`
      SELECT tm.*, tl.name AS left_team_name, tr.name AS right_team_name
      FROM team_matches tm
      LEFT JOIN teams tl ON tl.id = tm.left_team_id
      LEFT JOIN teams tr ON tr.id = tm.right_team_id
      WHERE tm.phase_id = ?
      ORDER BY tm.match_order
    `).all(phaseId);

    const totalRelays  = matches.reduce((s, m) => s + (m.status === 'finished' ? 0 : db.prepare(
      'SELECT COUNT(*) AS n FROM relays WHERE team_match_id = ?'
    ).get(m.id).n), 0);
    const finishedRelays = matches.reduce((s, m) => s + db.prepare(
      "SELECT COUNT(*) AS n FROM relays WHERE team_match_id = ? AND status = 'finished'"
    ).get(m.id).n, 0);

    // Real matches have relays; byes were inserted as 'finished' with no relays.
    const realMatchIds = matches.length === 0 ? new Set() : new Set(
      db.prepare('SELECT DISTINCT team_match_id FROM relays WHERE team_match_id IN ('+matches.map(()=>'?').join(',')+')')
        .all(...matches.map(m=>m.id)).map(r=>r.team_match_id)
    );
    phase.matches         = matches;
    phase.matches_total   = matches.filter(m => realMatchIds.has(m.id)).length;
    phase.matches_complete = matches.filter(m => realMatchIds.has(m.id) && m.status === 'finished').length;

    return phase;
  },

  activate(phaseId) {
    const phase = db.prepare('SELECT * FROM phases WHERE id = ?').get(phaseId);
    if (!phase) throw Object.assign(new Error('Phase not found.'), { status: 404 });
    if (phase.status !== 'pending') throw Object.assign(new Error('Phase is not pending.'), { status: 400 });

    db.transaction(() => {
      db.prepare("UPDATE phases SET status = 'active' WHERE id = ?").run(phaseId);
    })();

    return this.findById(phaseId);
  },

  close(phaseId) {
    const phase = db.prepare('SELECT * FROM phases WHERE id = ?').get(phaseId);
    if (!phase) throw Object.assign(new Error('Phase not found.'), { status: 404 });
    if (phase.type !== 'team_de') throw Object.assign(new Error('Not a team_de phase.'), { status: 400 });

    const matches = db.prepare(`
      SELECT * FROM team_matches WHERE phase_id = ? AND de_round IS NOT NULL
    `).all(phaseId);

    const unfinished = matches.filter(m => m.status !== 'finished');
    if (unfinished.length > 0) throw Object.assign(
      new Error('All matches must be finished before closing the phase.'), { status: 400 }
    );

    // Assign final_rank to teams:
    // 1st/2nd from the final; 3rd from bronze bout winner/loser; others by de_round exit
    db.transaction(() => {
      // Find the final (highest de_round, tableau_position 1)
      const final = db.prepare(`
        SELECT * FROM team_matches
        WHERE phase_id = ? AND de_round = (SELECT MAX(de_round) FROM team_matches WHERE phase_id = ? AND de_round IS NOT NULL)
        ORDER BY tableau_position LIMIT 1
      `).get(phaseId, phaseId);

      if (final) {
        db.prepare('UPDATE teams SET final_rank = 1 WHERE id = ?').run(final.winner_team_id);
        const runnerUp = final.winner_team_id === final.left_team_id
          ? final.right_team_id : final.left_team_id;
        db.prepare('UPDATE teams SET final_rank = 2 WHERE id = ?').run(runnerUp);
      }

      // Bronze bout
      const bronze = db.prepare(
        'SELECT * FROM team_matches WHERE phase_id = ? AND place_rank = 3'
      ).get(phaseId);
      if (bronze) {
        db.prepare('UPDATE teams SET final_rank = 3 WHERE id = ?').run(bronze.winner_team_id);
        const fourthId = bronze.winner_team_id === bronze.left_team_id
          ? bronze.right_team_id : bronze.left_team_id;
        db.prepare('UPDATE teams SET final_rank = 4 WHERE id = ?').run(fourthId);
      }

      // Remaining teams: rank by the de_round they exited (lower round = worse rank)
      // Group losers by round and assign shared ranks
      const allRounds = db.prepare(
        'SELECT DISTINCT de_round FROM team_matches WHERE phase_id = ? AND de_round IS NOT NULL ORDER BY de_round'
      ).all(phaseId).map(r => r.de_round);

      let currentRank = bronze ? 5 : 3;
      for (const round of allRounds) {
        const roundMatches = db.prepare(
          'SELECT * FROM team_matches WHERE phase_id = ? AND de_round = ?'
        ).all(phaseId, round);
        const losers = roundMatches.map(m =>
          m.winner_team_id === m.left_team_id ? m.right_team_id : m.left_team_id
        ).filter(id => {
          const existing = db.prepare('SELECT final_rank FROM teams WHERE id = ?').get(id);
          return !existing?.final_rank;
        });
        for (const loserId of losers) {
          db.prepare('UPDATE teams SET final_rank = ? WHERE id = ?').run(currentRank, loserId);
        }
        if (losers.length) currentRank += losers.length;
      }

      db.prepare("UPDATE phases SET status = 'finished' WHERE id = ?").run(phaseId);
    })();

    return this.findById(phaseId);
  },

  // Simulate the full phase: process matches in round order, auto-drawing and scoring each.
  simulate(phaseId) {
    const phase = db.prepare('SELECT * FROM phases WHERE id = ?').get(phaseId);
    if (!phase) throw Object.assign(new Error('Phase not found.'), { status: 404 });
    if (phase.status !== 'active') throw Object.assign(new Error('Phase must be active to simulate.'), { status: 400 });

    // Process rounds in order (byes are already finished)
    const maxRound = db.prepare(
      'SELECT MAX(de_round) AS m FROM team_matches WHERE phase_id = ? AND de_round IS NOT NULL'
    ).get(phaseId).m;

    for (let round = 1; round <= maxRound; round++) {
      const pending = db.prepare(`
        SELECT id FROM team_matches
        WHERE phase_id = ? AND de_round = ? AND status = 'pending'
        ORDER BY tableau_position
      `).all(phaseId, round);

      for (const { id } of pending) {
        TeamMatch.simulate(id);
      }
    }

    // Bronze bout
    const bronze = db.prepare(
      "SELECT id FROM team_matches WHERE phase_id = ? AND place_rank = 3 AND status = 'pending'"
    ).get(phaseId);
    if (bronze) TeamMatch.simulate(bronze.id);
  },
};

module.exports = TeamPhase;
