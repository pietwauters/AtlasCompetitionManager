'use strict';
const db = require('../db');

const Event = {
  record({ competition_id, phase_id = null, bout_id = null,
           event_type, actor, actor_id = null, side = null,
           correlation_id = null, payload = null }) {
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO events
        (competition_id, phase_id, bout_id, event_type, actor, actor_id,
         side, correlation_id, payload)
      VALUES
        (@competition_id, @phase_id, @bout_id, @event_type, @actor, @actor_id,
         @side, @correlation_id, @payload)
    `).run({
      competition_id: competition_id || null,
      phase_id:       phase_id       || null,
      bout_id:        bout_id        || null,
      event_type,
      actor,
      actor_id:       actor_id       || null,
      side:           side           || null,
      correlation_id: correlation_id || null,
      payload:        payload        ? JSON.stringify(payload) : null,
    });
    return lastInsertRowid;
  },

  findByBout(boutId) {
    return db.prepare(
      'SELECT * FROM events WHERE bout_id = ? ORDER BY recorded_at'
    ).all(boutId);
  },

  findByCompetition(compId) {
    return db.prepare(
      'SELECT * FROM events WHERE competition_id = ? ORDER BY recorded_at DESC'
    ).all(compId);
  },
};

module.exports = Event;
