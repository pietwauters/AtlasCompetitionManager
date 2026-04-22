"use strict";

const express = require('express');
const router  = express.Router();
const db      = require('../db/db');

// ---------------------------------------------------------------------------
// GET /api/tournaments — list all tournaments
// ---------------------------------------------------------------------------
router.get('/', (_req, res) => {
  const rows = db.prepare(`
    SELECT * FROM tournaments
    ORDER BY date_start DESC, id DESC
  `).all();
  res.json(rows);
});

// ---------------------------------------------------------------------------
// POST /api/tournaments — create a tournament
// ---------------------------------------------------------------------------
router.post('/', (req, res) => {
  const { name, city, country, date_start, date_end, organizer, description, level, status } = req.body;
  if (!name || !city || !country) return res.status(400).json({ error: 'name, city, country required' });
  try {
    const result = db.prepare(
      `INSERT INTO tournaments (name, city, country, date_start, date_end, organizer, description, level, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(name, city, country, date_start, date_end, organizer, description, level, status ?? 'open');
    res.status(201).json({ id: result.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/tournaments/:id — get tournament detail
// ---------------------------------------------------------------------------
router.get('/:id', (req, res) => {
  const t = db.prepare(`SELECT * FROM tournaments WHERE id = ?`).get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Tournament not found' });
  // List competitions for this tournament
  const competitions = db.prepare(`SELECT * FROM competitions WHERE tournament_id = ?`).all(t.id);
  res.json({ ...t, competitions });
});

// ---------------------------------------------------------------------------
// PATCH /api/tournaments/:id — update tournament
// ---------------------------------------------------------------------------
router.patch('/:id', (req, res) => {
  const t = db.prepare(`SELECT * FROM tournaments WHERE id = ?`).get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Tournament not found' });
  const { name, city, country, date_start, date_end, organizer, description, level, status, archived } = req.body;
  db.prepare(`
    UPDATE tournaments SET
      name = ?, city = ?, country = ?, date_start = ?, date_end = ?,
      organizer = ?, description = ?, level = ?, status = ?, archived = ?
    WHERE id = ?
  `).run(
    name ?? t.name, city ?? t.city, country ?? t.country, date_start ?? t.date_start, date_end ?? t.date_end,
    organizer ?? t.organizer, description ?? t.description, level ?? t.level, status ?? t.status, archived ?? t.archived, t.id
  );
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// DELETE /api/tournaments/:id — delete tournament
// ---------------------------------------------------------------------------
router.delete('/:id', (req, res) => {
  const t = db.prepare(`SELECT * FROM tournaments WHERE id = ?`).get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Tournament not found' });
  const competitions = db.prepare(`SELECT id FROM competitions WHERE tournament_id = ?`).all(t.id);
  if (competitions.length > 0) {
    // Check for explicit delete_competitions flag
    const deleteComps = req.query.delete_competitions === 'true' || req.body?.delete_competitions === true;
    if (!deleteComps) {
      return res.status(409).json({ error: 'Tournament has linked competitions', competitions: competitions.map(c => c.id) });
    }
    // Delete all competitions for this tournament
    db.prepare(`DELETE FROM competitions WHERE tournament_id = ?`).run(t.id);
  }
  db.prepare(`DELETE FROM tournaments WHERE id = ?`).run(t.id);
  res.json({ ok: true });
});

module.exports = router;
