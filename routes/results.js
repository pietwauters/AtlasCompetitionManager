const express = require('express');
const db = require('../db/db');

const router = express.Router({ mergeParams: true });

// GET /api/competitions/:compId/results
router.get('/', async (req, res) => {
  const compId = req.params.compId;
  // Get all fencers for this competition, with elimination info if available
  const fencers = await req.app.get('models').Competitor.findAll({
    where: { competition_id: compId },
    order: [
      [req.app.get('models').sequelize.literal('final_rank IS NULL'), 'ASC'],
      ['final_rank', 'ASC'],
      ['name', 'ASC']
    ]
  });
  // Map status to display string as in legacy
  const mapped = fencers.map(c => ({
    id: c.id,
    name: c.name,
    club: c.club,
    rank: c.final_rank,
    status: c.status === 'finished' ? 'Finished' : (c.status === 'active' ? 'Active' : 'Eliminated'),
    eliminated_after: c.eliminated_after
  }));
  res.json(mapped);
});

module.exports = router;
