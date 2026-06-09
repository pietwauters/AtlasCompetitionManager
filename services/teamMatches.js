'use strict';

const db = require('../db');

// Resolve which competitor fences at a given position for a given relay.
// Returns competitor_id or null if orders have not been submitted yet.
function resolveCompetitor(matchId, position, relayNumber) {
  const sub = db.prepare(`
    SELECT s.substitute_competitor_id
    FROM team_match_substitutions s
    JOIN team_match_orders o
      ON o.team_match_id = s.team_match_id
     AND o.team_id       = s.team_id
     AND o.position      = s.position_replaced
    WHERE s.team_match_id = ?
      AND o.position = ?
      AND s.effective_from_relay <= ?
  `).get(matchId, position, relayNumber);
  if (sub) return sub.substitute_competitor_id;

  const order = db.prepare(`
    SELECT competitor_id FROM team_match_orders
    WHERE team_match_id = ? AND position = ?
  `).get(matchId, position);
  return order?.competitor_id ?? null;
}

// Returns { leftCumulative, rightCumulative } from finished relays up to (but not including) relayNumber.
function cumulativeBefore(matchId, relayNumber) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(left_touches), 0)  AS l,
           COALESCE(SUM(right_touches), 0) AS r
    FROM relays
    WHERE team_match_id = ? AND relay_number < ? AND status = 'finished'
  `).get(matchId, relayNumber);
  return { leftCumulative: row.l, rightCumulative: row.r };
}

// Wire the match winner (or loser) into the next bracket slot.
function routeMatchResult(match) {
  if (match.winner_next_match_id) {
    const col = match.winner_next_side === 'left' ? 'left_team_id' : 'right_team_id';
    db.prepare(`UPDATE team_matches SET ${col} = ? WHERE id = ?`)
      .run(match.winner_team_id, match.winner_next_match_id);
  }
  if (match.loser_next_match_id) {
    const loserId = match.winner_team_id === match.left_team_id
      ? match.right_team_id
      : match.left_team_id;
    const col = match.loser_next_side === 'left' ? 'left_team_id' : 'right_team_id';
    db.prepare(`UPDATE team_matches SET ${col} = ? WHERE id = ?`)
      .run(loserId, match.loser_next_match_id);
  }
}

const TeamMatch = {
  findById(matchId) {
    const match = db.prepare(`
      SELECT tm.*,
             tl.name AS left_team_name, tr.name AS right_team_name,
             tdw.name AS draw_winner_name
      FROM team_matches tm
      LEFT JOIN teams tl  ON tl.id  = tm.left_team_id
      LEFT JOIN teams tr  ON tr.id  = tm.right_team_id
      LEFT JOIN teams tdw ON tdw.id = tm.draw_winner_team_id
      WHERE tm.id = ?
    `).get(matchId);
    if (!match) return null;

    const { leftCumulative, rightCumulative } = cumulativeBefore(matchId, 999);
    match.left_cumulative  = leftCumulative;
    match.right_cumulative = rightCumulative;

    match.orders_left  = db.prepare(
      'SELECT COUNT(*) AS n FROM team_match_orders WHERE team_match_id = ? AND team_id = ?'
    ).get(matchId, match.left_team_id)?.n ?? 0;
    match.orders_right = db.prepare(
      'SELECT COUNT(*) AS n FROM team_match_orders WHERE team_match_id = ? AND team_id = ?'
    ).get(matchId, match.right_team_id)?.n ?? 0;

    return match;
  },

  // Record the draw result. method: 'auto' (random) or 'manual'.
  // winnerTeamId is required for 'manual'; omit (or pass null) for 'auto'.
  draw(matchId, winnerTeamId, method) {
    const match = db.prepare('SELECT * FROM team_matches WHERE id = ?').get(matchId);
    if (!match) throw Object.assign(new Error('Match not found.'), { status: 404 });
    if (match.draw_winner_team_id) throw Object.assign(new Error('Draw already recorded.'), { status: 400 });
    if (!match.left_team_id || !match.right_team_id) {
      throw Object.assign(new Error('Both teams must be set before the draw.'), { status: 400 });
    }

    let winnerId = winnerTeamId;
    if (method === 'auto') {
      winnerId = Math.random() < 0.5 ? match.left_team_id : match.right_team_id;
    }
    if (winnerId !== match.left_team_id && winnerId !== match.right_team_id) {
      throw Object.assign(new Error('Winner must be one of the two teams in this match.'), { status: 400 });
    }

    db.prepare(`
      UPDATE team_matches SET draw_winner_team_id = ?, draw_method = ? WHERE id = ?
    `).run(winnerId, method, matchId);

    return this.findById(matchId);
  },

  // Submit fencer order for one team. positionMap: { 1: competitorId, 2: …, 3: … } for Team A
  // or { 4: …, 5: …, 6: … } for Team B.
  submitOrder(matchId, teamId, positionMap) {
    const match = db.prepare('SELECT * FROM team_matches WHERE id = ?').get(matchId);
    if (!match) throw Object.assign(new Error('Match not found.'), { status: 404 });
    if (!match.draw_winner_team_id) throw Object.assign(new Error('Draw must be completed first.'), { status: 400 });
    if (match.status === 'finished') throw Object.assign(new Error('Match is already finished.'), { status: 400 });

    // Determine expected positions for this team
    const isTeamA = Number(teamId) === Number(match.draw_winner_team_id);
    const expectedPositions = isTeamA ? [1, 2, 3] : [4, 5, 6];

    for (const pos of expectedPositions) {
      if (!positionMap[pos]) throw Object.assign(
        new Error(`Position ${pos} is required.`), { status: 400 }
      );
    }

    // Validate all competitor IDs are regular members of this team
    const regularMembers = db.prepare(`
      SELECT competitor_id FROM team_members WHERE team_id = ? AND role = 'regular'
    `).all(teamId).map(r => r.competitor_id);

    // Check substitutions to see if anyone is currently replaced
    const sub = db.prepare(
      'SELECT original_competitor_id FROM team_match_substitutions WHERE team_match_id = ? AND team_id = ?'
    ).get(matchId, teamId);
    const replacedId = sub?.original_competitor_id;

    const reserve = replacedId ? db.prepare(
      'SELECT substitute_competitor_id FROM team_match_substitutions WHERE team_match_id = ? AND team_id = ?'
    ).get(matchId, teamId)?.substitute_competitor_id : null;

    const activeMemberIds = regularMembers
      .filter(id => id !== replacedId)
      .concat(reserve ? [reserve] : []);

    const submitted = Object.values(positionMap).map(Number);
    for (const cId of submitted) {
      if (!activeMemberIds.includes(cId)) throw Object.assign(
        new Error(`Competitor ${cId} is not an active regular member of this team.`), { status: 400 }
      );
    }
    if (new Set(submitted).size !== submitted.length) {
      throw Object.assign(new Error('Each competitor can appear in only one position.'), { status: 400 });
    }

    db.transaction(() => {
      // Replace any existing order for this team
      db.prepare('DELETE FROM team_match_orders WHERE team_match_id = ? AND team_id = ?')
        .run(matchId, teamId);
      const insert = db.prepare(
        'INSERT INTO team_match_orders (team_match_id, team_id, competitor_id, position) VALUES (?, ?, ?, ?)'
      );
      for (const pos of expectedPositions) {
        insert.run(matchId, teamId, positionMap[pos], pos);
      }

      // Activate match once both teams have submitted orders
      const bothSubmitted = db.prepare(`
        SELECT COUNT(DISTINCT team_id) AS n
        FROM team_match_orders WHERE team_match_id = ?
      `).get(matchId).n === 2;
      if (bothSubmitted && match.status === 'pending') {
        db.prepare("UPDATE team_matches SET status = 'active' WHERE id = ?").run(matchId);
      }
    })();

    return this.findById(matchId);
  },

  // Return relay list with resolved fencer names and running cumulative scores.
  getRelays(matchId) {
    const match = db.prepare('SELECT * FROM team_matches WHERE id = ?').get(matchId);
    if (!match) throw Object.assign(new Error('Match not found.'), { status: 404 });

    const relays = db.prepare(
      'SELECT * FROM relays WHERE team_match_id = ? ORDER BY relay_number'
    ).all(matchId);

    let leftCum = 0;
    let rightCum = 0;

    return relays.map(relay => {
      const leftPos  = relay.relay_number; // used for rule lookup only — actual pos comes from rule
      const rightPos = relay.relay_number;
      // Load rule to resolve positions for this relay
      const ruleRelays = _getRuleRelays(matchId);
      const ruleDef    = ruleRelays[relay.relay_number - 1];

      const leftCompId  = ruleDef ? resolveCompetitor(matchId, ruleDef.left,  relay.relay_number) : null;
      const rightCompId = ruleDef ? resolveCompetitor(matchId, ruleDef.right, relay.relay_number) : null;

      const leftFencer  = leftCompId  ? _fencerName(leftCompId)  : null;
      const rightFencer = rightCompId ? _fencerName(rightCompId) : null;

      if (relay.status === 'finished') {
        leftCum  += relay.left_touches  ?? 0;
        rightCum += relay.right_touches ?? 0;
      }

      return {
        ...relay,
        left_position:  ruleDef?.left  ?? null,
        right_position: ruleDef?.right ?? null,
        left_fencer:    leftFencer,
        right_fencer:   rightFencer,
        left_cumulative:  leftCum,
        right_cumulative: rightCum,
      };
    });
  },

  // Record relay result. Detects match end and wires bracket routing.
  updateRelay(relayId, { leftTouches, rightTouches, timeExpired = 0 }) {
    const relay = db.prepare('SELECT * FROM relays WHERE id = ?').get(relayId);
    if (!relay) throw Object.assign(new Error('Relay not found.'), { status: 404 });
    if (relay.status === 'finished') throw Object.assign(new Error('Relay is already finished.'), { status: 400 });

    const match = db.prepare('SELECT * FROM team_matches WHERE id = ?').get(relay.team_match_id);
    if (match.status !== 'active') throw Object.assign(new Error('Match is not active.'), { status: 400 });

    const { leftCumulative: prevLeft, rightCumulative: prevRight } =
      cumulativeBefore(relay.team_match_id, relay.relay_number);

    const newLeft  = prevLeft  + leftTouches;
    const newRight = prevRight + rightTouches;

    if (newLeft > relay.target || newRight > relay.target) {
      throw Object.assign(
        new Error(`Cumulative score would exceed relay target of ${relay.target}.`),
        { status: 400 }
      );
    }

    db.transaction(() => {
      // Save undo snapshot
      db.prepare(`
        INSERT INTO relay_history (relay_id, left_touches, right_touches, time_expired, status)
        VALUES (?, ?, ?, ?, ?)
      `).run(relayId, relay.left_touches, relay.right_touches, relay.time_expired, relay.status);

      db.prepare(`
        UPDATE relays
        SET left_touches = ?, right_touches = ?, time_expired = ?, status = 'finished'
        WHERE id = ?
      `).run(leftTouches, rightTouches, timeExpired ? 1 : 0, relayId);

      // Check if match has ended
      const isLastRelay = relay.relay_number === (db.prepare(
        'SELECT MAX(relay_number) AS m FROM relays WHERE team_match_id = ?'
      ).get(relay.team_match_id).m);

      const matchEnds = newLeft >= 45 || newRight >= 45 || isLastRelay;

      if (matchEnds) {
        let winnerId = null;
        if (newLeft > newRight)       winnerId = match.left_team_id;
        else if (newRight > newLeft)  winnerId = match.right_team_id;
        // Equal: tiebreak — leave winner_team_id null for now; director records manually

        db.prepare(`
          UPDATE team_matches
          SET left_score = ?, right_score = ?, winner_team_id = ?,
              status = CASE WHEN ? IS NOT NULL THEN 'finished' ELSE 'tiebreak' END
          WHERE id = ?
        `).run(newLeft, newRight, winnerId, winnerId, match.id);

        if (winnerId) {
          const updated = db.prepare('SELECT * FROM team_matches WHERE id = ?').get(match.id);
          routeMatchResult(updated);
        }
      }
    })();

    return db.prepare('SELECT * FROM relays WHERE id = ?').get(relayId);
  },

  // Undo the last recorded result for a relay.
  undo(relayId) {
    const relay = db.prepare('SELECT * FROM relays WHERE id = ?').get(relayId);
    if (!relay) throw Object.assign(new Error('Relay not found.'), { status: 404 });

    const last = db.prepare(
      'SELECT * FROM relay_history WHERE relay_id = ? ORDER BY changed_at DESC LIMIT 1'
    ).get(relayId);
    if (!last) throw Object.assign(new Error('Nothing to undo.'), { status: 400 });

    db.transaction(() => {
      db.prepare(`
        UPDATE relays
        SET left_touches = ?, right_touches = ?, time_expired = ?, status = ?
        WHERE id = ?
      `).run(last.left_touches, last.right_touches, last.time_expired, last.status, relayId);
      db.prepare('DELETE FROM relay_history WHERE id = ?').run(last.id);

      // Clear match result if match was previously finished/tiebreak
      const match = db.prepare('SELECT * FROM team_matches WHERE id = ?').get(relay.team_match_id);
      if (match.status === 'finished' || match.status === 'tiebreak') {
        // Clear the team that was wired into the next match
        if (match.winner_next_match_id) {
          const col = match.winner_next_side === 'left' ? 'left_team_id' : 'right_team_id';
          db.prepare(`UPDATE team_matches SET ${col} = NULL WHERE id = ?`)
            .run(match.winner_next_match_id);
        }
        if (match.loser_next_match_id) {
          const col = match.loser_next_side === 'left' ? 'left_team_id' : 'right_team_id';
          db.prepare(`UPDATE team_matches SET ${col} = NULL WHERE id = ?`)
            .run(match.loser_next_match_id);
        }
        db.prepare(`
          UPDATE team_matches
          SET status = 'active', winner_team_id = NULL, left_score = NULL, right_score = NULL
          WHERE id = ?
        `).run(match.id);
      }
    })();

    return db.prepare('SELECT * FROM relays WHERE id = ?').get(relayId);
  },

  // Record the winner manually after a tiebreak (sudden death).
  recordTiebreakWinner(matchId, winnerTeamId) {
    const match = db.prepare('SELECT * FROM team_matches WHERE id = ?').get(matchId);
    if (!match) throw Object.assign(new Error('Match not found.'), { status: 404 });
    if (match.status !== 'tiebreak') throw Object.assign(new Error('Match is not in tiebreak.'), { status: 400 });
    if (winnerTeamId !== match.left_team_id && winnerTeamId !== match.right_team_id) {
      throw Object.assign(new Error('Winner must be one of the two teams.'), { status: 400 });
    }

    db.transaction(() => {
      db.prepare(`
        UPDATE team_matches SET winner_team_id = ?, status = 'finished' WHERE id = ?
      `).run(winnerTeamId, matchId);
      const updated = db.prepare('SELECT * FROM team_matches WHERE id = ?').get(matchId);
      routeMatchResult(updated);
    })();

    return this.findById(matchId);
  },

  // Declare a substitution (reserve replaces a regular fencer from a given relay onward).
  applySubstitution(matchId, teamId, positionReplaced, effectiveFromRelay) {
    const match = db.prepare('SELECT * FROM team_matches WHERE id = ?').get(matchId);
    if (!match) throw Object.assign(new Error('Match not found.'), { status: 404 });
    if (match.status !== 'active') throw Object.assign(new Error('Match is not active.'), { status: 400 });

    const existing = db.prepare(
      'SELECT id FROM team_match_substitutions WHERE team_match_id = ? AND team_id = ?'
    ).get(matchId, teamId);
    if (existing) throw Object.assign(new Error('This team has already used its substitution.'), { status: 400 });

    // Determine which team is A or B to validate the position number
    const isTeamA = Number(teamId) === Number(match.draw_winner_team_id);
    const validPositions = isTeamA ? [1, 2, 3] : [4, 5, 6];
    if (!validPositions.includes(positionReplaced)) {
      throw Object.assign(new Error(`Invalid position ${positionReplaced} for this team.`), { status: 400 });
    }

    const originalOrder = db.prepare(
      'SELECT competitor_id FROM team_match_orders WHERE team_match_id = ? AND team_id = ? AND position = ?'
    ).get(matchId, teamId, positionReplaced);
    if (!originalOrder) throw Object.assign(new Error('No order submitted for this position.'), { status: 400 });

    const reserve = db.prepare(`
      SELECT tm.competitor_id FROM team_members tm
      WHERE tm.team_id = ? AND tm.role = 'reserve'
    `).get(teamId);
    if (!reserve) throw Object.assign(new Error('No reserve available for this team.'), { status: 400 });

    db.prepare(`
      INSERT INTO team_match_substitutions
        (team_match_id, team_id, position_replaced, original_competitor_id,
         substitute_competitor_id, effective_from_relay)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(matchId, teamId, positionReplaced,
           originalOrder.competitor_id, reserve.competitor_id, effectiveFromRelay);

    return this.findById(matchId);
  },

  // Simulate a single match: randomly score all relays.
  simulate(matchId) {
    const match = db.prepare('SELECT * FROM team_matches WHERE id = ?').get(matchId);
    if (!match) throw Object.assign(new Error('Match not found.'), { status: 404 });

    // Auto-draw if not done
    if (!match.draw_winner_team_id) this.draw(matchId, null, 'auto');

    // Auto-submit orders if not done
    const updatedMatch = db.prepare('SELECT * FROM team_matches WHERE id = ?').get(matchId);
    _autoSubmitOrders(updatedMatch);

    // Reload after activation
    const activeMatch = db.prepare('SELECT * FROM team_matches WHERE id = ?').get(matchId);
    if (activeMatch.status !== 'active') throw Object.assign(
      new Error('Match could not be activated for simulation.'), { status: 400 }
    );

    const relays = db.prepare(
      'SELECT * FROM relays WHERE team_match_id = ? AND status = ? ORDER BY relay_number',
    ).all(matchId, 'pending');

    for (const relay of relays) {
      const { leftCumulative: prevL, rightCumulative: prevR } =
        cumulativeBefore(matchId, relay.relay_number);

      const remaining = relay.target;
      const leftBudget  = relay.target - prevL;
      const rightBudget = relay.target - prevR;

      // Randomly assign who reaches the target
      let leftTouches, rightTouches;
      if (Math.random() < 0.5) {
        leftTouches  = leftBudget;
        rightTouches = Math.floor(Math.random() * rightBudget);
      } else {
        rightTouches = rightBudget;
        leftTouches  = Math.floor(Math.random() * leftBudget);
      }

      this.updateRelay(relay.id, { leftTouches, rightTouches, timeExpired: 0 });

      // Stop if match is now finished/tiebreak
      const updated = db.prepare(
        'SELECT status FROM team_matches WHERE id = ?'
      ).get(matchId);
      if (updated.status !== 'active') break;
    }

    // Handle tiebreak: randomly pick winner
    const finalMatch = db.prepare('SELECT * FROM team_matches WHERE id = ?').get(matchId);
    if (finalMatch.status === 'tiebreak') {
      const winnerId = Math.random() < 0.5 ? finalMatch.left_team_id : finalMatch.right_team_id;
      this.recordTiebreakWinner(matchId, winnerId);
    }
  },
};

// Returns the relay rule definitions for a match (from its phase's rule_doc).
function _getRuleRelays(matchId) {
  const match = db.prepare('SELECT phase_id FROM team_matches WHERE id = ?').get(matchId);
  const phase = db.prepare('SELECT rule_doc FROM phases WHERE id = ?').get(match.phase_id);
  const rule  = require('../lib/rules').loadRule(phase.rule_doc);
  return rule.relays;
}

// Returns "Last, First" for a competitor_id.
function _fencerName(competitorId) {
  const row = db.prepare(`
    SELECT p.first_name, p.last_name
    FROM competitors co
    JOIN fencers f ON f.id = co.fencer_id
    JOIN people p  ON p.id = f.person_id
    WHERE co.id = ?
  `).get(competitorId);
  return row ? `${row.last_name}, ${row.first_name}` : null;
}

// Auto-submit random fencer orders for both teams (used in simulate).
function _autoSubmitOrders(match) {
  const TeamMatch = require('./teamMatches');

  for (const [teamId, positions] of [
    [match.draw_winner_team_id, [1, 2, 3]],
    [
      match.draw_winner_team_id === match.left_team_id
        ? match.right_team_id
        : match.left_team_id,
      [4, 5, 6],
    ],
  ]) {
    const existing = db.prepare(
      'SELECT COUNT(*) AS n FROM team_match_orders WHERE team_match_id = ? AND team_id = ?'
    ).get(match.id, teamId).n;
    if (existing > 0) continue;

    const regulars = db.prepare(`
      SELECT competitor_id FROM team_members WHERE team_id = ? AND role = 'regular'
    `).all(teamId).map(r => r.competitor_id);

    // Shuffle
    for (let i = regulars.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [regulars[i], regulars[j]] = [regulars[j], regulars[i]];
    }

    const posMap = {};
    positions.forEach((pos, i) => { posMap[pos] = regulars[i]; });
    TeamMatch.submitOrder(match.id, teamId, posMap);
  }
}

module.exports = TeamMatch;
