'use strict';
const db = require('../db');

const Settings = {
  get(key) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : null;
  },

  set(key, value) {
    db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, String(value));
  },

  all() {
    return db.prepare('SELECT key, value FROM settings').all()
      .reduce((acc, { key, value }) => { acc[key] = value; return acc; }, {});
  },

  delete(key) {
    db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  },
};

module.exports = Settings;
