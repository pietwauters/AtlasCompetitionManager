'use strict';
const express          = require('express');
const TournamentReferee = require('../services/tournamentReferees');

// mergeParams: true lets us access :tid from the parent route.
const router = express.Router({ mergeParams: true });

router.get('/', (req, res) => {
  res.json(TournamentReferee.findAll(req.params.tid));
});

router.get('/eligible', (req, res) => {
  res.json(TournamentReferee.findEligible(req.params.tid));
});

// Add multiple referees from the roster at once. Skips already-registered ones.
// Body: { referee_ids: [1, 2, 3] }
router.post('/bulk', (req, res) => {
  try {
    const added = TournamentReferee.bulkAdd(req.params.tid, req.body.referee_ids || []);
    res.json({ added });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Rank the whole roster by referee.level (see lib/refereeLevel.js).
router.post('/auto-rank', (req, res) => {
  const ranked = TournamentReferee.autoRankByLevel(req.params.tid);
  res.json({ ranked });
});

// Body: { direction: 'up' | 'down' }
router.post('/:refereeId/reorder', (req, res) => {
  const ok = TournamentReferee.moveRank(req.params.tid, req.params.refereeId, req.body.direction);
  if (!ok) return res.status(400).json({ error: 'Cannot move further in that direction' });
  res.json({ ok: true });
});

router.delete('/:refereeId', (req, res) => {
  const result = TournamentReferee.remove(req.params.tid, req.params.refereeId);
  if (!result.changes) return res.status(404).json({ error: 'Referee not registered on this tournament' });
  res.json({ ok: true });
});

module.exports = router;
