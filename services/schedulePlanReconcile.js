'use strict';

// Reconciles a schedule-plan stage (services/schedulePlans.js — the abstract
// "Phase 1" pre-scheduling tool) with the real phase/pools/DE-tableau a director
// creates, turning the plan's already-solved strip/time layout into real
// pipeline_slots. Closes the loop schedule_plan_stages.phase_id and
// schedule_plan_slots.pipeline_slot_id were left as unused forward-compat columns
// for since migration 035.
//
// One entry point: applyPhaseIfPlanned(phase), called automatically from
// routes/phases.js the instant a real phase is created — this is what lets a
// director pre-plan a DE phase's strip assignment before the prior pool phase
// even finishes, without a separate manual step once the DE phase exists.
// Returns null (not a throw) when there's simply no plan to apply — that's the
// common case for most phases in this app and must be a silent no-op, not a
// logged exception every time.
//
// Only format-driven plan stages (format_stage_id set) can be matched — a
// manually-added stage has nothing to correlate against a real phase. Only DE
// round 1 is reconciled; later rounds/repechage/placement depend on real
// round-1 results and stay on the existing live opp2.html/de.html workflow,
// untouched.

const db = require('../db');
const Pipeline = require('./pipeline');
const { rangeToPartition } = require('../lib/deSlotMath');

const stmtFindStageForPhase = db.prepare(`
  SELECT * FROM schedule_plan_stages
  WHERE competition_id = ? AND format_stage_id = ? AND phase_type = ? AND phase_id IS NULL
  ORDER BY id DESC LIMIT 1
`);
const stmtRealSlotsForStage = db.prepare(`
  SELECT * FROM schedule_plan_slots WHERE schedule_plan_stage_id = ? AND strip_id IS NOT NULL ORDER BY id
`);
const stmtPoolsForPhase = db.prepare('SELECT id FROM pools WHERE phase_id = ? ORDER BY pool_number');
const stmtRound1BoutCount = db.prepare('SELECT COUNT(*) AS cnt FROM bouts WHERE phase_id = ? AND de_round = 1');
const stmtSetStagePhaseId = db.prepare('UPDATE schedule_plan_stages SET phase_id = ? WHERE id = ?');
const stmtSetSlotPipelineSlotId = db.prepare('UPDATE schedule_plan_slots SET pipeline_slot_id = ? WHERE id = ?');

function isPowerOfTwo(x) {
  return Number.isInteger(x) && x > 0 && (x & (x - 1)) === 0;
}

// A DE stage's schedule_plan_slots span multiple time clusters, one per
// tableau round (services/schedulePlans.js's _buildSolverInput explodes a DE
// stage into one solver unit per round, each producing its own cluster of
// slots at its own scheduled_start) — only round 1 is ever reconciled here
// (see the file header), so narrow down to just the earliest cluster before
// counting "planned strips." Without this, a stage planned across 3 rounds on
// 2 strips each would look like 6 undifferentiated strips, breaking the
// power-of-two partition math below for round 1 specifically.
function round1Slots(allSlots) {
  const earliestStart = allSlots.reduce(
    (min, s) => (s.scheduled_start < min ? s.scheduled_start : min), allSlots[0].scheduled_start
  );
  return allSlots.filter(s => s.scheduled_start === earliestStart);
}

// The actual reconciliation. Throws on any condition that leaves nothing to
// apply (no real strips planned, matched phase has no pools/bouts yet) — the
// caller (applyPhaseIfPlanned's own caller, routes/phases.js) wraps this in a
// swallow-and-log try/catch, never lets it block phase creation.
function _reconcile(stage, phase) {
  const allPlannedSlots = stmtRealSlotsForStage.all(stage.id);
  if (!allPlannedSlots.length) {
    throw new Error('No real strips were planned for this stage — nothing to apply.');
  }
  const plannedSlots = stage.phase_type === 'de' ? round1Slots(allPlannedSlots) : allPlannedSlots;

  let minutesPerBout = 5;
  try {
    const computed = stage.computed_json ? JSON.parse(stage.computed_json) : null;
    if (computed?.minutesPerBout) minutesPerBout = computed.minutesPerBout;
  } catch { /* fall back to default */ }

  return db.transaction(() => {
    const M = plannedSlots.length;
    const created = [];
    let usedSlots = [];
    let unassignedStrips = 0;

    if (stage.phase_type === 'pool') {
      const pools = stmtPoolsForPhase.all(phase.id);
      if (!pools.length) throw new Error('Matched phase has no pools yet.');
      const P = pools.length;
      // Round-robin: pool i -> planned strip (i % M). P > M queues multiple
      // pools sequentially on the same strip — normal pipeline_slots usage.
      for (let i = 0; i < P; i++) {
        const strip = plannedSlots[i % M];
        created.push(Pipeline.addSlot(strip.strip_id, {
          type: 'pool', pool_id: pools[i].id,
          scheduled_start: strip.scheduled_start, minutes_per_bout: minutesPerBout,
        }));
      }
      if (P === M) usedSlots = plannedSlots; // clean 1:1 — safe to link pipeline_slot_id
      unassignedStrips = Math.max(0, M - P);
    } else {
      const round1 = stmtRound1BoutCount.get(phase.id);
      if (!round1?.cnt) throw new Error('Matched DE phase has no round-1 bouts yet.');
      const tableau = round1.cnt * 2;
      const n = round1.cnt; // bouts in round 1

      if (M > 1 && isPowerOfTwo(M) && n % M === 0) {
        const chunk = n / M;
        const partitions = [];
        for (let i = 0; i < M; i++) {
          const lo = i * chunk + 1, hi = lo + chunk - 1;
          partitions.push(rangeToPartition(lo, hi, n));
        }
        if (partitions.every(Boolean)) {
          for (let i = 0; i < M; i++) {
            created.push(Pipeline.addSlot(plannedSlots[i].strip_id, {
              type: 'de', phase_id: phase.id, tableau, partition: partitions[i],
              de_round: 1, bracket: 'main',
              scheduled_start: plannedSlots[i].scheduled_start, minutes_per_bout: minutesPerBout,
            }));
          }
          usedSlots = plannedSlots;
        }
      }
      if (!created.length) {
        // M === 1, or M doesn't cleanly subdivide round 1 into a valid
        // partition set — auto-assign just the first planned strip and
        // report the rest as needing manual assignment in de.html.
        created.push(Pipeline.addSlot(plannedSlots[0].strip_id, {
          type: 'de', phase_id: phase.id, tableau, partition: 'full',
          de_round: 1, bracket: 'main',
          scheduled_start: plannedSlots[0].scheduled_start, minutes_per_bout: minutesPerBout,
        }));
        usedSlots = [plannedSlots[0]];
        unassignedStrips = M - 1;
      }
    }

    stmtSetStagePhaseId.run(phase.id, stage.id);
    for (let i = 0; i < usedSlots.length; i++) {
      stmtSetSlotPipelineSlotId.run(created[i].id, usedSlots[i].id);
    }

    return {
      phaseId: phase.id,
      slotsCreated: created.length,
      stripsUsed: new Set(created.map(s => s.strip_id)).size,
      unassignedStrips,
    };
  })();
}

const SchedulePlanReconcile = {
  // Automatic entry point, called from routes/phases.js right after a real
  // phase is created. null means "nothing to apply" — no plan matched this
  // phase, which is the ordinary case for most phases in this app and must
  // stay a fast, silent no-op. Still throws for a genuine match with nothing
  // appliable (e.g. zero real strips planned) — the caller wraps this in its
  // own try/catch and logs, never lets it block phase creation.
  applyPhaseIfPlanned(phase) {
    if (!phase.format_stage) return null;
    const stage = stmtFindStageForPhase.get(phase.competition_id, phase.format_stage, phase.type);
    if (!stage) return null;
    return _reconcile(stage, phase);
  },
};

module.exports = SchedulePlanReconcile;
