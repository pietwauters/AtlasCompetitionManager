'use strict';
const express = require('express');
const Bout    = require('../services/bouts');
const SSE     = require('../lib/sse');

const router = express.Router();

// List bouts for a phase (used by de.html).
router.get('/', (req, res) => {
  const { phase_id } = req.query;
  if (!phase_id) return res.status(400).json({ error: 'phase_id query param required' });
  res.json(Bout.findByPhase(phase_id));
});

router.get('/:id', (req, res) => {
  const b = Bout.findById(req.params.id);
  if (!b) return res.status(404).json({ error: 'Bout not found' });
  res.json(b);
});

// Update scores.
// Body: { left_score, right_score, winner_id? }
router.patch('/:id', (req, res) => {
  const { left_score, right_score, winner_id } = req.body;
  try {
    const b = Bout.updateScore(req.params.id, left_score, right_score, winner_id);
    if (!b) return res.status(404).json({ error: 'Bout not found' });
    if (b.pool_id) SSE.emit(b.pool_id, 'bout-updated', b);
    res.json(b);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Undo the last score entry for this bout.
router.post('/:id/undo', (req, res) => {
  const b = Bout.undo(req.params.id);
  if (!b) return res.status(404).json({ error: 'Nothing to undo' });
  if (b.pool_id) SSE.emit(b.pool_id, 'bout-updated', b);
  res.json(b);
});

module.exports = router;
