'use strict';

// DE-phase-specific logic, split out of services/phases.js (2026-07-28
// architecture review). See services/poolPhases.js's header comment for the
// full split rationale; services/phases.js is the orchestrator that
// re-exports getDeOptions/createDE from here directly.

const db                   = require('../db');
const { loadRule }         = require('../lib/rules');
const { buildFullBracket, buildBracketShape, buildSeedPositions, getTableauSize } = require('../lib/deFormation');
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

// Skeleton (createSkeleton/seedSkeleton) — see the plan doc / CLAUDE.md for
// why this exists: a DE phase can now be created from just an estimated
// headcount, real competitors filled in later once the prior stage finishes.
const stmtInsertDeSkeletonPhase = db.prepare(`
  INSERT INTO phases (competition_id, phase_order, type, rule_doc, status, format_stage)
  VALUES (@comp_id, @order, 'de', @rule_doc, 'skeleton', @format_stage)
`);
const stmtSetPhaseActive = db.prepare("UPDATE phases SET status = 'active' WHERE id = ?");
const stmtRound1Count = db.prepare("SELECT COUNT(*) AS n FROM bouts WHERE phase_id = ? AND bracket = 'main' AND de_round = 1");
const stmtRound1BoutsOrdered = db.prepare(
  "SELECT id, tableau_position FROM bouts WHERE phase_id = ? AND bracket = 'main' AND de_round = 1 ORDER BY tableau_position"
);
const stmtSeedBoutSides = db.prepare('UPDATE bouts SET left_id = ?, right_id = ? WHERE id = ?');
const stmtFinishBye     = db.prepare("UPDATE bouts SET status = 'finished', winner_id = ?, left_score = ?, right_score = ? WHERE id = ?");

// Pass 1 (insert every node as a bout row) + Pass 2 (wire routing pointers)
// from createDE's original single-shot flow, factored out so createSkeleton
// can reuse it without the bye passes (3/4) that follow only when real
// competitors are already known.
function _insertBracketNodes(phaseId, nodes) {
  const dbIds = new Array(nodes.length);
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
  // No-ops safely for a skeleton's still-empty rows (normalizeHandedness
  // returns immediately when either side is null).
  for (const n of nodes) {
    Bout.normalizeHandedness(n.dbId);
  }

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

  return dbIds;
}

// DB-row/UPDATE-based mirror of buildBracketShape's in-memory seedRound1 +
// createDE's Pass 3/4 — for a bracket whose rows already exist (built by
// createSkeleton), being seeded later once real competitors are known.
// tableau_position -> seed lookup mirrors buildBracketShape's own R1 loop
// (pos = i/2 + 1, i.e. i = (pos-1)*2) exactly, so this must stay in sync with
// that function if it ever changes.
function _seedExistingBracket(phaseId, competitors, T) {
  const seedSlots = buildSeedPositions(T);
  const bySeed = {};
  for (let i = 0; i < competitors.length; i++) bySeed[i + 1] = competitors[i];

  const rows = stmtRound1BoutsOrdered.all(phaseId);
  for (const row of rows) {
    const i = (row.tableau_position - 1) * 2;
    const lComp = bySeed[seedSlots[i]]     || null;
    const rComp = bySeed[seedSlots[i + 1]] || null;

    stmtSeedBoutSides.run(lComp?.competitor_id ?? null, rComp?.competitor_id ?? null, row.id);
    Bout.normalizeHandedness(row.id);

    if (!lComp || !rComp) {
      const winner = lComp ?? rComp;
      stmtFinishBye.run(winner.competitor_id, lComp ? 1 : 0, rComp ? 1 : 0, row.id);
      // Same reason as createDE's Pass 4: a bye's winner must be forwarded
      // and the cascade check run (double-bye-into-same-repechage-slot
      // starvation), not just left as a locally-finished bout.
      Bout.routeBoutResult(row.id);
    }
  }
}

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

      // Pass 1 + 2 — insert every bout, wire routing pointers.
      const dbIds = _insertBracketNodes(phaseId, nodes);

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

  // ---------------------------------------------------------------------------
  // Create a DE phase's full bracket now, from an *estimated* headcount,
  // before the real prior stage has finished — every round's bout rows exist
  // for real (real phase_id/tableau/de_round/partition, so real
  // pipeline_slots can be scheduled against every round today), with
  // left_id/right_id left null until seedSkeleton fills them in later. Always
  // format-driven (a skeleton only makes sense when the format's shape is
  // already known) — does NOT call Format.assertNextStage, the whole point
  // being to build ahead of the dependency finishing.
  // ---------------------------------------------------------------------------
  createSkeleton(compId, ruleDoc, estimatedN, formatStageId) {
    if (!formatStageId) {
      throw Object.assign(new Error('formatStageId is required to create a DE skeleton.'), { status: 400 });
    }
    const n = Number(estimatedN);
    if (!Number.isInteger(n) || n < 2) {
      throw Object.assign(new Error('estimatedN must be an integer >= 2.'), { status: 400 });
    }

    const rule = loadRule(ruleDoc);
    const T = getTableauSize(n);
    const { nodes } = buildBracketShape(T, rule);

    const phaseId = db.transaction(() => {
      const maxOrder = stmtMaxPhaseOrder.get(compId).m;
      const { lastInsertRowid: phaseId } = stmtInsertDeSkeletonPhase.run({
        comp_id: Number(compId), order: maxOrder + 1, rule_doc: ruleDoc, format_stage: formatStageId,
      });
      _insertBracketNodes(phaseId, nodes);
      return phaseId;
    })();

    return stmtPhaseById.get(phaseId);
  },

  // ---------------------------------------------------------------------------
  // Fill in a skeleton's round-1 bouts with the real competitors, once the
  // real prior stage has actually finished. Real gate (Format.assertNextStage)
  // runs here, deferred from createSkeleton. On a tableau-size mismatch
  // between the estimate and reality (round count would differ, not just bye
  // count), throws rather than silently rebuilding — a director-confirmed
  // rebuild is a separate, deliberate action, not automatic (see the plan
  // doc's TABLEAU_MISMATCH handling).
  // ---------------------------------------------------------------------------
  seedSkeleton(phaseId) {
    const phase = stmtPhaseById.get(phaseId);
    if (!phase) throw Object.assign(new Error('Phase not found'), { status: 404 });
    if (phase.status !== 'skeleton') {
      throw Object.assign(new Error('Phase is not a pending skeleton.'), { status: 400 });
    }

    const comp = stmtCompFormatId.get(phase.competition_id);
    if (!phase.format_stage || !comp?.format_id) {
      throw Object.assign(new Error('Skeleton phase has no format stage to resolve participants from.'), { status: 400 });
    }
    const format = Format.loadFormat(comp.format_id);
    const stage  = Format.getStage(format, phase.format_stage);
    Format.assertNextStage(phase.competition_id, format, phase.format_stage);
    const competitors = Format.resolveParticipants(phase.competition_id, format, stage);

    if (competitors.length < 2) {
      throw Object.assign(new Error('At least 2 competitors required to seed this bracket.'), { status: 400 });
    }

    const round1 = stmtRound1Count.get(phaseId).n;
    if (!round1) {
      throw Object.assign(new Error('Skeleton has no round-1 bouts to seed.'), { status: 400 });
    }
    const builtT = round1 * 2;
    const realT  = getTableauSize(competitors.length);

    if (realT !== builtT) {
      throw Object.assign(
        new Error(
          `Tableau size mismatch: this bracket was built for ${builtT} (estimate), but ` +
          `${competitors.length} real competitors need ${realT}. The round count itself is ` +
          `different — filling in names can't fix this; the bracket needs a deliberate rebuild.`
        ),
        { status: 409, code: 'TABLEAU_MISMATCH', estimatedT: builtT, realT }
      );
    }

    db.transaction(() => {
      _seedExistingBracket(phaseId, competitors, realT);
      stmtSetPhaseActive.run(phaseId);
    })();

    return stmtPhaseById.get(phaseId);
  },
};

module.exports = DePhases;
