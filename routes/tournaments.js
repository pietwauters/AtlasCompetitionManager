'use strict';
const express                = require('express');
const Tournament             = require('../services/tournaments');
const PoolRefereeAssignment  = require('../services/poolRefereeAssignment');

const router = express.Router();

router.get('/', (req, res) => {
  res.json(Tournament.findAll());
});

router.get('/:id', (req, res) => {
  const t = Tournament.findById(req.params.id);
  if (!t) return res.status(404).json({ error: 'Tournament not found' });
  res.json(t);
});

router.post('/', (req, res) => {
  try {
    const t = Tournament.create(req.body);
    res.status(201).json(t);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.patch('/:id', (req, res) => {
  const t = Tournament.update(req.params.id, req.body);
  if (!t) return res.status(404).json({ error: 'Tournament not found' });
  res.json(t);
});

router.delete('/:id', (req, res) => {
  const result = Tournament.delete(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Tournament not found' });
  res.json({ ok: true });
});

// Every pool phase in this tournament's competitions — candidates for the
// "combine competitions" referee auto-assignment below.
router.get('/:id/pool-phases', (req, res) => {
  res.json(PoolRefereeAssignment.listCombinablePoolPhases(req.params.id));
});

// Auto-assign referees across several pool phases at once — e.g. two
// competitions in this tournament whose pool rounds run at the same time,
// so they can draw from one combined referee pool instead of each
// competition solving its own roster in isolation.
// Body: { phase_ids: [id, id, ...] }
router.post('/:id/auto-assign-referees', (req, res) => {
  try {
    const phaseIds = req.body.phase_ids;
    if (!Array.isArray(phaseIds) || !phaseIds.length) {
      return res.status(400).json({ error: 'phase_ids must be a non-empty array' });
    }
    const owned = PoolRefereeAssignment.phasesOwnedByTournament(req.params.id, phaseIds);
    if (owned.length !== phaseIds.length) {
      return res.status(400).json({ error: 'One or more phases do not belong to this tournament' });
    }
    res.json(PoolRefereeAssignment.autoAssign(phaseIds));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

module.exports = router;
