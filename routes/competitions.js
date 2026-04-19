"use strict";

const express = require('express');
const router  = express.Router();
const db      = require('../db/db');

const VALID_WEAPONS = ['foil', 'epee', 'sabre'];
const VALID_GENDERS = ['M', 'F', 'X'];
const VALID_STATUSES = ['draft', 'active', 'finished'];

// ---------------------------------------------------------------------------
// POST /api/competitions/:id/finish — finish the competition, mark all active as finished
// ---------------------------------------------------------------------------
router.post('/:id/finish', (req, res) => {
  const compId = req.params.id;
  // Mark all active competitors as finished
  const active = db.prepare('SELECT id FROM competitors WHERE competition_id = ? AND status = ?').all(compId, 'active');
  let nextRank = 1;
  for (const f of active) {
    db.prepare('UPDATE competitors SET status = ?, final_rank = ? WHERE id = ?')
      .run('finished', nextRank, f.id);
    nextRank++;
  }
  db.prepare('UPDATE competitions SET status = ? WHERE id = ?').run('finished', compId);
  res.json({ finished: true, competitors: active.length });
});


// ---------------------------------------------------------------------------
// GET /api/competitions — list all competitions, newest first
// ---------------------------------------------------------------------------
router.get('/', (_req, res) => {
  const rows = db.prepare(`
    SELECT c.*,
           COUNT(DISTINCT co.id) AS competitor_count
    FROM   competitions c
    LEFT JOIN competitors co ON co.competition_id = c.id
    GROUP  BY c.id
    ORDER  BY c.created_at DESC
  `).all();
  res.json(rows);
});

// ---------------------------------------------------------------------------
// POST /api/competitions — create a competition
// ---------------------------------------------------------------------------
router.post('/', (req, res) => {
  const { name, weapon, gender } = req.body;

  if (!name || !name.trim())             return res.status(400).json({ error: 'name is required' });
  if (!VALID_WEAPONS.includes(weapon))   return res.status(400).json({ error: 'weapon must be foil, epee or sabre' });
  if (!VALID_GENDERS.includes(gender))   return res.status(400).json({ error: 'gender must be M, F or X' });

  const result = db.prepare(
    `INSERT INTO competitions (name, weapon, gender) VALUES (?, ?, ?)`
  ).run(name.trim(), weapon, gender);

  res.status(201).json({ id: result.lastInsertRowid });
});

// ---------------------------------------------------------------------------
// GET /api/competitions/:id — single competition with phases + competitor count
// ---------------------------------------------------------------------------
router.get('/:id', (req, res) => {
  const comp = db.prepare(`SELECT * FROM competitions WHERE id = ?`).get(req.params.id);
  if (!comp) return res.status(404).json({ error: 'Competition not found' });

  const phases = db.prepare(
    `SELECT * FROM phases WHERE competition_id = ? ORDER BY phase_order`
  ).all(comp.id);

  const count = db.prepare(
    `SELECT COUNT(*) AS n FROM competitors WHERE competition_id = ? AND status = 'active'`
  ).get(comp.id).n;

  res.json({ ...comp, phases, competitor_count: count });
});

// ---------------------------------------------------------------------------
// PATCH /api/competitions/:id — update status or name
// ---------------------------------------------------------------------------
router.patch('/:id', (req, res) => {
  const comp = db.prepare(`SELECT * FROM competitions WHERE id = ?`).get(req.params.id);
  if (!comp) return res.status(404).json({ error: 'Competition not found' });

  const { name, status } = req.body;

  if (status && !VALID_STATUSES.includes(status))
    return res.status(400).json({ error: 'Invalid status' });

  db.prepare(
    `UPDATE competitions SET name = ?, status = ? WHERE id = ?`
  ).run(name ?? comp.name, status ?? comp.status, comp.id);

  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// DELETE /api/competitions/:id — only allowed when draft
// ---------------------------------------------------------------------------
router.delete('/:id', (req, res) => {
  const comp = db.prepare(`SELECT * FROM competitions WHERE id = ?`).get(req.params.id);
  if (!comp) return res.status(404).json({ error: 'Competition not found' });
  if (comp.status !== 'draft' && comp.status !== 'finished') return res.status(409).json({ error: 'Only draft or finished competitions can be deleted' });

  db.prepare(`DELETE FROM competitions WHERE id = ?`).run(comp.id);
  res.json({ ok: true });
});

module.exports = router;
