'use strict';
const db = require('../db');

const CardReason = {
  record({ boutId, pisteId, side, card, reason }) {
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO card_reasons (bout_id, piste_id, side, card, reason)
      VALUES (@boutId, @pisteId, @side, @card, @reason)
    `).run({ boutId: boutId || null, pisteId, side, card, reason });
    return this.findById(lastInsertRowid);
  },

  findById(id) {
    return db.prepare('SELECT * FROM card_reasons WHERE id = ?').get(id);
  },

  findByBout(boutId) {
    return db.prepare(`
      SELECT * FROM card_reasons WHERE bout_id = ? ORDER BY recorded_at
    `).all(boutId);
  },

  findByPiste(pisteId, limit = 20) {
    return db.prepare(`
      SELECT * FROM card_reasons WHERE piste_id = ?
      ORDER BY recorded_at DESC LIMIT ?
    `).all(pisteId, limit);
  },
};

module.exports = CardReason;
