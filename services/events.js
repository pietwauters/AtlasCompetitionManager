'use strict';
const db = require('../db');

const stmtRecord = db.prepare(`
  INSERT INTO events
    (competition_id, phase_id, bout_id, event_type, actor, actor_id,
     side, correlation_id, payload)
  VALUES
    (@competition_id, @phase_id, @bout_id, @event_type, @actor, @actor_id,
     @side, @correlation_id, @payload)
`);
const stmtFindByBout = db.prepare('SELECT * FROM events WHERE bout_id = ? ORDER BY recorded_at');

const Event = {
  record({ competition_id, phase_id = null, bout_id = null,
           event_type, actor, actor_id = null, side = null,
           correlation_id = null, payload = null }) {
    const { lastInsertRowid } = stmtRecord.run({
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
    return stmtFindByBout.all(boutId);
  },

  // Optional filters: { event_type, phase_id, bout_id }
  // event_type without a dot is treated as a namespace prefix:
  //   'card'  → matches card.yellow, card.red, card.black, card.p
  //   'video' → matches video.call, video.result
  //   'card.red' → exact match only
  findByCompetition(compId, { event_type, phase_id, bout_id } = {}) {
    const conditions = ['competition_id = @comp_id'];
    const params     = { comp_id: compId };

    if (event_type) {
      if (event_type.includes('.')) {
        conditions.push('event_type = @event_type');
        params.event_type = event_type;
      } else {
        conditions.push("event_type LIKE @event_type");
        params.event_type = event_type + '.%';
      }
    }
    if (phase_id) { conditions.push('phase_id = @phase_id'); params.phase_id = phase_id; }
    if (bout_id)  { conditions.push('bout_id  = @bout_id');  params.bout_id  = bout_id;  }

    // dynamic-sql-ok: WHERE clause built from optional filters, can't be a fixed statement
    return db.prepare(
      `SELECT * FROM events WHERE ${conditions.join(' AND ')} ORDER BY recorded_at DESC`
    ).all(params);
  },
};

module.exports = Event;
