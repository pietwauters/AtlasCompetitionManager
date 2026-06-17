'use strict';
const express  = require('express');
const router   = express.Router();
const Settings = require('../services/settings');

const ALLOWED_KEYS = ['tie_break_method', 'manual_tie_break'];

router.get('/', (req, res) => {
  const result = {};
  for (const key of ALLOWED_KEYS) result[key] = Settings.get(key) || null;
  res.json(result);
});

router.put('/', (req, res) => {
  for (const key of ALLOWED_KEYS) {
    if (req.body[key] !== undefined) Settings.set(key, req.body[key]);
  }
  res.json({ ok: true });
});

// Tie-break order for a specific phase: flat array of competitor_ids in desired position order.
router.get('/tie-order/:phaseId', (req, res) => {
  const raw = Settings.get('tie_order_' + req.params.phaseId);
  res.json(raw ? JSON.parse(raw) : null);
});

router.put('/tie-order/:phaseId', (req, res) => {
  if (!Array.isArray(req.body)) return res.status(400).json({ error: 'Expected array' });
  Settings.set('tie_order_' + req.params.phaseId, JSON.stringify(req.body));
  res.json({ ok: true });
});

router.delete('/tie-order/:phaseId', (req, res) => {
  Settings.delete('tie_order_' + req.params.phaseId);
  res.json({ ok: true });
});

module.exports = router;
