'use strict';
const express = require('express');
const os      = require('os');
const QRCode  = require('qrcode');
const User    = require('../services/users');

function serverBaseUrl(req) {
  const port = process.env.PORT || 3001;
  const ifaces = os.networkInterfaces();
  for (const addrs of Object.values(ifaces)) {
    for (const a of addrs) {
      if (a.family === 'IPv4' && !a.internal) return `http://${a.address}:${port}`;
    }
  }
  return `${req.protocol}://${req.hostname}:${port}`;
}

const router = express.Router();

router.get('/', (_req, res) => {
  res.json(User.findAll());
});

router.post('/', (req, res) => {
  const { username, role, person_id } = req.body;
  if (!username || !role) return res.status(400).json({ error: 'username and role required' });
  try {
    const { user, plainPin } = User.create({ username, role, person_id });
    res.status(201).json({ user, plainPin });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/users/:id/reset-pin  — admin resets a user's PIN
router.post('/:id/reset-pin', (req, res) => {
  const plainPin = User.resetPin(req.params.id);
  if (!plainPin) return res.status(404).json({ error: 'User not found' });
  res.json({ plainPin });
});

router.get('/:id/qr', (req, res) => {
  const u = User.findById(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  const url = `${serverBaseUrl(req)}/login.html?u=${encodeURIComponent(u.user_token)}`;
  QRCode.toBuffer(url, { width: 200, margin: 2 }, (err, buf) => {
    if (err) return res.status(500).json({ error: 'QR generation failed' });
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'no-store');
    res.send(buf);
  });
});

router.delete('/:id', (req, res) => {
  const result = User.delete(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'User not found' });
  res.json({ ok: true });
});

module.exports = router;
