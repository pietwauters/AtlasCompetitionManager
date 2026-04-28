'use strict';

const express             = require('express');
const router              = express.Router({ mergeParams: true });   // inherits :compId from parent
const models              = require('../models');
const { deriveCategory }  = require('../lib/categories');

// ---------------------------------------------------------------------------
// GET /api/competitions/:compId/fencers — list competitors in a competition
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  const { compId } = req.params;
  // TODO: Check competition existence with Sequelize if needed
  try {
    const { compId } = req.params;
    const entries = await models.CompetitionFencer.findAll({
      where: { competitionId: compId },
      include: [{
        model: models.Fencer,
        include: [{
          model: models.Person,
          include: [models.Club, models.NOC]
        }]
      }],
      order: [[models.Fencer, models.Person, 'lastName', 'ASC']]
    });
    const compYear = new Date().getFullYear();
    const rows = entries.map(entry => {
      const f = entry.Fencer;
      const p = f.Person;
      return {
        id: entry.id,
        fencerId: f.id,
        personId: p.id,
        name: p.firstName ? `${p.firstName} ${p.lastName || ''}`.trim() : '',
        first_name: p.firstName,
        last_name: p.lastName,
        date_of_birth: p.birthdate,
        club: p.Club ? p.Club.name : null,
        nationality: p.nationality,
        nationality_name: p.NOC ? p.NOC.country : null,
        global_ranking: f.ranking,
        weapons: f.weapons,
        gender: p.gender,
        licence: f.licence,
        handedness: f.handedness,
        // Competition-specific fields:
        seed: entry.seed,
        status: entry.status,
        state: entry.state,
        final_rank: entry.final_rank,
        display_name: p.firstName ? `${p.firstName} ${p.lastName || ''}`.trim() : '',
        category: deriveCategory(p.birthdate, compYear)
      };
    });
    console.log(`[DEBUG] GET /api/competitions/${compId}/fencers -> ${rows.length} rows`, rows);
    res.json(rows);
  } catch (e) {
    console.error('[ERROR] GET /api/competitions/:compId/fencers', e);
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/competitions/:compId/fencers — add a single competitor
// ---------------------------------------------------------------------------
router.post('/', async (req, res) => {
  const { compId } = req.params;
  const { name, first_name, last_name, date_of_birth, gender, weapons,
    licence, handedness, national_ranking,
    club, nationality, initial_seed } = req.body;

  // Parse first_name and last_name from name if not provided
  let fn = first_name, ln = last_name;
  if (!fn && name) {
    const parts = name.trim().split(/\s+/);
    fn = parts[0] || '';
    ln = parts.slice(1).join(' ') || '';
  }
  const resolvedName = name?.trim() || (fn ? `${fn} ${ln || ''}`.trim() : '');
  if (!resolvedName) return res.status(400).json({ error: 'name or first_name is required' });
  if (nationality && !/^[A-Za-z]{3}$/.test(nationality))
    return res.status(400).json({ error: 'nationality must be a 3-letter NOC code' });
  if (gender && !['M','F'].includes(gender))
    return res.status(400).json({ error: 'gender must be M or F' });

  try {
    // Find or create club
    let clubInstance = null;
    if (club) {
      [clubInstance] = await models.Club.findOrCreate({ where: { name: club.trim() } });
    }
    // Find or create person
    let person = await models.Person.findOne({ where: { firstName: fn, lastName: ln } });
    if (!person) {
      person = await models.Person.create({
        firstName: fn,
        lastName: ln,
        birthdate: date_of_birth,
        clubId: clubInstance ? clubInstance.id : null,
        nationality: nationality?.toUpperCase() || null
      });
    }
    // Find or create fencer (global profile)
    let fencer = await models.Fencer.findOne({ where: { personId: person.id } });
    if (!fencer) {
      fencer = await models.Fencer.create({
        personId: person.id,
        ranking: national_ranking != null ? Number(national_ranking) : null,
        weapons: weapons ? JSON.stringify(Array.isArray(weapons) ? weapons : [weapons]) : null,
        licence: licence || null,
        handedness: handedness || null
      });
    }
    // Register fencer for this competition
    const entry = await models.CompetitionFencer.create({
      competitionId: compId,
      fencerId: fencer.id,
      seed: initial_seed != null ? Number(initial_seed) : null,
      status: 'registered',
      state: null,
      final_rank: null
    });
    res.status(201).json({ id: entry.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/competitions/:compId/fencers/bulk — add multiple competitors at once
// Body: { fencers: [ {name, club, nationality, initial_seed}, ... ] }
// Useful for CSV import pre-processing on the client side
// ---------------------------------------------------------------------------
router.post('/bulk', async (req, res) => {
  const { fencers } = req.body;
  if (!Array.isArray(fencers) || fencers.length === 0)
    return res.status(400).json({ error: 'fencers array is required' });
  let count = 0;
  try {
    const { compId } = req.params;
    for (const f of fencers) {
      const resolvedName = f.name?.trim() || (f.first_name ? `${f.first_name} ${f.last_name || ''}`.trim() : '');
      if (!resolvedName) continue;
      if (f.nationality && !/^[A-Za-z]{3}$/.test(f.nationality)) continue;
      let clubInstance = null;
      if (f.club) {
        [clubInstance] = await models.Club.findOrCreate({ where: { name: f.club.trim() } });
      }
      // Always uppercase nationality if present
      const nationality = f.nationality ? f.nationality.toUpperCase() : null;
      // Find or create person
      let person = await models.Person.findOne({ where: { firstName: f.first_name, lastName: f.last_name } });
      if (!person) {
        person = await models.Person.create({
          firstName: f.first_name,
          lastName: f.last_name,
          birthdate: f.date_of_birth,
          clubId: clubInstance ? clubInstance.id : null,
          nationality,
          gender: f.gender || null
        });
      } else {
        // Update nationality or gender if missing or different
        let changed = false;
        if (nationality && person.nationality !== nationality) {
          person.nationality = nationality;
          changed = true;
        }
        if (f.gender && person.gender !== f.gender) {
          person.gender = f.gender;
          changed = true;
        }
        if (changed) await person.save();
      }
      // Find or create fencer (global profile)
      let fencer = await models.Fencer.findOne({ where: { personId: person.id } });
      if (!fencer) {
        fencer = await models.Fencer.create({
          personId: person.id,
          ranking: f.national_ranking != null ? Number(f.national_ranking) : null,
          weapons: f.weapons ? JSON.stringify(Array.isArray(f.weapons) ? f.weapons : [f.weapons]) : null,
          licence: f.licence || null,
          handedness: f.handledness || null
        });
      } else {
        // Update weapons if provided
        if (f.weapons) {
          fencer.weapons = JSON.stringify(Array.isArray(f.weapons) ? f.weapons : [f.weapons]);
          await fencer.save();
        }
      }
      // Register fencer for this competition
      await models.CompetitionFencer.create({
        competitionId: compId,
        fencerId: fencer.id,
        seed: f.initial_seed != null ? Number(f.initial_seed) : null,
        status: f.status || 'registered',
        state: null,
        final_rank: f.final_rank != null ? Number(f.final_rank) : null
      });
      count++;
    }
    res.json({ ok: true, count });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/competitions/:compId/fencers/bulk-status — set status on multiple fencers
// Body: { updates: [ { id, status }, ... ] }
// IMPORTANT: must be registered before PATCH /:id to avoid "bulk-status" being
// treated as an id parameter.
// ---------------------------------------------------------------------------
router.patch('/bulk-status', async (req, res) => {
  const VALID_STATUS = ['active', 'withdrawn', 'dns'];
  const { updates } = req.body;
  if (!Array.isArray(updates) || updates.length === 0)
    return res.status(400).json({ error: 'updates array is required' });
  try {
    const { compId } = req.params;
    let updated = 0;
    for (const u of updates) {
      if (!VALID_STATUS.includes(u.status)) continue;
      // Update CompetitionFencer status for this competition and fencer
      const [count] = await models.CompetitionFencer.update(
        { status: u.status },
        { where: { competitionId: compId, fencerId: u.id } }
      );
      if (count > 0) updated++;
    }
    res.json({ ok: true, count: updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/competitions/:compId/fencers/:id — update a competitor
// ---------------------------------------------------------------------------
router.patch('/:id', async (req, res) => {
  const { id } = req.params;
  const { first_name, last_name, date_of_birth, club, nationality, national_ranking, status } = req.body;
  try {
    const fencer = await models.Fencer.findByPk(id, { include: [models.Person] });
    if (!fencer) return res.status(404).json({ error: 'Fencer not found' });
    // Update person fields
    let clubInstance = null;
    if (club) {
      [clubInstance] = await models.Club.findOrCreate({ where: { name: club.trim() } });
    }
    await fencer.Person.update({
      firstName: first_name ?? fencer.Person.firstName,
      lastName: last_name ?? fencer.Person.lastName,
      birthdate: date_of_birth ?? fencer.Person.birthdate,
      clubId: clubInstance ? clubInstance.id : fencer.Person.clubId,
      nationality: nationality?.toUpperCase() ?? fencer.Person.nationality
    });
    // Update fencer fields
    await fencer.update({
      ranking: national_ranking != null ? Number(national_ranking) : fencer.ranking
    });
    // If status is provided, update CompetitionFencer for this competition
    if (status) {
      const { compId } = req.params;
      await models.CompetitionFencer.update(
        { status },
        { where: { competitionId: compId, fencerId: fencer.id } }
      );
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const fencer = await models.Fencer.findByPk(id);
    if (!fencer) return res.status(404).json({ error: 'Fencer not found' });
    await fencer.destroy();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
