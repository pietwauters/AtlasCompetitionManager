'use strict';
const express       = require('express');
const Person        = require('../services/people');
const Fencer        = require('../services/fencers');
const Referee       = require('../services/referees');
const PersonImport  = require('../services/personImport');
const Csv           = require('../services/csv');

const router = express.Router();

// ---------------------------------------------------------------------------
// Static paths first — must come before /:id to avoid being swallowed by it.
// ---------------------------------------------------------------------------

// Export fencers (or all people) as CSV.
// Query: ?role=fencer (default) | all
router.get('/export', (req, res) => {
  const role    = req.query.role || 'fencer';
  const records = role === 'fencer' ? Fencer.findAll() : Person.findAll();

  const columns = [
    { key: 'first_name',    header: 'first_name' },
    { key: 'last_name',     header: 'last_name' },
    { key: 'date_of_birth', header: 'date_of_birth' },
    { key: 'gender',        header: 'gender' },
    { key: 'nationality',   header: 'nationality' },
    { key: 'club_name',     header: 'club' },
    { key: 'licence',       header: 'licence' },
    { key: 'weapons_csv',   header: 'weapons' },
    { key: 'handedness',    header: 'handedness' },
    { key: 'ranking',       header: 'ranking' },
  ];

  // Serialize weapons array → comma-separated string for CSV compatibility
  const rows = records.map(r => ({
    ...r,
    weapons_csv: Array.isArray(r.weapons) ? r.weapons.join(',') : (r.weapons || ''),
  }));

  const date = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${role}s-${date}.csv"`);
  res.send(Csv.generate(rows, columns));
});

// Import fencers from CSV.
// Body: raw CSV text (Content-Type: text/plain or text/csv)
router.post('/import', (req, res) => {
  const csvText = typeof req.body === 'string' ? req.body : '';
  if (!csvText.trim()) return res.status(400).json({ error: 'CSV body is required' });
  try {
    const result = PersonImport.fromCsv(csvText);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// People CRUD
// ---------------------------------------------------------------------------

router.get('/', (req, res) => {
  const { search, role, club_id } = req.query;
  res.json(Person.findAll({ search, role, club_id }));
});

router.get('/:id', (req, res) => {
  const person = Person.findById(req.params.id);
  if (!person) return res.status(404).json({ error: 'Person not found' });
  res.json(person);
});

// Create a person. Body may include optional nested 'fencer' and 'referee' objects.
router.post('/', (req, res) => {
  try {
    const { fencer, referee, ...personFields } = req.body;
    const person = Person.create(personFields);

    if (fencer)  Fencer.create(person.id, fencer);
    if (referee) Referee.create(person.id, referee);

    res.status(201).json(Person.findById(person.id));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.patch('/:id', (req, res) => {
  const person = Person.update(req.params.id, req.body);
  if (!person) return res.status(404).json({ error: 'Person not found' });
  res.json(person);
});

router.delete('/:id', (req, res) => {
  const result = Person.delete(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Person not found' });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Fencer profile sub-resource  /api/people/:id/fencer
// ---------------------------------------------------------------------------

router.post('/:id/fencer', (req, res) => {
  try {
    const existing = Fencer.findByPersonId(req.params.id);
    const fencer = existing
      ? Fencer.update(existing.fencer_id, req.body)
      : Fencer.create(req.params.id, req.body);
    res.status(existing ? 200 : 201).json(fencer);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id/fencer', (req, res) => {
  const result = Fencer.deleteByPersonId(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Fencer profile not found' });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Referee profile sub-resource  /api/people/:id/referee
// ---------------------------------------------------------------------------

router.post('/:id/referee', (req, res) => {
  try {
    const existing = Referee.findByPersonId(req.params.id);
    const referee = existing
      ? Referee.update(existing.referee_id, req.body)
      : Referee.create(req.params.id, req.body);
    res.status(existing ? 200 : 201).json(referee);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id/referee', (req, res) => {
  const result = Referee.deleteByPersonId(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Referee profile not found' });
  res.json({ ok: true });
});

module.exports = router;
