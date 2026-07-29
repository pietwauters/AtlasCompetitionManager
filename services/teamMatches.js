'use strict';

const db = require('../db');

// ---------------------------------------------------------------------------
// Prepared statements — module-level per CLAUDE.md (better-sqlite3 doesn't
// cache prepare() calls; see feedback_prepare_hoisting). Identical SQL text
// used at multiple call sites shares one statement object.
// ---------------------------------------------------------------------------

const stmtSubstitutionLookup = db.prepare(`
  SELECT s.substitute_competitor_id
  FROM team_match_substitutions s
  JOIN team_match_orders o
    ON o.team_match_id = s.team_match_id
   AND o.team_id       = s.team_id
   AND o.position      = s.position_replaced
  WHERE s.team_match_id = ?
    AND o.position = ?
    AND s.effective_from_relay <= ?
`);
const stmtOrderLookup = db.prepare(`
  SELECT competitor_id FROM team_match_orders
  WHERE team_match_id = ? AND position = ?
`);
const stmtCumulativeBefore = db.prepare(`
  SELECT COALESCE(SUM(left_touches), 0)  AS l,
         COALESCE(SUM(right_touches), 0) AS r
  FROM relays
  WHERE team_match_id = ? AND relay_number < ? AND status = 'finished'
`);
const stmtSetLeftTeamId = db.prepare('UPDATE team_matches SET left_team_id = ? WHERE id = ?');
const stmtSetRightTeamId = db.prepare('UPDATE team_matches SET right_team_id = ? WHERE id = ?');
const stmtFindByIdFull = db.prepare(`
  SELECT tm.*,
         tl.name AS left_team_name, tr.name AS right_team_name,
         tdw.name AS draw_winner_name
  FROM team_matches tm
  LEFT JOIN teams tl  ON tl.id  = tm.left_team_id
  LEFT JOIN teams tr  ON tr.id  = tm.right_team_id
  LEFT JOIN teams tdw ON tdw.id = tm.draw_winner_team_id
  WHERE tm.id = ?
`);
const stmtOrdersCountForTeam = db.prepare(
  'SELECT COUNT(*) AS n FROM team_match_orders WHERE team_match_id = ? AND team_id = ?'
);
const stmtMatchById = db.prepare('SELECT * FROM team_matches WHERE id = ?');
const stmtSetDrawWinner = db.prepare(`
  UPDATE team_matches SET draw_winner_team_id = ?, draw_method = ? WHERE id = ?
`);
const stmtRegularMembersForTeam = db.prepare(`
  SELECT competitor_id FROM team_members WHERE team_id = ? AND role = 'regular'
`);
const stmtSubstitutionOriginal = db.prepare(
  'SELECT original_competitor_id FROM team_match_substitutions WHERE team_match_id = ? AND team_id = ?'
);
const stmtSubstitutionSubstitute = db.prepare(
  'SELECT substitute_competitor_id FROM team_match_substitutions WHERE team_match_id = ? AND team_id = ?'
);
const stmtDeleteOrders = db.prepare('DELETE FROM team_match_orders WHERE team_match_id = ? AND team_id = ?');
const stmtInsertOrder = db.prepare(
  'INSERT INTO team_match_orders (team_match_id, team_id, competitor_id, position) VALUES (?, ?, ?, ?)'
);
const stmtDistinctTeamOrdersCount = db.prepare(`
  SELECT COUNT(DISTINCT team_id) AS n
  FROM team_match_orders WHERE team_match_id = ?
`);
const stmtActivateMatch = db.prepare("UPDATE team_matches SET status = 'active' WHERE id = ?");
const stmtRelaysForMatch = db.prepare(
  'SELECT * FROM relays WHERE team_match_id = ? ORDER BY relay_number'
);
const stmtRelayById = db.prepare('SELECT * FROM relays WHERE id = ?');
const stmtInsertRelayHistory = db.prepare(`
  INSERT INTO relay_history (relay_id, left_touches, right_touches, time_expired, status)
  VALUES (?, ?, ?, ?, ?)
`);
const stmtUpdateRelayResult = db.prepare(`
  UPDATE relays
  SET left_touches = ?, right_touches = ?, time_expired = ?, status = 'finished'
  WHERE id = ?
`);
const stmtMaxRelayNumber = db.prepare(
  'SELECT MAX(relay_number) AS m FROM relays WHERE team_match_id = ?'
);
const stmtFinishMatch = db.prepare(`
  UPDATE team_matches
  SET left_score = ?, right_score = ?, winner_team_id = ?,
      status = CASE WHEN ? IS NOT NULL THEN 'finished' ELSE 'tiebreak' END
  WHERE id = ?
`);
const stmtLastRelayHistory = db.prepare(
  'SELECT * FROM relay_history WHERE relay_id = ? ORDER BY changed_at DESC LIMIT 1'
);
const stmtRestoreRelayFromHistory = db.prepare(`
  UPDATE relays
  SET left_touches = ?, right_touches = ?, time_expired = ?, status = ?
  WHERE id = ?
`);
const stmtDeleteRelayHistory = db.prepare('DELETE FROM relay_history WHERE id = ?');
const stmtClearLeftTeamId = db.prepare('UPDATE team_matches SET left_team_id = NULL WHERE id = ?');
const stmtClearRightTeamId = db.prepare('UPDATE team_matches SET right_team_id = NULL WHERE id = ?');
const stmtResetMatchAfterUndo = db.prepare(`
  UPDATE team_matches
  SET status = 'active', winner_team_id = NULL, left_score = NULL, right_score = NULL
  WHERE id = ?
`);
const stmtSetTiebreakWinner = db.prepare(`
  UPDATE team_matches SET winner_team_id = ?, status = 'finished' WHERE id = ?
`);
const stmtExistingSubstitution = db.prepare(
  'SELECT id FROM team_match_substitutions WHERE team_match_id = ? AND team_id = ?'
);
const stmtOriginalOrderForPosition = db.prepare(
  'SELECT competitor_id FROM team_match_orders WHERE team_match_id = ? AND team_id = ? AND position = ?'
);
const stmtReserveForTeam = db.prepare(`
  SELECT tm.competitor_id FROM team_members tm
  WHERE tm.team_id = ? AND tm.role = 'reserve'
`);
const stmtInsertSubstitution = db.prepare(`
  INSERT INTO team_match_substitutions
    (team_match_id, team_id, position_replaced, original_competitor_id,
     substitute_competitor_id, effective_from_relay)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const stmtFindAvailable = db.prepare(`
  SELECT tm.id, tm.status, tm.left_team_id, tm.right_team_id,
         tm.left_score, tm.right_score, tm.phase_id, tm.de_round, tm.place_rank,
         tl.name AS left_team_name, tr.name AS right_team_name,
         co.name AS competition_name, co.weapon,
         ph.phase_order,
         CASE WHEN tm.draw_winner_team_id IS NOT NULL THEN 1 ELSE 0 END AS draw_done,
         (SELECT COUNT(*) FROM team_match_orders o WHERE o.team_match_id = tm.id) AS order_count
  FROM team_matches tm
  LEFT JOIN teams tl ON tl.id = tm.left_team_id
  LEFT JOIN teams tr ON tr.id = tm.right_team_id
  JOIN phases ph       ON ph.id = tm.phase_id
  JOIN competitions co ON co.id = ph.competition_id
  WHERE tm.status != 'finished'
    AND tm.left_team_id IS NOT NULL
    AND tm.right_team_id IS NOT NULL
  ORDER BY co.name, tm.match_order
`);
const stmtPendingRelaysForMatch = db.prepare(
  'SELECT * FROM relays WHERE team_match_id = ? AND status = ? ORDER BY relay_number',
);
const stmtMatchStatusOnly = db.prepare(
  'SELECT status FROM team_matches WHERE id = ?'
);
const stmtMatchPhaseId = db.prepare('SELECT phase_id FROM team_matches WHERE id = ?');
const stmtPhaseRuleDoc = db.prepare('SELECT rule_doc FROM phases WHERE id = ?');
const stmtFencerName = db.prepare(`
  SELECT first_name, last_name FROM competitors WHERE id = ?
`);

// Resolve which competitor fences at a given position for a given relay.
// Returns competitor_id or null if orders have not been submitted yet.
function resolveCompetitor(matchId, position, relayNumber) {
  const sub = stmtSubstitutionLookup.get(matchId, position, relayNumber);
  if (sub) return sub.substitute_competitor_id;

  const order = stmtOrderLookup.get(matchId, position);
  return order?.competitor_id ?? null;
}

// Returns { leftCumulative, rightCumulative } from finished relays up to (but not including) relayNumber.
function cumulativeBefore(matchId, relayNumber) {
  const row = stmtCumulativeBefore.get(matchId, relayNumber);
  return { leftCumulative: row.l, rightCumulative: row.r };
}

// Wire the match winner (or loser) into the next bracket slot.
function routeMatchResult(match) {
  if (match.winner_next_match_id) {
    const stmt = match.winner_next_side === 'left' ? stmtSetLeftTeamId : stmtSetRightTeamId;
    stmt.run(match.winner_team_id, match.winner_next_match_id);
  }
  if (match.loser_next_match_id) {
    const loserId = match.winner_team_id === match.left_team_id
      ? match.right_team_id
      : match.left_team_id;
    const stmt = match.loser_next_side === 'left' ? stmtSetLeftTeamId : stmtSetRightTeamId;
    stmt.run(loserId, match.loser_next_match_id);
  }
}

const TeamMatch = {
  findById(matchId) {
    const match = stmtFindByIdFull.get(matchId);
    if (!match) return null;

    const { leftCumulative, rightCumulative } = cumulativeBefore(matchId, 999);
    match.left_cumulative  = leftCumulative;
    match.right_cumulative = rightCumulative;

    match.orders_left  = stmtOrdersCountForTeam.get(matchId, match.left_team_id)?.n ?? 0;
    match.orders_right = stmtOrdersCountForTeam.get(matchId, match.right_team_id)?.n ?? 0;

    return match;
  },

  // Record the draw result. method: 'auto' (random) or 'manual'.
  // winnerTeamId is required for 'manual'; omit (or pass null) for 'auto'.
  draw(matchId, winnerTeamId, method) {
    const match = stmtMatchById.get(matchId);
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

    stmtSetDrawWinner.run(winnerId, method, matchId);

    return this.findById(matchId);
  },

  // Submit fencer order for one team. positionMap: { 1: competitorId, 2: …, 3: … } for Team A
  // or { 4: …, 5: …, 6: … } for Team B.
  submitOrder(matchId, teamId, positionMap) {
    const match = stmtMatchById.get(matchId);
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
    const regularMembers = stmtRegularMembersForTeam.all(teamId).map(r => r.competitor_id);

    // Check substitutions to see if anyone is currently replaced
    const sub = stmtSubstitutionOriginal.get(matchId, teamId);
    const replacedId = sub?.original_competitor_id;

    const reserve = replacedId ? stmtSubstitutionSubstitute.get(matchId, teamId)?.substitute_competitor_id : null;

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
      stmtDeleteOrders.run(matchId, teamId);
      for (const pos of expectedPositions) {
        stmtInsertOrder.run(matchId, teamId, positionMap[pos], pos);
      }

      // Activate match once both teams have submitted orders
      const bothSubmitted = stmtDistinctTeamOrdersCount.get(matchId).n === 2;
      if (bothSubmitted && match.status === 'pending') {
        stmtActivateMatch.run(matchId);
      }
    })();

    return this.findById(matchId);
  },

  // Return relay list with resolved fencer names and running cumulative scores.
  getRelays(matchId) {
    const match = stmtMatchById.get(matchId);
    if (!match) throw Object.assign(new Error('Match not found.'), { status: 404 });

    const relays = stmtRelaysForMatch.all(matchId);

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
    const relay = stmtRelayById.get(relayId);
    if (!relay) throw Object.assign(new Error('Relay not found.'), { status: 404 });
    if (relay.status === 'finished') throw Object.assign(new Error('Relay is already finished.'), { status: 400 });

    const match = stmtMatchById.get(relay.team_match_id);
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
      stmtInsertRelayHistory.run(relayId, relay.left_touches, relay.right_touches, relay.time_expired, relay.status);

      stmtUpdateRelayResult.run(leftTouches, rightTouches, timeExpired ? 1 : 0, relayId);

      // Check if match has ended
      const isLastRelay = relay.relay_number === (stmtMaxRelayNumber.get(relay.team_match_id).m);

      const matchEnds = newLeft >= 45 || newRight >= 45 || isLastRelay;

      if (matchEnds) {
        let winnerId = null;
        if (newLeft > newRight)       winnerId = match.left_team_id;
        else if (newRight > newLeft)  winnerId = match.right_team_id;
        // Equal: tiebreak — leave winner_team_id null for now; director records manually

        stmtFinishMatch.run(newLeft, newRight, winnerId, winnerId, match.id);

        if (winnerId) {
          const updated = stmtMatchById.get(match.id);
          routeMatchResult(updated);
        }
      }
    })();

    return stmtRelayById.get(relayId);
  },

  // Undo the last recorded result for a relay.
  undo(relayId) {
    const relay = stmtRelayById.get(relayId);
    if (!relay) throw Object.assign(new Error('Relay not found.'), { status: 404 });

    const last = stmtLastRelayHistory.get(relayId);
    if (!last) throw Object.assign(new Error('Nothing to undo.'), { status: 400 });

    db.transaction(() => {
      stmtRestoreRelayFromHistory.run(last.left_touches, last.right_touches, last.time_expired, last.status, relayId);
      stmtDeleteRelayHistory.run(last.id);

      // Clear match result if match was previously finished/tiebreak
      const match = stmtMatchById.get(relay.team_match_id);
      if (match.status === 'finished' || match.status === 'tiebreak') {
        // Clear the team that was wired into the next match
        if (match.winner_next_match_id) {
          const stmt = match.winner_next_side === 'left' ? stmtClearLeftTeamId : stmtClearRightTeamId;
          stmt.run(match.winner_next_match_id);
        }
        if (match.loser_next_match_id) {
          const stmt = match.loser_next_side === 'left' ? stmtClearLeftTeamId : stmtClearRightTeamId;
          stmt.run(match.loser_next_match_id);
        }
        stmtResetMatchAfterUndo.run(match.id);
      }
    })();

    return stmtRelayById.get(relayId);
  },

  // Record the winner manually after a tiebreak (sudden death).
  recordTiebreakWinner(matchId, winnerTeamId) {
    const match = stmtMatchById.get(matchId);
    if (!match) throw Object.assign(new Error('Match not found.'), { status: 404 });
    if (match.status !== 'tiebreak') throw Object.assign(new Error('Match is not in tiebreak.'), { status: 400 });
    if (winnerTeamId !== match.left_team_id && winnerTeamId !== match.right_team_id) {
      throw Object.assign(new Error('Winner must be one of the two teams.'), { status: 400 });
    }

    db.transaction(() => {
      stmtSetTiebreakWinner.run(winnerTeamId, matchId);
      const updated = stmtMatchById.get(matchId);
      routeMatchResult(updated);
    })();

    return this.findById(matchId);
  },

  // Declare a substitution (reserve replaces a regular fencer from a given relay onward).
  applySubstitution(matchId, teamId, positionReplaced, effectiveFromRelay) {
    const match = stmtMatchById.get(matchId);
    if (!match) throw Object.assign(new Error('Match not found.'), { status: 404 });
    if (match.status !== 'active') throw Object.assign(new Error('Match is not active.'), { status: 400 });

    const existing = stmtExistingSubstitution.get(matchId, teamId);
    if (existing) throw Object.assign(new Error('This team has already used its substitution.'), { status: 400 });

    // Determine which team is A or B to validate the position number
    const isTeamA = Number(teamId) === Number(match.draw_winner_team_id);
    const validPositions = isTeamA ? [1, 2, 3] : [4, 5, 6];
    if (!validPositions.includes(positionReplaced)) {
      throw Object.assign(new Error(`Invalid position ${positionReplaced} for this team.`), { status: 400 });
    }

    const originalOrder = stmtOriginalOrderForPosition.get(matchId, teamId, positionReplaced);
    if (!originalOrder) throw Object.assign(new Error('No order submitted for this position.'), { status: 400 });

    const reserve = stmtReserveForTeam.get(teamId);
    if (!reserve) throw Object.assign(new Error('No reserve available for this team.'), { status: 400 });

    stmtInsertSubstitution.run(matchId, teamId, positionReplaced,
           originalOrder.competitor_id, reserve.competitor_id, effectiveFromRelay);

    return this.findById(matchId);
  },

  // All non-finished team matches with both teams set — used by pipeline builder.
  // Includes draw_done and order_count so the UI can warn when a match isn't ready.
  findAvailable() {
    return stmtFindAvailable.all();
  },

  // Simulate a single match: randomly score all relays.
  simulate(matchId) {
    const match = stmtMatchById.get(matchId);
    if (!match) throw Object.assign(new Error('Match not found.'), { status: 404 });

    // Auto-draw if not done
    if (!match.draw_winner_team_id) this.draw(matchId, null, 'auto');

    // Auto-submit orders if not done
    const updatedMatch = stmtMatchById.get(matchId);
    _autoSubmitOrders(updatedMatch);

    // Reload after activation
    const activeMatch = stmtMatchById.get(matchId);
    if (activeMatch.status !== 'active') throw Object.assign(
      new Error('Match could not be activated for simulation.'), { status: 400 }
    );

    const relays = stmtPendingRelaysForMatch.all(matchId, 'pending');

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
      const updated = stmtMatchStatusOnly.get(matchId);
      if (updated.status !== 'active') break;
    }

    // Handle tiebreak: randomly pick winner
    const finalMatch = stmtMatchById.get(matchId);
    if (finalMatch.status === 'tiebreak') {
      const winnerId = Math.random() < 0.5 ? finalMatch.left_team_id : finalMatch.right_team_id;
      this.recordTiebreakWinner(matchId, winnerId);
    }
  },
};

// Returns the relay rule definitions for a match (from its phase's rule_doc).
function _getRuleRelays(matchId) {
  const match = stmtMatchPhaseId.get(matchId);
  const phase = stmtPhaseRuleDoc.get(match.phase_id);
  const rule  = require('../lib/rules').loadRule(phase.rule_doc);
  return rule.relays;
}

// Returns "Last, First" for a competitor_id.
function _fencerName(competitorId) {
  const row = stmtFencerName.get(competitorId);
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
    const existing = stmtOrdersCountForTeam.get(match.id, teamId).n;
    if (existing > 0) continue;

    const regulars = stmtRegularMembersForTeam.all(teamId).map(r => r.competitor_id);

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
