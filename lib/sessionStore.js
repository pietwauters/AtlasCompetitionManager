'use strict';
const session = require('express-session');
const db      = require('../db');

const stmtGetSession     = db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expired_at > ?');
const stmtUpsertSession  = db.prepare(`
  INSERT INTO sessions (sid, sess, expired_at) VALUES (?, ?, ?)
  ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expired_at = excluded.expired_at
`);
const stmtDeleteSession  = db.prepare('DELETE FROM sessions WHERE sid = ?');
const stmtPurgeSessions  = db.prepare('DELETE FROM sessions WHERE expired_at < ?');

const PURGE_INTERVAL_MS = 15 * 60 * 1000;

class SQLiteStore extends session.Store {
  constructor() {
    super();
    setInterval(() => {
      stmtPurgeSessions.run(Date.now());
    }, PURGE_INTERVAL_MS).unref();
  }

  get(sid, cb) {
    try {
      const row = stmtGetSession.get(sid, Date.now());
      cb(null, row ? JSON.parse(row.sess) : null);
    } catch (e) { cb(e); }
  }

  set(sid, sess, cb) {
    try {
      const ttl = sess.cookie?.maxAge ?? 12 * 60 * 60 * 1000;
      const expiredAt = Date.now() + ttl;
      stmtUpsertSession.run(sid, JSON.stringify(sess), expiredAt);
      cb(null);
    } catch (e) { cb(e); }
  }

  destroy(sid, cb) {
    try {
      stmtDeleteSession.run(sid);
      cb(null);
    } catch (e) { cb(e); }
  }

  touch(sid, sess, cb) {
    this.set(sid, sess, cb);
  }
}

module.exports = SQLiteStore;
