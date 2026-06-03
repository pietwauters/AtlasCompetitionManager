'use strict';
const express = require('express');
const User    = require('../services/users');

const router = express.Router();

// POST /api/auth/login  { token, pin }
router.post('/login', (req, res) => {
  const { token, pin } = req.body;
  if (!token || !pin) return res.status(400).json({ error: 'token and pin required' });

  const user = User.findByToken(token);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  if (!User.verifyPin(user, pin)) return res.status(401).json({ error: 'Invalid credentials' });

  User.recordLogin(user.id);
  req.session.user = { id: user.id, role: user.role, username: user.username };

  res.json({
    ok:             true,
    role:           user.role,
    username:       user.username,
    forcePin:       user.force_pin_change === 1,
  });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// GET /api/auth/me  — current session info
router.get('/me', (req, res) => {
  if (!req.session.user) return res.json({ authenticated: false });
  res.json({ authenticated: true, ...req.session.user });
});

// POST /api/auth/change-pin  { currentPin, newPin }
router.post('/change-pin', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
  const { currentPin, newPin } = req.body;
  if (!currentPin || !newPin) return res.status(400).json({ error: 'currentPin and newPin required' });

  const user = User.findById(req.session.user.id);
  if (!User.verifyPin(user, currentPin)) return res.status(401).json({ error: 'Current PIN incorrect' });

  const pin = String(newPin);
  if (pin.length < 6 || !/^\d+$/.test(pin)) return res.status(400).json({ error: 'PIN must be at least 6 digits' });

  User.changePin(user.id, pin);
  res.json({ ok: true });
});

module.exports = router;
