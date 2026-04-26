const express = require('express');
const db = require('../db/db');
const path = require('path');
const { calculatePoolRankings, loadRule, resolveRulePath } = require('./phasesService');
const { formPools, calcPoolOptions } = require('../lib/poolFormation');

const router = express.Router({ mergeParams: true });

// ---------------------------------------------------------------------------
// POST /api/competitions/:compId/phases/:phaseId/simulate — fill random results for all incomplete bouts
// ---------------------------------------------------------------------------
router.post('/:phaseId/simulate', (req, res) => {
  const compId = req.params.compId;
  const phaseId = req.params.phaseId;
  console.log('Simulate endpoint hit for compId:', compId, 'phaseId:', phaseId);
  const phase = db.prepare('SELECT * FROM phases WHERE id = ? AND competition_id = ?').get(phaseId, compId);
  if (!phase) return res.status(404).json({ error: 'Phase not found.' });
  if (phase.status !== 'active') return res.status(409).json({ error: 'Can only simulate results for an active phase.' });

  // Get all incomplete bouts for this phase
  const bouts = db.prepare('SELECT * FROM bouts WHERE phase_id = ? AND (left_score IS NULL OR right_score IS NULL)').all(phaseId);
  if (!bouts.length) return res.json({ message: 'No incomplete bouts to simulate.' });

  // Simulate results
  const updates = [];
  for (const bout of bouts) {
    // Generate random scores (e.g., 5-0 to 5-4, no ties)
    let left_score, right_score, winner_id;
    const maxScore = 5;
    if (Math.random() < 0.5) {
      left_score = maxScore;
      right_score = Math.floor(Math.random() * maxScore);
      winner_id = bout.left_id;
    } else {
      right_score = maxScore;
      left_score = Math.floor(Math.random() * maxScore);
      winner_id = bout.right_id;
    }
    // Save current state to bouts_history for undo
    db.prepare(`INSERT INTO bouts_history (bout_id, left_score, right_score, winner_id, status) VALUES (?, ?, ?, ?, ?)`)
      .run(bout.id, bout.left_score, bout.right_score, bout.winner_id, bout.status);
    db.prepare('UPDATE bouts SET left_score = ?, right_score = ?, winner_id = ?, status = ? WHERE id = ?')
      .run(left_score, right_score, winner_id, 'finished', bout.id);
    updates.push({ id: bout.id, left_score, right_score, winner_id });
  }
  res.json({ updated: updates.length, bouts: updates });
});

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

    // Build grid: rows/cols = fencers, cells = result
    const n = pool.fencers.length;
    const idToIdx = {};
    pool.fencers.forEach((f, i) => { idToIdx[f.id] = i; });
    // Initialize grid with nulls
    const grid = Array.from({length: n}, () => Array(n).fill(null));
    // Fill grid with bout results
    for (const bout of pool.bouts) {
      const i = idToIdx[bout.left_id];
      const j = idToIdx[bout.right_id];
      if (i !== undefined && j !== undefined) {
        grid[i][j] = {
          left_score: bout.left_score,
          right_score: bout.right_score,
          winner_id: bout.winner_id
        };
      }
    }
    pool.grid = grid;
    // Calculate stats for each fencer in this pool
    pool.stats = pool.fencers.map(f => {
      let victories = 0, matches = 0, indicator = 0, scored = 0, received = 0;
      for (let k = 0; k < n; ++k) {
        if (grid[f.idToIdx ?? idToIdx[f.id]] && grid[f.idToIdx ?? idToIdx[f.id]][k]) {
        // Fetch all strips for assignment UI
        const strips = db.prepare('SELECT id, strip_number, name, status, state, network_state FROM strips ORDER BY strip_number').all();
          const cell = grid[idToIdx[f.id]][k];
          if (cell.left_score != null && cell.right_score != null) {
            matches++;
            scored += cell.left_score;
            received += cell.right_score;
            indicator += cell.left_score - cell.right_score;
            if (cell.winner_id === f.id) victories++;
          }
        }
        if (grid[k] && grid[k][idToIdx[f.id]]) {
          const cell = grid[k][idToIdx[f.id]];
          if (cell.left_score != null && cell.right_score != null) {
            // This is a bout where fencer f was on the right
            scored += cell.right_score;
            received += cell.left_score;
            indicator += cell.right_score - cell.left_score;
            if (cell.winner_id === f.id) victories++;
          }
        }
      }
      return { victories, matches, indicator, scored, received };
    });
  }

  // Fetch all strips for assignment UI
  const strips = db.prepare('SELECT id, strip_number, name, status, state, network_state FROM strips ORDER BY strip_number').all();
  // Calculate rankings
  const rankings = calculatePoolRankings(phaseId);
  res.render('phase', { compId, phase: { ...phase, pools }, rankings, strips });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ...removed duplicate resolveRulePath and loadRule; now imported from phasesService.js...

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

        // res.render('phase', { compId, phase: { ...phase, pools }, rankings, strips }); // Removed: causes 'phase' before initialization error
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
  const { poolSizes, blockChoice, advancementChoice } = req.body || {};
  // Debug log removed for production cleanup

  const phase = db.prepare('SELECT * FROM phases WHERE id = ? AND competition_id = ?').get(phaseId, compId);
  if (!phase) {
    return res.status(404).json({ error: 'Phase not found.' });
  }
  if (phase.status !== 'pending') {
    return res.status(409).json({ error: 'Can only generate pools for a pending phase.' });
  }
  const existing = db.prepare('SELECT COUNT(*) AS n FROM pools WHERE phase_id = ?').get(phaseId);
  if (existing.n > 0) {
    return res.status(409).json({ error: 'Pools already generated. Delete and recreate phase to regenerate.' });
  }

  let rules;
  try { rules = loadRule(phase.rule_doc); } catch (e) { return res.status(500).json({ error: e.message }); }
  // If user provided advancementChoice, override advancement in rules
  if (advancementChoice) {
    rules.advancement = advancementChoice;
    // Optionally persist the choice for this phase if you want to use it later (e.g., in phase close)
    db.prepare('UPDATE phases SET advancement_choice = ? WHERE id = ?').run(JSON.stringify(advancementChoice), phaseId);
  }

  const fencers = db.prepare(`
    SELECT id, name, club, nationality, initial_seed, status
    FROM   competitors
    WHERE  competition_id = ? AND status = 'active'
  `).all(compId);
  // Debug log removed for production cleanup

  let chosenSizes;
  // Special handling for block-seeding (level pools)
  if (rules.poolFormation.algorithm === 'block-seeding') {
    const blockSize = rules.poolFormation.blockSize || 6;
    // Debug log removed for production cleanup
    // Sort by initial_seed ASC; unseeded fencers go last
    const sorted = [...fencers].sort((a, b) => {
      const sa = a.initial_seed ?? 99999;
      const sb = b.initial_seed ?? 99999;
      return sa - sb;
    });
    const { blockSeedingOptions } = require('../lib/poolFormation');
    const opts = blockSeedingOptions(sorted, blockSize);
    let droppedFencers = [];
    if (opts.type === 'ok') {
      chosenSizes = Array(sorted.length / blockSize).fill(blockSize);
      // Debug log removed for production cleanup
    } else {
      // If user provided a choice, handle it
      if (req.body && req.body.blockChoice) {
        if (req.body.blockChoice === 'drop') {
          // Drop lowest ranked
          // Debug log removed for production cleanup
          const keep = sorted.slice(0, sorted.length - opts.drop.length);
          const keptIds = keep.map(f => f.id);
          const droppedIds = sorted.slice(sorted.length - opts.drop.length).map(f => f.id);
          // Debug log removed for production cleanup
          chosenSizes = Array(Math.floor(keep.length / blockSize)).fill(blockSize);
          fencers.length = 0; keep.forEach(f => fencers.push(f));
          droppedFencers = opts.drop;
          // Debug log removed for production cleanup
        } else if (req.body.blockChoice === 'redistribute' && opts.redistribute) {
          chosenSizes = opts.redistribute;
          // Debug log removed for production cleanup
        } else {
          // Debug log removed for production cleanup
          return res.status(400).json({ error: 'Invalid blockChoice or redistribution not possible.' });
        }
      } else {
        // Present options to user
        return res.json({
          status: 'block-seeding-options',
          message: `Number of fencers (${sorted.length}) is not divisible by ${blockSize}. Choose to drop the lowest ranked (${opts.drop.length}) or redistribute (${opts.redistribute ? opts.redistribute.join(',') : 'not possible'}).`,
          totalFencers: sorted.length,
          toDrop: opts.drop.length,
          options: {
            drop: opts.drop,
            redistribute: opts.redistribute
          }
        });
      }
    }
    // Store dropped fencers in the phase for later ranking
    if (droppedFencers.length > 0) {
      db.prepare('UPDATE phases SET dropped_fencers = ? WHERE id = ?').run(JSON.stringify(droppedFencers), phaseId);
      // Debug log removed for production cleanup
    }
  } else if (poolSizes) {
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
    // Debug log removed for production cleanup
  } catch (e) {
    // Debug log removed for production cleanup
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

  // Only allow deleting the last phase
  const lastPhase = db.prepare('SELECT id FROM phases WHERE competition_id = ? ORDER BY phase_order DESC LIMIT 1').get(compId);
  if (!lastPhase || String(lastPhase.id) !== String(phaseId)) {
    return res.status(409).json({ error: 'Only the last phase can be deleted.' });
  }

  // Delete all pools, bouts, pool_competitors for this phase
  const poolIds = db.prepare('SELECT id FROM pools WHERE phase_id = ?').all(phaseId).map(r => r.id);
  for (const poolId of poolIds) {
    db.prepare('DELETE FROM bouts WHERE pool_id = ?').run(poolId);
    db.prepare('DELETE FROM pool_competitors WHERE pool_id = ?').run(poolId);
  }
  db.prepare('DELETE FROM pools WHERE phase_id = ?').run(phaseId);
  db.prepare('DELETE FROM phases WHERE id = ?').run(phaseId);

  // Restore only competitors eliminated in this phase
  db.prepare("UPDATE competitors SET status = 'active', eliminated_after = NULL WHERE competition_id = ? AND eliminated_after = ?")
    .run(compId, phaseId);
  // Optionally, you could also clear final_rank for these competitors if needed:
  // db.prepare("UPDATE competitors SET final_rank = NULL WHERE competition_id = ? AND eliminated_after = ?").run(compId, phaseId);

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

// ---------------------------------------------------------------------------
// POST /api/competitions/:compId/phases/:phaseId/close — finalize phase, eliminate fencers
// ---------------------------------------------------------------------------
router.post('/:phaseId/close', (req, res) => {
  const { compId, phaseId } = req.params;
  const phase = db.prepare('SELECT * FROM phases WHERE id = ? AND competition_id = ?').get(phaseId, compId);
  if (!phase) return res.status(404).json({ error: 'Phase not found.' });
  if (phase.status === 'finished') return res.status(409).json({ error: 'Phase already finished.' });

  // Only pool phases supported for now
  if (phase.type !== 'pool') return res.status(400).json({ error: 'Only pool phases can be closed.' });

  // Check all bouts are complete
  const incomplete = db.prepare(`
    SELECT COUNT(*) AS n FROM bouts WHERE phase_id = ? AND (left_score IS NULL OR right_score IS NULL)
  `).get(phaseId);
  if (incomplete.n > 0) return res.status(400).json({ error: 'Not all bouts are complete.' });

  // Calculate rankings
  const rankings = calculatePoolRankings(phaseId);
  let rule = {};
  let adv = null;
  try { rule = loadRule(phase.rule_doc); } catch (e) {}
  // Use advancement_choice from phase if present, else from rule
  if (phase.advancement_choice) {
    try { adv = JSON.parse(phase.advancement_choice); } catch (e) { adv = null; }
  }
  if (!adv) {
    adv = rule?.advancement;
  }
  if (!adv) return res.status(400).json({ error: 'No advancement rule in rule doc or phase.' });

  // Determine advancing count
  let N = rankings.length;
  let advanceN = N;
  if (adv.method === 'percentage') {
    let percent = Number(adv.value);
    if (isNaN(percent) || percent <= 0 || percent > 100) {
      return res.status(400).json({ error: 'Invalid percentage value for advancement.' });
    }
    advanceN = Math.ceil(N * (percent / 100));
    let roundTo = adv.roundTo !== undefined && adv.roundTo !== null ? Number(adv.roundTo) : null;
    if (roundTo && !isNaN(roundTo) && roundTo > 1) {
      // Always round UP to the closest multiple of roundTo (but not above N)
      advanceN = Math.ceil(advanceN / roundTo) * roundTo;
      if (advanceN > N) advanceN = Math.floor(N / roundTo) * roundTo;
    }
  } else if (adv.method === 'count') {
    let count = Number(adv.value);
    if (isNaN(count) || count < 1 || count > N) {
      return res.status(400).json({ error: 'Invalid count value for advancement.' });
    }
    advanceN = Math.min(N, count);
  } else if (adv.method === 'multiple') {
    const multipleOf = Number(adv.multipleOf) || 1;
    if (isNaN(multipleOf) || multipleOf < 1) {
      return res.status(400).json({ error: 'Invalid multipleOf value for multiple advancement.' });
    }
    advanceN = Math.floor(N / multipleOf) * multipleOf;
    if (advanceN < 1) advanceN = multipleOf <= N ? multipleOf : N; // fallback: at least one advances
  } else if (adv.method === 'top_per_pool') {
    // Not implemented here
    return res.status(400).json({ error: 'top_per_pool advancement not supported yet.' });
  }

  // Mark eliminated fencers
  const toEliminate = rankings.slice(advanceN);
  const toAdvance = rankings.slice(0, advanceN);
  console.log('[PHASE CLOSE] Advancing:', toAdvance.map(f => ({id: f.competitor_id, pos: f.position})));
  console.log('[PHASE CLOSE] Eliminating:', toEliminate.map(f => ({id: f.competitor_id, pos: f.position})));
  const tx = db.transaction(() => {
    for (const f of toEliminate) {
      db.prepare('UPDATE competitors SET status = ?, eliminated_after = ? WHERE id = ?')
        .run('eliminated', phaseId, f.competitor_id);
      db.prepare('UPDATE competitors SET final_rank = ? WHERE id = ?')
        .run(f.position, f.competitor_id);
    }
    for (const f of toAdvance) {
      db.prepare('UPDATE competitors SET status = ? WHERE id = ?')
        .run('active', f.competitor_id);
    }
    db.prepare('UPDATE phases SET status = ? WHERE id = ?').run('finished', phaseId);
  });
  tx();
  // If the user wants to finish the competition, call the new endpoint below.
  // ---------------------------------------------------------------------------
  // POST /api/competitions/:compId/finish — finish the competition, mark all active as finished
  // ---------------------------------------------------------------------------
  res.json({ closed: true, eliminated: toEliminate.length });
});

// ---------------------------------------------------------------------------
// POST /api/competitions/:compId/phases/:phaseId/reopen — set phase back to active
// ---------------------------------------------------------------------------
router.post('/:phaseId/reopen', (req, res) => {
  const { compId, phaseId } = req.params;
  const phase = db.prepare('SELECT * FROM phases WHERE id = ? AND competition_id = ?').get(phaseId, compId);
  if (!phase) return res.status(404).json({ error: 'Phase not found.' });
  if (phase.status !== 'finished') return res.status(409).json({ error: 'Only finished phases can be reopened.' });

  // Optionally, undo eliminations for this phase
  db.prepare('UPDATE competitors SET status = ?, eliminated_after = NULL, final_rank = NULL WHERE eliminated_after = ?').run('active', phaseId);
  db.prepare('UPDATE phases SET status = ? WHERE id = ?').run('active', phaseId);
  res.json({ reopened: true });
});



// POST /api/competitions/:compId/phases/:phaseId/pools/:poolId/assign-strip
router.post('/:phaseId/pools/:poolId/assign-strip', (req, res) => {
  const { compId, phaseId, poolId } = req.params;
  const { strip_id } = req.body;
  // Validate pool exists
  const pool = db.prepare('SELECT * FROM pools WHERE id = ? AND phase_id = ?').get(poolId, phaseId);
  if (!pool) return res.status(404).json({ error: 'Pool not found.' });
  // Optionally validate strip exists
  if (strip_id) {
    const strip = db.prepare('SELECT * FROM strips WHERE id = ?').get(strip_id);
    if (!strip) return res.status(400).json({ error: 'Strip not found.' });
  }
  db.prepare('UPDATE pools SET strip_id = ? WHERE id = ?').run(strip_id || null, poolId);
  res.json({ success: true });
});

module.exports = router;
