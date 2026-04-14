// ---------------------------------------------------------------------------
// Calculate pool rankings for a phase
// Returns: [{competitor_id, victories, indicator, touches_scored, touches_received, position}]
// ---------------------------------------------------------------------------

function calculatePoolRankings(phaseId) {
  // Get phase and rule
  const phase = db.prepare('SELECT * FROM phases WHERE id = ?').get(phaseId);
  if (!phase) return [];
  let rule = {};
  try { rule = loadRule(phase.rule_doc); } catch (e) {}
  const criteria = rule?.seeding?.criteria || [
    'victory_ratio_desc',
    'indicator_desc',
    'touches_scored_desc',
    'touches_received_asc',
    'initial_seed_asc',
    'name_asc'
  ];

  // Get all fencers in pools for this phase
  const fencers = db.prepare(`
    SELECT c.id, c.name, c.initial_seed
    FROM pool_competitors pc
    JOIN competitors c ON c.id = pc.competitor_id
    JOIN pools p ON p.id = pc.pool_id
    WHERE p.phase_id = ?
  `).all(phaseId);

  // Get all bouts for this phase
  const bouts = db.prepare(`
    SELECT * FROM bouts WHERE phase_id = ? AND left_score IS NOT NULL AND right_score IS NOT NULL
  `).all(phaseId);

  // Stats per fencer
  const stats = {};
  for (const f of fencers) {
    stats[f.id] = {
      competitor_id: f.id,
      name: f.name,
      initial_seed: f.initial_seed ?? 9999,
      victories: 0,
      matches: 0,
      indicator: 0,
      touches_scored: 0,
      touches_received: 0
    };
  }

  for (const bout of bouts) {
    // Left
    if (stats[bout.left_id]) {
      stats[bout.left_id].touches_scored += bout.left_score;
      stats[bout.left_id].touches_received += bout.right_score;
      stats[bout.left_id].matches += 1;
      if (bout.winner_id === bout.left_id) stats[bout.left_id].victories += 1;
    }
    // Right
    if (stats[bout.right_id]) {
      stats[bout.right_id].touches_scored += bout.right_score;
      stats[bout.right_id].touches_received += bout.left_score;
      stats[bout.right_id].matches += 1;
      if (bout.winner_id === bout.right_id) stats[bout.right_id].victories += 1;
    }
  }

  // Compute indicator and victory ratio
  for (const s of Object.values(stats)) {
    s.indicator = s.touches_scored - s.touches_received;
    s.victory_ratio = s.matches > 0 ? s.victories / s.matches : 0;
  }

  // Dynamic sort function based on criteria
  function compare(a, b) {
    for (const crit of criteria) {
      switch (crit) {
        case 'victory_ratio_desc':
          if (b.victory_ratio !== a.victory_ratio) return b.victory_ratio - a.victory_ratio;
          break;
        case 'victories_desc':
          if (b.victories !== a.victories) return b.victories - a.victories;
          break;
        case 'indicator_desc':
          if (b.indicator !== a.indicator) return b.indicator - a.indicator;
          break;
        case 'touches_scored_desc':
          if (b.touches_scored !== a.touches_scored) return b.touches_scored - a.touches_scored;
          break;
        case 'touches_received_asc':
          if (a.touches_received !== b.touches_received) return a.touches_received - b.touches_received;
          break;
        case 'initial_seed_asc':
          if ((a.initial_seed ?? 9999) !== (b.initial_seed ?? 9999)) return (a.initial_seed ?? 9999) - (b.initial_seed ?? 9999);
          break;
        case 'name_asc':
          if (a.name !== b.name) return a.name.localeCompare(b.name);
          break;
      }
    }
    return 0;
  }

  const ranked = Object.values(stats).sort(compare);
  ranked.forEach((s, i) => { s.position = i + 1; });
  return ranked;
}


'use strict';

const express        = require('express');
const path           = require('path');
const fs             = require('fs');
const db             = require('../db/db');
const { formPools, calcPoolOptions } = require('../lib/poolFormation');

const router = express.Router({ mergeParams: true });

// ---------------------------------------------------------------------------
// GET /competitions/:compId/phases/:phaseId/pools/:poolId/view — render pool entry page (EJS)
// ---------------------------------------------------------------------------
router.get('/:phaseId/pools/:poolId/view', (req, res) => {
  const { compId, phaseId, poolId } = req.params;
  const phase = db.prepare('SELECT * FROM phases WHERE id = ? AND competition_id = ?').get(phaseId, compId);
  if (!phase) return res.status(404).send('Phase not found');

  const pool = db.prepare(`
    SELECT po.*,
           ref.name AS referee_name,
           st.name  AS strip_name
    FROM   pools po
    LEFT JOIN referees ref ON ref.id = po.referee_id
    LEFT JOIN strips   st  ON st.id  = po.strip_id
    WHERE  po.id = ? AND po.phase_id = ?
  `).get(poolId, phaseId);
  if (!pool) return res.status(404).send('Pool not found');

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

  res.render('pool', { compId, phase, pool });
});
// ---------------------------------------------------------------------------
// GET /competitions/:compId/phases/:phaseId/view — render phase page (EJS)
// ---------------------------------------------------------------------------
router.get('/:phaseId/view', (req, res) => {
  const { compId, phaseId } = req.params;
  const phase = db.prepare('SELECT * FROM phases WHERE id = ? AND competition_id = ?').get(phaseId, compId);
  if (!phase) return res.status(404).send('Phase not found');

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

  // Calculate rankings
  const rankings = calculatePoolRankings(phaseId);
  res.render('phase', { compId, phase: { ...phase, pools }, rankings });
});

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

// ---------------------------------------------------------------------------
// PATCH /api/competitions/:compId/phases/:phaseId/bouts/:boutId — update bout scores
// ---------------------------------------------------------------------------
// POST /competitions/:compId/phases/:phaseId/bouts/update — batch update bouts from EJS form
// ---------------------------------------------------------------------------
router.post('/:phaseId/bouts/update', async (req, res) => {
  const { compId, phaseId } = req.params;
  const form = req.body;
  const boutUpdates = [];

  // Parse form fields: left_score_{id}, right_score_{id}, winner_{id}, save
  for (const key in form) {
    const match = key.match(/^(left_score|right_score|winner)_(\d+)$/);
    if (match) {
      const [, field, boutId] = match;
      let update = boutUpdates.find(b => b.boutId === boutId);
      if (!update) {
        update = { boutId };
        boutUpdates.push(update);
      }
      update[field] = form[key];
    }
  }

  // Only update the bout for which the Save button was pressed
  const saveBoutId = form.save;
  const update = boutUpdates.find(b => b.boutId === saveBoutId);
  if (update) {
    // Prepare PATCH logic (reuse single-bout update logic)
    const left_score = update.left_score ?? '';
    const right_score = update.right_score ?? '';
    const winner_id = update.winner ?? '';

    // Validate bout exists
    const bout = db.prepare('SELECT * FROM bouts WHERE id = ? AND phase_id = ?').get(saveBoutId, phaseId);
    if (bout) {
      // Save current state to bouts_history for undo
      db.prepare(`INSERT INTO bouts_history (bout_id, left_score, right_score, winner_id, status) VALUES (?, ?, ?, ?, ?)`)
        .run(bout.id, bout.left_score, bout.right_score, bout.winner_id, bout.status);

      // Validate scores
      const left = (left_score === '' || left_score === null) ? null : Number(left_score);
      const right = (right_score === '' || right_score === null) ? null : Number(right_score);
      let winner = null;
      if (left !== null && right !== null) {
        if (left !== right) {
          winner = left > right ? bout.left_id : bout.right_id;
        } else if (winner_id && [bout.left_id, bout.right_id].includes(Number(winner_id))) {
          winner = Number(winner_id);
        }
      }

      // Update bout
      db.prepare('UPDATE bouts SET left_score = ?, right_score = ?, winner_id = ? WHERE id = ?')
        .run(left, right, winner, bout.id);

      // Optionally, update status to 'finished' if both scores are present
      if (left !== null && right !== null) {
        db.prepare('UPDATE bouts SET status = ? WHERE id = ?').run('finished', bout.id);
      }
    }
  }

  // Determine where to redirect: if a referer header contains '/pools/', go back to the pool view
  let redirectUrl = `/competitions/${compId}/phases/${phaseId}/view`;
  const referer = req.get('referer') || '';
  const poolMatch = referer.match(/\/phases\/(\d+)\/pools\/(\d+)\/view/);
  let focus = form.focus || '';
  if (poolMatch) {
    // Use the poolId from the referer
    const poolId = poolMatch[2];
    redirectUrl = `/competitions/${compId}/phases/${phaseId}/pools/${poolId}/view`;
    if (focus) {
      redirectUrl += `?focus=${encodeURIComponent(focus)}`;
    }
  }
  res.redirect(redirectUrl);
});
router.patch('/:phaseId/bouts/:boutId', async (req, res) => {
  const { compId, phaseId, boutId } = req.params;
  const { left_score, right_score, winner_id: winnerOverride } = req.body;

  // Validate bout exists
  const bout = db.prepare('SELECT * FROM bouts WHERE id = ? AND phase_id = ?').get(boutId, phaseId);
  if (!bout) return res.status(404).json({ error: 'Bout not found.' });

  // Validate scores
  const left = (left_score === '' || left_score === null) ? null : Number(left_score);
  const right = (right_score === '' || right_score === null) ? null : Number(right_score);
  if ((left !== null && (isNaN(left) || left < 0 || left > 99)) || (right !== null && (isNaN(right) || right < 0 || right > 99))) {
    return res.status(400).json({ error: 'Scores must be numbers between 0 and 99 or blank.' });
  }

  // Save current state to bouts_history for undo
  db.prepare(`INSERT INTO bouts_history (bout_id, left_score, right_score, winner_id, status) VALUES (?, ?, ?, ?, ?)`)
    .run(boutId, bout.left_score, bout.right_score, bout.winner_id, bout.status);

  // Determine winner
  let winner_id = null;
  if (left !== null && right !== null) {
    if (left !== right) {
      winner_id = left > right ? bout.left_id : bout.right_id;
    } else if (winnerOverride) {
      // Tie, but winner manually specified
      if ([bout.left_id, bout.right_id].includes(winnerOverride)) {
        winner_id = winnerOverride;
      }
    }
  }

  // Update bout
  db.prepare('UPDATE bouts SET left_score = ?, right_score = ?, winner_id = ? WHERE id = ?').run(left, right, winner_id, boutId);

  // Optionally, update status to 'finished' if both scores are present
  let status = bout.status;
  if (left !== null && right !== null) {
    status = 'finished';
    db.prepare('UPDATE bouts SET status = ? WHERE id = ?').run(status, boutId);
  }

  res.json({ success: true, left_score: left, right_score: right, winner_id, status });
});

// Undo last bout score change
router.post('/:phaseId/bouts/:boutId/undo', (req, res) => {
  const { phaseId, boutId } = req.params;
  // Get last history entry
  const hist = db.prepare('SELECT * FROM bouts_history WHERE bout_id = ? ORDER BY changed_at DESC, id DESC LIMIT 1').get(boutId);
  if (!hist) return res.status(404).json({ error: 'No undo history for this bout.' });

  db.prepare('UPDATE bouts SET left_score = ?, right_score = ?, winner_id = ?, status = ? WHERE id = ?')
    .run(hist.left_score, hist.right_score, hist.winner_id, hist.status, boutId);
  // Optionally, delete the history entry after undo
  db.prepare('DELETE FROM bouts_history WHERE id = ?').run(hist.id);

  res.json({ success: true, undone: true });
});

module.exports = router;
