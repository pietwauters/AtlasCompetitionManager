'use strict';
// Competitor roster resolution per pipeline slot — used by the kiosk
// waiting-room displays. Split out of the former services/pipeline.js
// god-file (2026-07-29) — see services/pipeline.js for the orchestrator
// that recombines this with pipelineSlots.js/pipelineNav.js into the same
// public `Pipeline` API every existing caller already uses.
const db = require('../db');
const DeLayout = require('./deLayout');
const PipelineSlots = require('./pipelineSlots');
const { deSlotParams, DE_BOUT_ORDER } = require('../lib/deSlotMath');

const stmtPoolCompetitorsForSlot = db.prepare(`
  SELECT c.id AS competitor_id, c.first_name, c.last_name, c.nationality,
         cl.name AS club_name
  FROM pool_competitors pc
  JOIN competitors c  ON c.id  = pc.competitor_id
  LEFT JOIN people p2 ON p2.id = c.person_id
  LEFT JOIN clubs  cl ON cl.id = p2.club_id
  WHERE pc.pool_id = ?
  ORDER BY c.initial_seed ASC, c.last_name
`);
const stmtTeamMembersForSide = db.prepare(`
  SELECT c.id AS competitor_id, c.first_name, c.last_name, c.nationality,
         cl.name AS club_name, ? AS team_side
  FROM team_members tmm
  JOIN competitors c  ON c.id  = tmm.competitor_id
  LEFT JOIN people p2 ON p2.id = c.person_id
  LEFT JOIN clubs  cl ON cl.id = p2.club_id
  WHERE tmm.team_id = ?
`);
const stmtDeBoutRowsForSlot = db.prepare(`
  WITH ordered AS (${DE_BOUT_ORDER})
  SELECT b.left_id, b.right_id FROM bouts b
  JOIN ordered o ON o.id = b.id
  WHERE b.phase_id = ? AND b.de_round = ? AND o.round_index BETWEEN ? AND ?
`);
const stmtCompetitionRoster = db.prepare(`
  SELECT c.id AS competitor_id, c.first_name, c.last_name, c.nationality,
         cl.name AS club_name
  FROM competitors c
  LEFT JOIN people p2 ON p2.id = c.person_id
  LEFT JOIN clubs  cl ON cl.id = p2.club_id
  WHERE c.competition_id = ?
  ORDER BY c.initial_seed ASC, c.last_name, c.first_name
`);

const PipelineRosters = {
  // Resolve which competitors currently belong to a pipeline slot: the whole
  // pool for a pool slot, both teams' rosters for a team_match slot, or every
  // fencer appearing in the DE bouts the slot's round-range/placement group
  // currently covers (byes and not-yet-decided pairings naturally drop out
  // since their opposing left_id/right_id is still null).
  competitorsForSlot(slot) {
    if (slot.type === 'pool') {
      return stmtPoolCompetitorsForSlot.all(slot.pool_id);
    }

    if (slot.type === 'team_match') {
      const teamMembers = (teamId, side) => teamId ? stmtTeamMembersForSide.all(side, teamId) : [];
      return [...teamMembers(slot.left_team_id, 'left'), ...teamMembers(slot.right_team_id, 'right')];
    }

    // DE (main/repechage/placement)
    let boutRows;
    if (slot.bracket === 'placement') {
      const ids = DeLayout.placementGroupBoutIds(slot.phase_id, slot.tableau, Number(slot.partition));
      if (!ids.length) return [];
      // dynamic-sql-ok: IN(...) placeholder count varies with ids.length
      boutRows = db.prepare(
        `SELECT left_id, right_id FROM bouts WHERE id IN (${ids.map(() => '?').join(',')})`
      ).all(...ids);
    } else {
      const { deRound, lo, hi, bracket } = deSlotParams(slot);
      if (!deRound) return [];
      boutRows = stmtDeBoutRowsForSlot.all(bracket, slot.phase_id, deRound, lo, hi);
    }

    const ids = [...new Set(boutRows.flatMap(b => [b.left_id, b.right_id]).filter(Boolean))];
    if (!ids.length) return [];
    // dynamic-sql-ok: IN(...) placeholder count varies with ids.length
    return db.prepare(`
      SELECT c.id AS competitor_id, c.first_name, c.last_name, c.nationality,
             cl.name AS club_name
      FROM competitors c
      LEFT JOIN people p2 ON p2.id = c.person_id
      LEFT JOIN clubs  cl ON cl.id = p2.club_id
      WHERE c.id IN (${ids.map(() => '?').join(',')})
    `).all(...ids);
  },

  // Every competitor in a competition, each with its currently relevant
  // pipeline assignment (or null if not currently in any non-done slot).
  // Used by the fencer kiosk display. When a competitor matches more than
  // one live slot (e.g. a pool slot and an already-built next-phase DE slot
  // both exist), the active one wins, else the one starting soonest.
  fencersForCompetition(compId) {
    compId = Number(compId);
    const roster = stmtCompetitionRoster.all(compId);

    const candidatesByCompetitor = new Map();
    for (const strip of PipelineSlots.findAllStrips()) {
      for (const slot of strip.slots) {
        if (slot.competition_id !== compId || slot.status === 'done') continue;
        const info = {
          strip_id: strip.id, strip_name: strip.name, strip_number: strip.strip_number,
          scheduled_start: slot.scheduled_start, predicted_end: slot.predicted_end,
          status: slot.status, slot_type: slot.type, pool_number: slot.pool_number,
          bracket: slot.bracket, tableau: slot.tableau, partition: slot.partition,
          left_team_name: slot.left_team_name, right_team_name: slot.right_team_name,
        };
        for (const c of PipelineRosters.competitorsForSlot(slot)) {
          const list = candidatesByCompetitor.get(c.competitor_id) || [];
          list.push(info);
          candidatesByCompetitor.set(c.competitor_id, list);
        }
      }
    }

    const pick = (list) => {
      if (!list || !list.length) return null;
      return list.slice().sort((a, b) => {
        const rank = s => s === 'active' ? 0 : 1;
        if (rank(a.status) !== rank(b.status)) return rank(a.status) - rank(b.status);
        return (a.scheduled_start || '99:99').localeCompare(b.scheduled_start || '99:99');
      })[0];
    };

    return roster.map(r => ({ ...r, assignment: pick(candidatesByCompetitor.get(r.competitor_id)) }));
  },
};

module.exports = PipelineRosters;
