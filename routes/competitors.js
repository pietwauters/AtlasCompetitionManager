'use strict';
const express    = require('express');
const Competitor = require('../services/competitors');

// mergeParams: true lets us access :compId from the parent route.
const router = express.Router({ mergeParams: true });

router.get('/', (req, res) => {
  res.json(Competitor.findAll(req.params.compId));
});

// Add one person from the local roster to the competition.
// Body: { person_id, initial_seed? }
router.post('/', (req, res) => {
  try {
    const c = Competitor.add(req.params.compId, req.body.person_id, req.body.initial_seed ?? null);
    res.status(201).json(c);
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

// Add multiple people from the roster at once. Skips already-registered people.
// Body: { person_ids: [1, 2, 3] }
router.post('/bulk', (req, res) => {
  try {
    const added = Competitor.bulkAdd(req.params.compId, req.body.person_ids || []);
    res.json({ added });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Assign seeds by fencer ranking (ranked first, unranked last).
router.post('/auto-seed', (req, res) => {
  const count = Competitor.autoSeed(req.params.compId);
  res.json({ seeded: count });
});

router.patch('/:cid', (req, res) => {
  const c = Competitor.update(req.params.cid, req.body);
  if (!c) return res.status(404).json({ error: 'Competitor not found' });
  res.json(c);
});

router.delete('/:cid', (req, res) => {
  const result = Competitor.remove(req.params.cid);
  if (!result.changes) return res.status(404).json({ error: 'Competitor not found' });
  res.json({ ok: true });
});

module.exports = router;
