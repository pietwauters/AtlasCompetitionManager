const express = require('express');
const db = require('../db/db');

const router = express.Router({ mergeParams: true });

// GET /api/competitions/:compId/results
router.get('/', (req, res) => {
  const compId = req.params.compId;
  // Get all fencers for this competition, with elimination info if available
  const fencers = db.prepare(`
    SELECT c.id, c.name, c.club,
           c.final_rank AS rank,
           CASE 
             WHEN c.status = 'finished' THEN 'Finished'
             WHEN c.status = 'active' THEN 'Active'
             ELSE 'Eliminated'
           END AS status,
           c.eliminated_after
      FROM competitors c
     WHERE c.competition_id = ?
     ORDER BY c.final_rank IS NULL, c.final_rank ASC, c.name ASC
  `).all(compId);
  res.json(fencers);
});

module.exports = router;
