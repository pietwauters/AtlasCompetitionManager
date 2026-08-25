'use strict';

// Fills in virtual pipeline_slots (public/opp2.html's "Planned (no phase yet)"
// placeholders — see migration 039 and services/pipelineSlots.js's addSlot
// guard) with real data the instant a matching real phase is created. Unlike
// services/schedulePlanReconcile.js (which reconciles a separate abstract
// what-if plan by creating brand-new real slots), a virtual slot is already a
// live, director-placed pipeline_slots row — already positioned, possibly
// already given a referee — so activating it means updating that SAME row in
// place, not creating a new one elsewhere.
//
// Only DE round 1 is activated automatically, same scope as
// schedulePlanReconcile.js and for the same reason: later rounds/repechage/
// placement depend on real round-1 results and stay on the existing live
// de.html/opp2.html workflow.

const db = require('../db');
const Pipeline = require('./pipeline');
const { rangeToPartition } = require('../lib/deSlotMath');

const stmtVirtualSlotsForStage = db.prepare(`
  SELECT * FROM pipeline_slots
  WHERE type = 'virtual' AND virtual_competition_id = ? AND virtual_format_stage_id = ?
  ORDER BY id
`);
const stmtPoolsForPhase = db.prepare('SELECT id FROM pools WHERE phase_id = ? ORDER BY pool_number');
const stmtRound1BoutCount = db.prepare('SELECT COUNT(*) AS cnt FROM bouts WHERE phase_id = ? AND de_round = 1');

const stmtActivateAsPool = db.prepare(`
  UPDATE pipeline_slots SET type = 'pool', pool_id = ?,
    virtual_competition_id = NULL, virtual_format_stage_id = NULL,
    virtual_phase_type = NULL, virtual_label = NULL
  WHERE id = ?
`);
const stmtActivateAsDe = db.prepare(`
  UPDATE pipeline_slots SET type = 'de', phase_id = ?, tableau = ?, partition = ?,
    de_round = 1, bracket = 'main',
    virtual_competition_id = NULL, virtual_format_stage_id = NULL,
    virtual_phase_type = NULL, virtual_label = NULL
  WHERE id = ?
`);
// Mirrors what services/pipelineSlots.js's addSlot already does for a fresh
// pool assignment — kept consistent so pool.html's strip display and the
// strip's own status are correct the moment a virtual slot becomes real.
const stmtSetPoolStripId    = db.prepare('UPDATE pools SET strip_id = ? WHERE id = ?');
const stmtSetStripAssigned  = db.prepare("UPDATE strips SET status = 'assigned' WHERE id = ?");

function isPowerOfTwo(x) {
  return Number.isInteger(x) && x > 0 && (x & (x - 1)) === 0;
}

const PipelineVirtualSlots = {
  // Called from routes/phases.js right after a real phase is created.
  // Returns null if no virtual placeholders match this phase (the ordinary
  // case for most phases) — never throws for that; only for a genuine
  // matched-but-broken state (e.g. a matched phase with zero pools/bouts),
  // which the caller wraps in its own swallow-and-log, same as
  // services/schedulePlanReconcile.js's applyPhaseIfPlanned.
  applyToPhase(phase) {
    if (!phase.format_stage) return null;
    const virtualSlots = stmtVirtualSlotsForStage.all(phase.competition_id, phase.format_stage);
    if (!virtualSlots.length) return null;

    return db.transaction(() => {
      const M = virtualSlots.length;
      let activated = 0;
      const deleted = [];
      let overflowCreated = 0;

      if (phase.type === 'pool') {
        const pools = stmtPoolsForPhase.all(phase.id);
        if (!pools.length) throw new Error('Matched phase has no pools yet.');
        const P = pools.length;

        for (let i = 0; i < Math.min(P, M); i++) {
          const slot = virtualSlots[i];
          stmtActivateAsPool.run(pools[i].id, slot.id);
          stmtSetPoolStripId.run(slot.strip_id, pools[i].id);
          stmtSetStripAssigned.run(slot.strip_id);
          activated++;
        }

        // Fewer real pools than planned placeholders — nothing left for the
        // extra virtual rows to become. Delete them and report what's lost
        // (a director may already have set a referee/time on one).
        for (let i = P; i < M; i++) {
          const slot = virtualSlots[i];
          deleted.push({ stripId: slot.strip_id, scheduledStart: slot.scheduled_start });
          Pipeline.deleteSlot(slot.id);
        }

        // More real pools than planned placeholders — round-robin the
        // overflow across the same (now real) strips, same as
        // schedulePlanReconcile.js's P > M handling.
        for (let i = M; i < P; i++) {
          const strip = virtualSlots[i % M];
          Pipeline.addSlot(strip.strip_id, {
            type: 'pool', pool_id: pools[i].id, scheduled_start: strip.scheduled_start,
          });
          overflowCreated++;
        }
      } else {
        const round1 = stmtRound1BoutCount.get(phase.id);
        if (!round1?.cnt) throw new Error('Matched DE phase has no round-1 bouts yet.');
        const tableau = round1.cnt * 2;
        const n = round1.cnt;

        if (M > 1 && isPowerOfTwo(M) && n % M === 0) {
          const chunk = n / M;
          const partitions = [];
          for (let i = 0; i < M; i++) {
            const lo = i * chunk + 1, hi = lo + chunk - 1;
            partitions.push(rangeToPartition(lo, hi, n));
          }
          if (partitions.every(Boolean)) {
            for (let i = 0; i < M; i++) {
              stmtActivateAsDe.run(phase.id, tableau, partitions[i], virtualSlots[i].id);
              activated++;
            }
          }
        }
        if (!activated) {
          // M === 1, or M doesn't cleanly subdivide round 1 — activate only
          // the first placeholder as 'full', delete the rest.
          stmtActivateAsDe.run(phase.id, tableau, 'full', virtualSlots[0].id);
          activated = 1;
          for (let i = 1; i < M; i++) {
            const slot = virtualSlots[i];
            deleted.push({ stripId: slot.strip_id, scheduledStart: slot.scheduled_start });
            Pipeline.deleteSlot(slot.id);
          }
        }
      }

      return { phaseId: phase.id, activated, deletedCount: deleted.length, deleted, overflowCreated };
    })();
  },
};

module.exports = PipelineVirtualSlots;
