'use strict';

// Director-set scheduling overrides for the tournament schedule planner —
// see docs/schedule-planner-algorithm.md. Two independent concepts, both
// pure CRUD against their own table, no solver logic here:
//   - Per-round overrides (fixed start / explicit buffer-after, migration
//     044): schedule_plan_round_overrides, keyed by (stage, tableau_size) —
//     0 is the sentinel for a stage's own single unit (a pool phase).
//   - Competition-exclusive piste reservations (migration 045):
//     schedule_plan_piste_reservations, keyed by (plan, strip).
// Split out of schedulePlans.js (2026-08-28) once that file crossed the
// project's god-file threshold — merged back onto the same SchedulePlans
// object there (Object.assign), not required independently, so every
// method still sees the same `this` regardless of which file defined it.

const db = require('../db');

const stmtOverridesForPlan = db.prepare(`
  SELECT o.* FROM schedule_plan_round_overrides o
  JOIN schedule_plan_stages st ON st.id = o.schedule_plan_stage_id
  WHERE st.schedule_plan_id = ?
`);
const stmtUpsertOverride = db.prepare(`
  INSERT INTO schedule_plan_round_overrides (schedule_plan_stage_id, tableau_size, fixed_start, buffer_after_minutes)
  VALUES (@schedule_plan_stage_id, @tableau_size, @fixed_start, @buffer_after_minutes)
  ON CONFLICT (schedule_plan_stage_id, tableau_size)
  DO UPDATE SET fixed_start = excluded.fixed_start, buffer_after_minutes = excluded.buffer_after_minutes
`);
const stmtOverrideRow = db.prepare(
  'SELECT * FROM schedule_plan_round_overrides WHERE schedule_plan_stage_id = ? AND tableau_size = ?'
);

const stmtReservationsForPlan = db.prepare(
  'SELECT * FROM schedule_plan_piste_reservations WHERE schedule_plan_id = ?'
);
const stmtUpsertReservation = db.prepare(`
  INSERT INTO schedule_plan_piste_reservations (schedule_plan_id, strip_id, competition_id, from_tableau_size)
  VALUES (@schedule_plan_id, @strip_id, @competition_id, @from_tableau_size)
  ON CONFLICT (schedule_plan_id, strip_id)
  DO UPDATE SET competition_id = excluded.competition_id, from_tableau_size = excluded.from_tableau_size
`);
const stmtDeleteReservation = db.prepare(
  'DELETE FROM schedule_plan_piste_reservations WHERE schedule_plan_id = ? AND strip_id = ?'
);

module.exports = {
  // Per-round overrides (fixed start / explicit buffer-after — see migration
  // 044), as [{ schedule_plan_stage_id, tableau_size, fixed_start,
  // buffer_after_minutes }, ...] for the whole plan — consumed by
  // _buildSolverInput and returned as-is to the UI via findPlanView, grouped
  // by stage there for convenience.
  findRoundOverrides(planId) {
    return stmtOverridesForPlan.all(planId);
  },

  // tableauSize: 0 for a pool stage's own single unit, or a real DE tableau
  // size (T4, T8, ...). fixedStart/bufferAfterMinutes: null clears that
  // field; the other field (if already set) is preserved via the upsert's
  // own current-row read.
  setRoundOverride(stageId, tableauSize, { fixed_start, buffer_after_minutes }) {
    const current = stmtOverrideRow.get(stageId, tableauSize);
    stmtUpsertOverride.run({
      schedule_plan_stage_id: stageId,
      tableau_size: tableauSize,
      fixed_start: fixed_start !== undefined ? (fixed_start || null) : (current?.fixed_start ?? null),
      buffer_after_minutes: buffer_after_minutes !== undefined
        ? (buffer_after_minutes === '' || buffer_after_minutes == null ? null : Number(buffer_after_minutes))
        : (current?.buffer_after_minutes ?? null),
    });
  },

  // Competition-exclusive piste reservations (2026-08-28 discussion), as
  // [{ strip_id, competition_id, from_tableau_size }, ...] for the whole
  // plan — consumed by _buildPisteList, returned as-is via findPlanView.
  findPisteReservations(planId) {
    return stmtReservationsForPlan.all(planId);
  },

  // competitionId: null/'' clears the reservation for this strip (piste goes
  // back to fully shared). fromTableauSize: null means active from the very
  // start; otherwise only kicks in once a round's tableau shrinks to that
  // size or below — set individually per strip, not plan-wide.
  setPisteReservation(planId, stripId, { competition_id, from_tableau_size }) {
    if (!competition_id) {
      stmtDeleteReservation.run(planId, stripId);
      return;
    }
    stmtUpsertReservation.run({
      schedule_plan_id: planId,
      strip_id: stripId,
      competition_id: Number(competition_id),
      from_tableau_size: from_tableau_size === '' || from_tableau_size == null ? null : Number(from_tableau_size),
    });
  },
};
