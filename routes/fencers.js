'use strict';

const express             = require('express');
const router              = express.Router({ mergeParams: true });   // inherits :compId from parent
const db                  = require('../db/db');
const { deriveCategory }  = require('../lib/categories');

// ---------------------------------------------------------------------------
// GET /api/competitions/:compId/fencers — list competitors in a competition
// ---------------------------------------------------------------------------
router.get('/', (req, res) => {
  const { compId } = req.params;
  if (!db.prepare(`SELECT 1 FROM competitions WHERE id = ?`).get(compId))
    return res.status(404).json({ error: 'Competition not found' });

  const compYear = new Date().getFullYear();
  const rows = db.prepare(`
    SELECT * FROM competitors
    WHERE  competition_id = ?
    ORDER  BY initial_seed ASC, name ASC
  `).all(compId).map(r => ({
    ...r,
    display_name: r.first_name ? `${r.first_name} ${r.last_name || ''}`.trim() : r.name,
    weapons: r.weapons ? JSON.parse(r.weapons) : [],
    category: deriveCategory(r.date_of_birth, compYear),
  }));

  res.json(rows);
});

// ---------------------------------------------------------------------------
// POST /api/competitions/:compId/fencers — add a single competitor
// ---------------------------------------------------------------------------
router.post('/', (req, res) => {
  const { compId } = req.params;
  if (!db.prepare(`SELECT 1 FROM competitions WHERE id = ?`).get(compId))
    return res.status(404).json({ error: 'Competition not found' });

  const { name, first_name, last_name, date_of_birth, gender, weapons,
          licence, handedness, national_ranking,
          club, nationality, initial_seed } = req.body;

  // Need at least a display name
  const resolvedName = name?.trim() || (first_name ? `${first_name} ${last_name || ''}`.trim() : '');
  if (!resolvedName) return res.status(400).json({ error: 'name or first_name is required' });

  if (nationality && !/^[A-Za-z]{3}$/.test(nationality))
    return res.status(400).json({ error: 'nationality must be a 3-letter NOC code' });

  if (gender && !['M','F'].includes(gender))
    return res.status(400).json({ error: 'gender must be M or F' });

  const weaponsJson = weapons ? JSON.stringify(
    (Array.isArray(weapons) ? weapons : [weapons]).map(w => w.toLowerCase())
  ) : null;

  const result = db.prepare(`
    INSERT INTO competitors
      (competition_id, name, first_name, last_name, date_of_birth, gender,
       weapons, licence, handedness, national_ranking, club, nationality, initial_seed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    Number(compId),
    resolvedName,
    first_name?.trim()  || null,
    last_name?.trim()   || null,
    date_of_birth       || null,
    gender              || null,
    weaponsJson,
    licence?.trim()     || null,
    handedness          || null,
    national_ranking != null ? Number(national_ranking) : null,
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
    INSERT INTO competitors
      (competition_id, name, first_name, last_name, date_of_birth, gender,
       weapons, licence, handedness, national_ranking, club, nationality, initial_seed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((rows) => {
    for (const f of rows) {
      const resolvedName = f.name?.trim() || (f.first_name ? `${f.first_name} ${f.last_name || ''}`.trim() : '');
      if (!resolvedName) continue;     // skip blank entries
      if (f.nationality && !/^[A-Za-z]{3}$/.test(f.nationality))
        throw Object.assign(new Error('Invalid NOC code: ' + f.nationality), { status: 400 });

      const weaponsJson = f.weapons ? JSON.stringify(
        (Array.isArray(f.weapons) ? f.weapons : [f.weapons]).map(w => w.toLowerCase())
      ) : null;

      insert.run(
        Number(compId),
        resolvedName,
        f.first_name?.trim()  || null,
        f.last_name?.trim()   || null,
        f.date_of_birth       || null,
        f.gender              || null,
        weaponsJson,
        f.licence?.trim()     || null,
        f.handedness          || null,
        f.national_ranking != null ? Number(f.national_ranking) : null,
        f.club?.trim()        || null,
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
// PATCH /api/competitions/:compId/fencers/bulk-status — set status on multiple fencers
// Body: { updates: [ { id, status }, ... ] }
// IMPORTANT: must be registered before PATCH /:id to avoid "bulk-status" being
// treated as an id parameter.
// ---------------------------------------------------------------------------
router.patch('/bulk-status', (req, res) => {
  const { compId } = req.params;
  if (!db.prepare(`SELECT 1 FROM competitions WHERE id = ?`).get(compId))
    return res.status(404).json({ error: 'Competition not found' });

  const VALID_STATUS = ['active', 'withdrawn', 'dns'];
  const { updates } = req.body;
  if (!Array.isArray(updates) || updates.length === 0)
    return res.status(400).json({ error: 'updates array is required' });

  const stmt = db.prepare(
    `UPDATE competitors SET status = ? WHERE id = ? AND competition_id = ?`
  );

  const run = db.transaction(() => {
    for (const u of updates) {
      if (!VALID_STATUS.includes(u.status))
        throw Object.assign(new Error('Invalid status: ' + u.status), { status: 400 });
      stmt.run(u.status, u.id, compId);
    }
  });

  try {
    run();
    res.json({ ok: true, count: updates.length });
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

  const { name, first_name, last_name, date_of_birth, gender, weapons,
          licence, handedness, national_ranking,
          club, nationality, initial_seed, status } = req.body;

  if (nationality && !/^[A-Za-z]{3}$/.test(nationality))
    return res.status(400).json({ error: 'nationality must be a 3-letter NOC code' });

  if (gender && !['M','F'].includes(gender))
    return res.status(400).json({ error: 'gender must be M or F' });

  const weaponsJson = weapons !== undefined
    ? JSON.stringify((Array.isArray(weapons) ? weapons : [weapons]).map(w => w.toLowerCase()))
    : row.weapons;

  // Recompute display name if first/last provided
  let resolvedName = row.name;
  if (first_name !== undefined || last_name !== undefined) {
    const fn = (first_name ?? row.first_name ?? '').trim();
    const ln = (last_name  ?? row.last_name  ?? '').trim();
    resolvedName = fn ? `${fn} ${ln}`.trim() : row.name;
  } else if (name !== undefined) {
    resolvedName = name.trim() || row.name;
  }

  db.prepare(`
    UPDATE competitors
    SET    name = ?, first_name = ?, last_name = ?, date_of_birth = ?, gender = ?,
           weapons = ?, licence = ?, handedness = ?, national_ranking = ?,
           club = ?, nationality = ?, initial_seed = ?, status = ?
    WHERE  id = ?
  `).run(
    resolvedName,
    first_name?.trim()  ?? row.first_name,
    last_name?.trim()   ?? row.last_name,
    date_of_birth       ?? row.date_of_birth,
    gender              ?? row.gender,
    weaponsJson,
    licence?.trim()     ?? row.licence,
    handedness          ?? row.handedness,
    national_ranking != null ? Number(national_ranking) : row.national_ranking,
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
