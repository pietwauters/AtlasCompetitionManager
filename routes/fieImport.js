'use strict';
const express   = require('express');
const FieImport = require('../services/fieImport');

const router = express.Router();

// POST /api/fie/import
// Body: { xml: string, tournament_id?: number }
// Content-Type: application/json
//
// Accepts a FIE XML string and imports it into Atlas.
// Currently supports BaseCompetitionIndividuelle (fencers file).
// Returns { tournament_id, competition_id, created, updated, skipped, warnings }.
router.post('/import', (req, res) => {
  const xml          = req.body?.xml;
  const tournamentId = req.body?.tournament_id ? Number(req.body.tournament_id) : null;

  if (!xml || typeof xml !== 'string') {
    return res.status(400).json({ error: 'Body must include an "xml" string.' });
  }

  try {
    const result = FieImport.importXml(xml, tournamentId);
    res.status(200).json(result);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

module.exports = router;
