'use strict';
const db      = require('../db');
const bcrypt  = require('bcryptjs');
const crypto  = require('crypto');

const BCRYPT_ROUNDS = 10;

function generateToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function generatePin() {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6 digits
}

const User = {
  findById(id) {
    return db.prepare(`
      SELECT u.*, p.first_name, p.last_name
      FROM users u
      LEFT JOIN people p ON p.id = u.person_id
      WHERE u.id = ?
    `).get(id);
  },

  findByToken(token) {
    return db.prepare(`
      SELECT u.*, p.first_name, p.last_name
      FROM users u
      LEFT JOIN people p ON p.id = u.person_id
      WHERE u.user_token = ?
    `).get(token);
  },

  findByUsername(username) {
    return db.prepare(`
      SELECT u.*, p.first_name, p.last_name
      FROM users u
      LEFT JOIN people p ON p.id = u.person_id
      WHERE u.username = ?
    `).get(username);
  },

  findAll() {
    return db.prepare(`
      SELECT u.id, u.person_id, u.role, u.username, u.user_token,
             u.force_pin_change, u.created_at, u.last_login_at,
             p.first_name, p.last_name
      FROM users u
      LEFT JOIN people p ON p.id = u.person_id
      ORDER BY u.role, u.username
    `).all();
  },

  // Creates a user and returns { user, plainPin } — plainPin shown once, never stored.
  create({ username, role, person_id = null }) {
    const token    = generateToken();
    const plainPin = generatePin();
    const pinHash  = bcrypt.hashSync(plainPin, BCRYPT_ROUNDS);
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO users (username, role, person_id, user_token, pin_hash, force_pin_change)
      VALUES (@username, @role, @person_id, @token, @pinHash, 1)
    `).run({ username, role, person_id: person_id || null, token, pinHash });
    return { user: this.findById(lastInsertRowid), plainPin };
  },

  // Resets PIN — returns new plain PIN shown once.
  resetPin(id) {
    const plainPin = generatePin();
    const pinHash  = bcrypt.hashSync(plainPin, BCRYPT_ROUNDS);
    db.prepare(`
      UPDATE users SET pin_hash = @pinHash, force_pin_change = 1 WHERE id = @id
    `).run({ pinHash, id });
    return plainPin;
  },

  // Changes PIN (user-initiated — clears force_pin_change).
  changePin(id, newPin) {
    const pinHash = bcrypt.hashSync(String(newPin), BCRYPT_ROUNDS);
    db.prepare(`
      UPDATE users SET pin_hash = @pinHash, force_pin_change = 0 WHERE id = @id
    `).run({ pinHash, id });
  },

  verifyPin(user, pin) {
    if (!user.pin_hash) return false;
    return bcrypt.compareSync(String(pin), user.pin_hash);
  },

  recordLogin(id) {
    db.prepare(`UPDATE users SET last_login_at = datetime('now') WHERE id = ?`).run(id);
  },

  delete(id) {
    return db.prepare('DELETE FROM users WHERE id = ?').run(id);
  },

  // Ensure view_token is set on a person record; generate if missing.
  ensureViewToken(personId) {
    const row = db.prepare('SELECT view_token FROM people WHERE id = ?').get(personId);
    if (row?.view_token) return row.view_token;
    const token = generateToken();
    db.prepare('UPDATE people SET view_token = ? WHERE id = ?').run(token, personId);
    return token;
  },
};

module.exports = User;
