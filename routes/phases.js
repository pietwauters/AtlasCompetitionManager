'use strict';

const express        = require('express');
const path           = require('path');
const fs             = require('fs');
const db             = require('../db/db');
const { formPools, calcPoolOptions } = require('../lib/poolFormation');

const router = express.Router({ mergeParams: true });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Safely resolve a rule filename, preventing path traversal. */
function resolveRulePath(filename) {
  const rulesDir = path.join(__dirname, '..', 'rules');
  const safe     = path.basename(filename);            // strip any ../ components
  return path.join(rulesDir, safe);
}

function loadRule(filename) {
  const rulePath = resolveRulePath(filename);
  if (!fs.existsSync(rulePath)) throw Object.assign(new Error(`Rule file not found: ${filename}`), { status: 400 });
  return JSON.parse(fs.readFileSync(rulePath, 'utf8'));
}

// ---------------------------------------------------------------------------
// GET /api/competitions/:compId/phases  — list phases
// ---------------------------------------------------------------------------
router.get('/', (req, res) => {
  const { compId } = req.params;
  const phases = db.prepare(`
    SELECT p.*,
           (SELECT COUNT(*) FROM pools WHERE phase_id = p.id) AS pool_count
    FROM   phases p
    WHERE  p.competition_id = ?
    ORDER  BY p.phase_order
  `).all(compId);
  res.json(phases);
});

// ---------------------------------------------------------------------------
// POST /api/competitions/:compId/phases  — create a phase
// Body: { rule_doc, phase_order? }
// ---------------------------------------------------------------------------
router.post('/', (req, res) => {
  const { compId } = req.params;
  const { rule_doc, phase_order } = req.body;

  if (!rule_doc) return res.status(400).json({ error: 'rule_doc is required.' });

  let ruleJson;
  try { ruleJson = loadRule(rule_doc); } catch (e) { return res.status(e.status || 500).json({ error: e.message }); }

  const order = phase_order ?? (() => {
    const row = db.prepare('SELECT COALESCE(MAX(phase_order), 0) + 1 AS next FROM phases WHERE competition_id = ?').get(compId);
    return row.next;
  })();

  const { lastInsertRowid } = db.prepare(`
    INSERT INTO phases (competition_id, phase_order, type, rule_doc)
    VALUES (?, ?, ?, ?)
  `).run(compId, order, ruleJson.type, path.basename(rule_doc));

  const phase = db.prepare('SELECT * FROM phases WHERE id = ?').get(lastInsertRowid);
  res.status(201).json(phase);
});

// ---------------------------------------------------------------------------
// GET /api/competitions/:compId/phases/:phaseId  — phase detail with pools
// ---------------------------------------------------------------------------
router.get('/:phaseId', (req, res) => {
  const { compId, phaseId } = req.params;
  const phase = db.prepare('SELECT * FROM phases WHERE id = ? AND competition_id = ?').get(phaseId, compId);
  if (!phase) return res.status(404).json({ error: 'Phase not found.' });

  const pools = db.prepare(`
    SELECT po.*,
           ref.name AS referee_name,
           st.name  AS strip_name
    FROM   pools po
    LEFT JOIN referees ref ON ref.id = po.referee_id
    LEFT JOIN strips   st  ON st.id  = po.strip_id
    WHERE  po.phase_id = ?
    ORDER  BY po.pool_number
  `).all(phaseId);

  for (const pool of pools) {
    pool.fencers = db.prepare(`
      SELECT c.id, c.name, c.club, c.nationality, c.initial_seed
      FROM   pool_competitors pc
      JOIN   competitors c ON c.id = pc.competitor_id
      WHERE  pc.pool_id = ?
      ORDER  BY c.initial_seed
    `).all(pool.id);

    pool.bouts = db.prepare(`
      SELECT b.id, b.left_id, b.right_id, b.left_score, b.right_score,
             b.winner_id, b.status,
             lf.name AS left_name, rf.name AS right_name
      FROM   bouts b
      JOIN   competitors lf ON lf.id = b.left_id
      JOIN   competitors rf ON rf.id = b.right_id
      WHERE  b.pool_id = ?
      ORDER  BY b.id
    `).all(pool.id);
  }

  res.json({ ...phase, pools });
});

// ---------------------------------------------------------------------------
// POST /api/competitions/:compId/phases/:phaseId/generate  — run pool formation
// Body (optional): { poolSizes: [7, 7, 6] }  — pass when confirming a choice
// ---------------------------------------------------------------------------
router.post('/:phaseId/generate', (req, res) => {
  const { compId, phaseId } = req.params;
  const { poolSizes } = req.body || {};

  const phase = db.prepare('SELECT * FROM phases WHERE id = ? AND competition_id = ?').get(phaseId, compId);
  if (!phase) return res.status(404).json({ error: 'Phase not found.' });
  if (phase.status !== 'pending') return res.status(409).json({ error: 'Can only generate pools for a pending phase.' });

  const existing = db.prepare('SELECT COUNT(*) AS n FROM pools WHERE phase_id = ?').get(phaseId);
  if (existing.n > 0) return res.status(409).json({ error: 'Pools already generated. Delete and recreate phase to regenerate.' });

  let rules;
  try { rules = loadRule(phase.rule_doc); } catch (e) { return res.status(500).json({ error: e.message }); }

  const fencers = db.prepare(`
    SELECT id, name, club, nationality, initial_seed
    FROM   competitors
    WHERE  competition_id = ? AND status = 'active'
  `).all(compId);

  let chosenSizes;

  if (poolSizes) {
    // User confirmed a specific pool configuration
    if (!Array.isArray(poolSizes) || !poolSizes.length) {
      return res.status(400).json({ error: 'poolSizes must be a non-empty array.' });
    }
    const total = poolSizes.reduce((s, n) => s + n, 0);
    if (total !== fencers.length) {
      return res.status(400).json({ error: `poolSizes sum (${total}) must equal active fencer count (${fencers.length}).` });
    }
    chosenSizes = poolSizes;
  } else {
    // Calculate options from rule config
    let options;
    try {
      options = calcPoolOptions(fencers.length, rules.poolFormation);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    if (options.length > 1) {
      // Multiple valid configurations — ask the client to present them to the user
      return res.json({ status: 'choose', options });
    }
    chosenSizes = options[0];
  }

  let poolData;
  try {
    poolData = formPools(fencers, chosenSizes, rules.poolFormation);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  // Write pools, competitors, and bouts inside a single transaction
  const doGenerate = db.transaction(() => {
    for (const { poolNumber, fencers: pFencers, bouts } of poolData) {
      const { lastInsertRowid: poolId } = db.prepare(
        'INSERT INTO pools (phase_id, pool_number) VALUES (?, ?)'
      ).run(phaseId, poolNumber);

      for (const f of pFencers) {
        db.prepare('INSERT INTO pool_competitors (pool_id, competitor_id) VALUES (?, ?)').run(poolId, f.id);
      }

      for (const { left, right } of bouts) {
        db.prepare(
          'INSERT INTO bouts (pool_id, phase_id, left_id, right_id) VALUES (?, ?, ?, ?)'
        ).run(poolId, phaseId, left.id, right.id);
      }
    }
    db.prepare("UPDATE phases SET status = 'active' WHERE id = ?").run(phaseId);
  });

  doGenerate();

  const updated    = db.prepare('SELECT * FROM phases WHERE id = ?').get(phaseId);
  const poolCount  = db.prepare('SELECT COUNT(*) AS n FROM pools WHERE phase_id = ?').get(phaseId);
  res.json({ ...updated, pool_count: poolCount.n });
});

// ---------------------------------------------------------------------------
// DELETE /api/competitions/:compId/phases/:phaseId
// ---------------------------------------------------------------------------
router.delete('/:phaseId', (req, res) => {
  const { compId, phaseId } = req.params;
  const phase = db.prepare('SELECT * FROM phases WHERE id = ? AND competition_id = ?').get(phaseId, compId);
  if (!phase) return res.status(404).json({ error: 'Phase not found.' });
  if (phase.status === 'finished') return res.status(409).json({ error: 'Cannot delete a finished phase.' });

  db.prepare('DELETE FROM phases WHERE id = ?').run(phaseId);
  res.json({ deleted: true });
});

module.exports = router;
