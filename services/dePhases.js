'use strict';

// DE-phase-specific logic, split out of services/phases.js (2026-07-28
// architecture review). See services/poolPhases.js's header comment for the
// full split rationale; services/phases.js is the orchestrator that
// re-exports getDeOptions/createDE from here directly.

const db                   = require('../db');
const { loadRule }         = require('../lib/rules');
const { buildFullBracket } = require('../lib/deFormation');
const Competitor           = require('./competitors');
const Format                = require('./formats');
const Bout                  = require('./bouts');

// ---------------------------------------------------------------------------
// Prepared statements — module-level constants (see CLAUDE.md's hard rule;
// hoisted as part of this split rather than before it).
// ---------------------------------------------------------------------------
const stmtPhaseById       = db.prepare('SELECT * FROM phases WHERE id = ?');
const stmtCompFormatId    = db.prepare('SELECT format_id FROM competitions WHERE id = ?');
const stmtFinishedPoolCount = db.prepare(
  "SELECT COUNT(*) AS n FROM phases WHERE competition_id=? AND type='pool' AND status='finished'"
);
const stmtFinishedPoolPhases = db.prepare(`
  SELECT id FROM phases
  WHERE competition_id = ? AND type = 'pool' AND status = 'finished'
  ORDER BY phase_order
`);
const stmtLastRoundAdvancedRankings = db.prepare(`
  SELECT r.competitor_id
  FROM rankings r
  WHERE r.phase_id = ? AND r.advanced = 1
  ORDER BY r.position
`);

const stmtMaxPhaseOrder   = db.prepare('SELECT COALESCE(MAX(phase_order), 0) AS m FROM phases WHERE competition_id = ?');
const stmtLastPhaseStatus = db.prepare('SELECT status FROM phases WHERE competition_id = ? ORDER BY phase_order DESC LIMIT 1');
const stmtInsertDePhase   = db.prepare(`
  INSERT INTO phases (competition_id, phase_order, type, rule_doc, status, format_stage)
  VALUES (@comp_id, @order, 'de', @rule_doc, 'active', @format_stage)
`);
const stmtInsertDEBout = db.prepare(`
  INSERT INTO bouts
    (phase_id, left_id, right_id, de_round, tableau_position,
     bracket, status, winner_id, left_score, right_score,
     bout_order, place_rank)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const stmtUpdateRouting = db.prepare(`
  UPDATE bouts
  SET winner_next_bout_id = @wnb, winner_next_side = @wns,
      loser_next_bout_id  = @lnb, loser_next_side  = @lns
  WHERE id = @id
`);
const stmtUpdateSlotLeft  = db.prepare('UPDATE bouts SET left_id = ? WHERE id = ?');
const stmtUpdateSlotRight = db.prepare('UPDATE bouts SET right_id = ? WHERE id = ?');

// Returns an ordered array of { competitor_id } for DE seeding.
//
// seedingMethod:
//   'last'     — rank from the most recent finished pool phase (advanced only)
//   'combined' — aggregate stats across ALL finished pool phases, re-rank,
//                include all currently active competitors
//   (fallback) — active competitors sorted by initial_seed
function getDeSeeding(compId, seedingMethod = 'last') {
  const finishedPhases = stmtFinishedPoolPhases.all(compId);

  if (finishedPhases.length === 0) {
    // Straight-to-DE with no preceding pool phase — same present-only rule
    // as PoolPhases.create's fallback (see its comment): only checked-in
    // fencers are entered.
    return Competitor.findAll(compId)
      .filter(c => c.competitor_status === 'active' && c.checked_in === 1)
      .sort((a, b) => (a.initial_seed || 9999) - (b.initial_seed || 9999))
      .map(c => ({ competitor_id: c.competitor_id }));
  }

  if (seedingMethod === 'combined') {
    // Shared with Format.resolveParticipants's own 'combined' seeding
    // stages — see services/formats.js's combinedSeeding for the single
    // implementation (this used to be a second, near-identical copy in
    // services/phases.js; the two had drifted on the checked_in filter —
    // 2026-07-28 architecture review).
    return Format.combinedSeeding(compId);
  }

  // 'last': use only the most recent finished pool phase
  const lastId = finishedPhases[finishedPhases.length - 1].id;
  return stmtLastRoundAdvancedRankings.all(lastId);
}

const DePhases = {
  // ---------------------------------------------------------------------------
  // DE: preview — returns { N, tableauSize, byeCount, totalRounds, finishedPoolPhases }
  // finishedPoolPhases: count of finished pool phases (drives the seeding selector)
  // ---------------------------------------------------------------------------
  getDeOptions(compId) {
    const finishedPoolPhases = stmtFinishedPoolCount.get(compId).n;
    const rows = getDeSeeding(compId, 'last');
    if (rows.length < 2) throw Object.assign(new Error('At least 2 active competitors required.'), { status: 400 });
    const T = 2 ** Math.ceil(Math.log2(rows.length));
    return { N: rows.length, tableauSize: T, byeCount: T - rows.length, totalRounds: Math.log2(T), finishedPoolPhases };
  },

  // ---------------------------------------------------------------------------
  // Create DE phase: inserts phase + all bout slots for every round.
  // seedingMethod: 'last' (default) or 'combined'
  // formatStageId: when provided, participants come from the format definition.
  // ---------------------------------------------------------------------------
  createDE(compId, ruleDoc, seedingMethod = 'last', formatStageId = null) {
    let competitors;
    let resolvedFormat = null;
    let resolvedStage  = null;

    if (formatStageId) {
      const comp = stmtCompFormatId.get(compId);
      if (comp?.format_id) {
        resolvedFormat = Format.loadFormat(comp.format_id);
        resolvedStage  = Format.getStage(resolvedFormat, formatStageId);
        Format.assertNextStage(compId, resolvedFormat, formatStageId);
        competitors = Format.resolveParticipants(compId, resolvedFormat, resolvedStage);
      }
    }

    if (!competitors) {
      const seeding = getDeSeeding(compId, seedingMethod);
      competitors = seeding.map(r => ({ competitor_id: r.competitor_id }));
    }

    const rule = loadRule(ruleDoc);

    const { nodes, tableauSize, totalRounds } = buildFullBracket(competitors, rule);

    const phaseId = db.transaction(() => {
      const maxOrder = stmtMaxPhaseOrder.get(compId).m;

      // See the matching comment in PoolPhases.create — skipped once a format
      // has already validated this stage's real prerequisites (assertNextStage
      // above), so independent parallel tracks can both be active at once.
      if (maxOrder > 0 && !resolvedFormat) {
        const prev = stmtLastPhaseStatus.get(compId);
        if (prev && prev.status !== 'finished') {
          throw Object.assign(
            new Error('Previous phase must be finished before creating a new one.'),
            { status: 400 }
          );
        }
      }

      const { lastInsertRowid: phaseId } = stmtInsertDePhase.run({
        comp_id: Number(compId), order: maxOrder + 1, rule_doc: ruleDoc, format_stage: formatStageId || null,
      });

      // Pass 1 — insert every bout; collect DB ids indexed by tempId.
      const dbIds = new Array(nodes.length); // dbIds[tempId] = DB row id
      for (const n of nodes) {
        const { lastInsertRowid } = stmtInsertDEBout.run(
          phaseId,
          n.leftCompetitorId,
          n.rightCompetitorId,
          n.de_round,
          n.tableau_position,
          n.bracket,
          n.status,
          n.winner_id,
          n.left_score,
          n.right_score,
          n.bout_order,
          n.place_rank,
        );
        dbIds[n.tempId] = lastInsertRowid;
        n.dbId = lastInsertRowid;
      }

      // Real (non-bye) round-1 pairs already have both competitors known at
      // insert time — normalize left/right by handedness now, same as pools.
      // Later rounds get the same treatment as their pairings fill in, via
      // routeBoutResult's cascade (services/bouts.js).
      for (const n of nodes) {
        Bout.normalizeHandedness(n.dbId);
      }

      // Pass 2 — set routing pointers now that all DB ids are known.
      for (const n of nodes) {
        const hasRouting = n.winnerNextTempId !== null || n.loserNextTempId !== null;
        if (!hasRouting) continue;
        stmtUpdateRouting.run({
          id:  n.dbId,
          wnb: n.winnerNextTempId !== null ? dbIds[n.winnerNextTempId] : null,
          wns: n.winnerNextSide   ?? null,
          lnb: n.loserNextTempId  !== null ? dbIds[n.loserNextTempId]  : null,
          lns: n.loserNextSide    ?? null,
        });
      }

      // Pass 3 — wire bye winners into their next-round slots immediately,
      // mirroring what routeBoutResult would do when bouts finish at run time.
      for (const n of nodes) {
        if (n.status !== 'finished' || !n.winner_id || !n.winnerNextTempId) continue;
        const nextDbId = dbIds[n.winnerNextTempId];
        if (n.winnerNextSide === 'left')  stmtUpdateSlotLeft.run(n.winner_id, nextDbId);
        else                              stmtUpdateSlotRight.run(n.winner_id, nextDbId);
      }

      // Pass 4 — run the real routing/cascade check for every bye created above.
      // Pass 3 only forwards a bye's winner; it never checks whether the bye's
      // (nonexistent) loser leaves a repechage/placement slot permanently
      // starved — e.g. two adjacent R1 byes paired into the same repechage
      // Table D slot, neither of which has a loser to send there. That slot
      // would otherwise sit pending forever and stall everything downstream.
      // routeBoutResult's cascade check (services/bouts.js) already detects
      // this; byes just need to actually go through it once.
      for (const n of nodes) {
        if (n.status === 'finished') Bout.routeBoutResult(n.dbId);
      }

      return phaseId;
    })();

    return stmtPhaseById.get(phaseId);
  },
};

module.exports = DePhases;
