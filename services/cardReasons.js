'use strict';
const db = require('../db');

const stmtInsert      = db.prepare('INSERT INTO card_reasons (bout_id, piste_id, side, card, reason) VALUES (@boutId, @pisteId, @side, @card, @reason)');
const stmtFindById    = db.prepare('SELECT * FROM card_reasons WHERE id = ?');
const stmtFindByBout  = db.prepare('SELECT * FROM card_reasons WHERE bout_id = ? ORDER BY recorded_at');
const stmtFindByPiste = db.prepare('SELECT * FROM card_reasons WHERE piste_id = ? ORDER BY recorded_at DESC LIMIT ?');

const CardReason = {
  record({ boutId, pisteId, side, card, reason }) {
    const { lastInsertRowid } = stmtInsert.run({ boutId: boutId || null, pisteId, side, card, reason });
    return stmtFindById.get(lastInsertRowid);
  },

  findById(id) {
    return stmtFindById.get(id);
  },

  findByBout(boutId) {
    return stmtFindByBout.all(boutId);
  },

  findByPiste(pisteId, limit = 20) {
    return stmtFindByPiste.all(pisteId, limit);
  },
};

module.exports = CardReason;
