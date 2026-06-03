'use strict';
const express = require('express');
const User    = require('../services/users');

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

router.delete('/:id', (req, res) => {
  const result = User.delete(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'User not found' });
  res.json({ ok: true });
});

module.exports = router;
