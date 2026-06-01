'use strict';
const express = require('express');
const Bout    = require('../services/bouts');
const Event   = require('../services/events');
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

router.get('/:id/events', (req, res) => {
  const b = Bout.findById(req.params.id);
  if (!b) return res.status(404).json({ error: 'Bout not found' });
  res.json(Event.findByBout(req.params.id));
});

// Update scores.
// Body: { left_score, right_score, winner_id? }
router.patch('/:id', (req, res) => {
  const { left_score, right_score, winner_id } = req.body;
  try {
    const before = Bout.findById(req.params.id);
    if (!before) return res.status(404).json({ error: 'Bout not found' });
    const b = Bout.updateScore(req.params.id, left_score, right_score, winner_id);
    Event.record({
      competition_id: b.competition_id,
      phase_id:       b.phase_id,
      bout_id:        b.id,
      event_type:     'bout.score_override',
      actor:          'manual',
      payload: {
        before: { left_score: before.left_score, right_score: before.right_score, winner_id: before.winner_id },
        after:  { left_score: b.left_score,      right_score: b.right_score,      winner_id: b.winner_id },
      },
    });
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
