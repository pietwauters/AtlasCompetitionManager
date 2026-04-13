'use strict';

const express = require('express');
const router  = express.Router({ mergeParams: true });   // inherits :compId from parent
const db      = require('../db/db');

// ---------------------------------------------------------------------------
// GET /api/competitions/:compId/fencers — list competitors in a competition
// ---------------------------------------------------------------------------
router.get('/', (req, res) => {
  const { compId } = req.params;
  if (!db.prepare(`SELECT 1 FROM competitions WHERE id = ?`).get(compId))
    return res.status(404).json({ error: 'Competition not found' });

  const rows = db.prepare(`
    SELECT * FROM competitors
    WHERE  competition_id = ?
    ORDER  BY initial_seed ASC, name ASC
  `).all(compId);

  res.json(rows);
});

// ---------------------------------------------------------------------------
// POST /api/competitions/:compId/fencers — add a single competitor
// ---------------------------------------------------------------------------
router.post('/', (req, res) => {
  const { compId } = req.params;
  if (!db.prepare(`SELECT 1 FROM competitions WHERE id = ?`).get(compId))
    return res.status(404).json({ error: 'Competition not found' });

  const { name, club, nationality, initial_seed } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });

  // Validate 3-letter NOC code if provided
  if (nationality && !/^[A-Za-z]{3}$/.test(nationality))
    return res.status(400).json({ error: 'nationality must be a 3-letter NOC code' });

  const result = db.prepare(`
    INSERT INTO competitors (competition_id, name, club, nationality, initial_seed)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    Number(compId),
    name.trim(),
    club?.trim()        || null,
    nationality?.toUpperCase() || null,
    initial_seed != null ? Number(initial_seed) : null
  );

  res.status(201).json({ id: result.lastInsertRowid });
});

// ---------------------------------------------------------------------------
// POST /api/competitions/:compId/fencers/bulk — add multiple competitors at once
// Body: { fencers: [ {name, club, nationality, initial_seed}, ... ] }
// Useful for CSV import pre-processing on the client side
// ---------------------------------------------------------------------------
router.post('/bulk', (req, res) => {
  const { compId } = req.params;
  if (!db.prepare(`SELECT 1 FROM competitions WHERE id = ?`).get(compId))
    return res.status(404).json({ error: 'Competition not found' });

  const { fencers } = req.body;
  if (!Array.isArray(fencers) || fencers.length === 0)
    return res.status(400).json({ error: 'fencers array is required' });

  const insert = db.prepare(`
    INSERT INTO competitors (competition_id, name, club, nationality, initial_seed)
    VALUES (?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((rows) => {
    for (const f of rows) {
      if (!f.name?.trim()) continue;     // skip blank entries
      if (f.nationality && !/^[A-Za-z]{3}$/.test(f.nationality))
        throw Object.assign(new Error('Invalid NOC code: ' + f.nationality), { status: 400 });

      insert.run(
        Number(compId),
        f.name.trim(),
        f.club?.trim()              || null,
        f.nationality?.toUpperCase() || null,
        f.initial_seed != null ? Number(f.initial_seed) : null
      );
    }
  });

  try {
    insertMany(fencers);
    res.json({ ok: true, count: fencers.length });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/competitions/:compId/fencers/:id — update a competitor
// ---------------------------------------------------------------------------
router.patch('/:id', (req, res) => {
  const { compId, id } = req.params;
  const row = db.prepare(
    `SELECT * FROM competitors WHERE id = ? AND competition_id = ?`
  ).get(id, compId);
  if (!row) return res.status(404).json({ error: 'Competitor not found' });

  const { name, club, nationality, initial_seed, status } = req.body;

  if (nationality && !/^[A-Za-z]{3}$/.test(nationality))
    return res.status(400).json({ error: 'nationality must be a 3-letter NOC code' });

  db.prepare(`
    UPDATE competitors
    SET    name = ?, club = ?, nationality = ?, initial_seed = ?, status = ?
    WHERE  id = ?
  `).run(
    name?.trim()        ?? row.name,
    club?.trim()        ?? row.club,
    nationality?.toUpperCase() ?? row.nationality,
    initial_seed != null ? Number(initial_seed) : row.initial_seed,
    status              ?? row.status,
    row.id
  );

  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// GET /api/competitions/:compId/fencers/export.csv — download fencer list as CSV
// ---------------------------------------------------------------------------
router.get('/export.csv', (req, res) => {
  const { compId } = req.params;
  const comp = db.prepare('SELECT name FROM competitions WHERE id = ?').get(compId);
  if (!comp) return res.status(404).json({ error: 'Competition not found' });

  const rows = db.prepare(`
    SELECT initial_seed, name, club, nationality, status
    FROM   competitors
    WHERE  competition_id = ?
    ORDER  BY initial_seed ASC, name ASC
  `).all(compId);

  const escape = v => (v == null ? '' : '"' + String(v).replace(/"/g, '""') + '"');
  const header = 'initial_seed,name,club,nationality,status';
  const lines  = rows.map(r => [r.initial_seed ?? '', escape(r.name), escape(r.club), escape(r.nationality), r.status].join(','));
  const csv    = [header, ...lines].join('\r\n');

  const filename = comp.name.replace(/[^a-z0-9_-]/gi, '_') + '_fencers.csv';
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
});

// ---------------------------------------------------------------------------
// DELETE /api/competitions/:compId/fencers/:id — remove a competitor
// ---------------------------------------------------------------------------
router.delete('/:id', (req, res) => {
  const { compId, id } = req.params;
  const row = db.prepare(
    `SELECT * FROM competitors WHERE id = ? AND competition_id = ?`
  ).get(id, compId);
  if (!row) return res.status(404).json({ error: 'Competitor not found' });

  db.prepare(`DELETE FROM competitors WHERE id = ?`).run(row.id);
  res.json({ ok: true });
});

module.exports = router;
