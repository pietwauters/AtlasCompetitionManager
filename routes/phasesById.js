'use strict';
// Shortcut routes that access phases directly by ID without needing :compId.
// Used by phase.html and pool.html which only know the phase/pool ID.
const express = require('express');
const Phase   = require('../services/phases');
const Pool    = require('../services/pools');
const SSE     = require('../lib/sse');

const router = express.Router();

router.get('/:id/events', (req, res) => {
  SSE.subscribe(req.params.id, res);
});

router.get('/:id', (req, res) => {
  const p = Phase.findById(req.params.id);
  if (!p) return res.status(404).json({ error: 'Phase not found' });
  res.json(p);
});

router.get('/:id/rankings', (req, res) => {
  res.json(Phase.calculateRankings(req.params.id));
});

router.get('/:id/pools', (req, res) => {
  res.json(Pool.findByPhase(req.params.id));
});

router.post('/:id/activate', (req, res) => {
  try { res.json(Phase.activate(req.params.id)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/close', (req, res) => {
  try {
    const result = Phase.close(req.params.id, req.body?.method ? req.body : null);
    res.json(result);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/:id/simulate', (req, res) => {
  try {
    res.json(Phase.simulate(req.params.id));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/:id/reopen', (req, res) => {
  try {
    Phase.reopen(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

module.exports = router;
