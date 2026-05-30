'use strict';
const express = require('express');
const Bout    = require('../services/bouts');

const router = express.Router();

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
    res.json(b);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Undo the last score entry for this bout.
router.post('/:id/undo', (req, res) => {
  const b = Bout.undo(req.params.id);
  if (!b) return res.status(404).json({ error: 'Nothing to undo' });
  res.json(b);
});

module.exports = router;
