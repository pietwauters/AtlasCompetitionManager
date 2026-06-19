'use strict';
const db = require('../db');

const BoutDurationStandards = {
  getAll() {
    return db.prepare(`
      SELECT weapon, gender, phase_type, minutes_per_bout,
             sample_count, observed_average
      FROM bout_duration_standards
      ORDER BY weapon, gender, phase_type
    `).all();
  },

  // Returns the effective minutes/bout: observed average (if >= 4 samples)
  // or configured default, for a given competition slot.
  getEffective(weapon, gender, phaseType) {
    const row = db.prepare(`
      SELECT minutes_per_bout, sample_count, observed_average
      FROM bout_duration_standards
      WHERE weapon = ? AND gender = ? AND phase_type = ?
    `).get(weapon, gender, phaseType);
    if (!row) return null;
    if (row.sample_count >= 4 && row.observed_average != null)
      return Math.round(row.observed_average * 10) / 10;
    return row.minutes_per_bout;
  },

  // Update running average with a new observed bout duration.
  recordObserved(weapon, gender, phaseType, minutes) {
    const row = db.prepare(`
      SELECT sample_count, observed_average, minutes_per_bout
      FROM bout_duration_standards
      WHERE weapon = ? AND gender = ? AND phase_type = ?
    `).get(weapon, gender, phaseType);
    if (!row) return;

    const n = row.sample_count;
    const prev = row.observed_average ?? row.minutes_per_bout;
    const newAvg = (prev * n + minutes) / (n + 1);

    db.prepare(`
      UPDATE bout_duration_standards
      SET sample_count = sample_count + 1, observed_average = ?
      WHERE weapon = ? AND gender = ? AND phase_type = ?
    `).run(newAvg, weapon, gender, phaseType);
  },

  resetObserved(weapon, gender, phaseType) {
    db.prepare(`
      UPDATE bout_duration_standards
      SET sample_count = 0, observed_average = NULL
      WHERE weapon = ? AND gender = ? AND phase_type = ?
    `).run(weapon, gender, phaseType);
  },
};

module.exports = BoutDurationStandards;
