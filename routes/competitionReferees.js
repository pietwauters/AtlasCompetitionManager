'use strict';
const express          = require('express');
const CompetitionReferee = require('../services/competitionReferees');

// mergeParams: true lets us access :compId from the parent route.
const router = express.Router({ mergeParams: true });

router.get('/', (req, res) => {
  res.json(CompetitionReferee.findAll(req.params.compId));
});

router.get('/eligible', (req, res) => {
  res.json(CompetitionReferee.findEligible(req.params.compId));
});

// Add multiple referees from the roster at once. Skips already-registered ones.
// Body: { referee_ids: [1, 2, 3] }
router.post('/bulk', (req, res) => {
  try {
    const added = CompetitionReferee.bulkAdd(req.params.compId, req.body.referee_ids || []);
    res.json({ added });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Rank the whole effective roster by referee.level (see lib/refereeLevel.js).
router.post('/auto-rank', (req, res) => {
  const ranked = CompetitionReferee.autoRankByLevel(req.params.compId);
  res.json({ ranked });
});

// Body: { direction: 'up' | 'down' }
router.post('/:refereeId/reorder', (req, res) => {
  const ok = CompetitionReferee.moveRank(req.params.compId, req.params.refereeId, req.body.direction);
  if (!ok) return res.status(400).json({ error: 'Cannot move further in that direction' });
  res.json({ ok: true });
});

router.delete('/:refereeId', (req, res) => {
  const result = CompetitionReferee.remove(req.params.compId, req.params.refereeId);
  if (!result.changes) return res.status(404).json({ error: 'Referee not registered on this competition' });
  res.json({ ok: true });
});

module.exports = router;
