
const express = require('express');
const models = require('../models');
const path = require('path');
const { calculatePoolRankings, loadRule, resolveRulePath } = require('./phasesService');
const { formPools, calcPoolOptions } = require('../lib/poolFormation');
const router = express.Router({ mergeParams: true });

// ---------------------------------------------------------------------------
// POST /api/competitions/:compId/phases — create a new phase for a competition
// Body: { rule_doc: string, phase_order?: int }
// ---------------------------------------------------------------------------
router.post('/', async (req, res) => {
  const { compId } = req.params;
  const { rule_doc, phase_order } = req.body;
  if (!rule_doc) return res.status(400).json({ error: 'rule_doc is required.' });

  let ruleJson;
  try {
    ruleJson = loadRule(rule_doc);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  // Determine phase order (auto-increment if not provided)
  let order = phase_order;
  if (order == null) {
    const maxOrder = await models.Phase.max('phase_order', { where: { competition_id: compId } });
    order = (maxOrder || 0) + 1;
  }

  try {
    const phase = await models.Phase.create({
      competition_id: compId,
      phase_order: order,
      type: ruleJson.type,
      rule_doc: rule_doc
    });
    res.status(201).json(phase);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// ---------------------------------------------------------------------------
// GET /api/competitions/:compId/phases — list all phases for a competition
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  const { compId } = req.params;
  try {
    const phases = await models.Phase.findAll({
      where: { competition_id: compId },
      order: [['phase_order', 'ASC']]
    });
    res.json(phases);
  } catch (e) {
    console.error('Error in GET /api/competitions/:compId/phases:', e);
    res.status(500).json({ error: e.message, stack: e.stack });
  }
});


// ---------------------------------------------------------------------------
// POST /api/competitions/:compId/phases/:phaseId/simulate — fill random results for all incomplete bouts
// ---------------------------------------------------------------------------
router.post('/:phaseId/simulate', async (req, res) => {
  const compId = req.params.compId;
  const phaseId = req.params.phaseId;
  const phase = await models.Phase.findOne({ where: { id: phaseId, competition_id: compId } });
  if (!phase) return res.status(404).json({ error: 'Phase not found.' });
  if (phase.status !== 'active') return res.status(409).json({ error: 'Can only simulate results for an active phase.' });

  // Get all incomplete bouts for this phase
  const bouts = await models.Bout.findAll({ where: { phase_id: phaseId, [models.Sequelize.Op.or]: [{ left_score: null }, { right_score: null }] } });
  if (!bouts.length) return res.json({ message: 'No incomplete bouts to simulate.' });

  // Simulate results
  const updates = [];
  for (const bout of bouts) {
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
    // TODO: Save to bouts_history if needed (Sequelize model not defined)
    await bout.update({ left_score, right_score, winner_id, status: 'finished' });
    updates.push({ id: bout.id, left_score, right_score, winner_id });
  }
  res.json({ updated: updates.length, bouts: updates });
});

// ---------------------------------------------------------------------------
// GET /competitions/:compId/phases/:phaseId/pools/:poolId/view — render pool entry page (EJS)
// ---------------------------------------------------------------------------
router.get('/:phaseId/pools/:poolId/view', async (req, res) => {
  // ...existing code for this route should go here...
    pool.bouts = await models.Bout.findAll({
      where: { pool_id: pool.id },
      include: [
        { model: models.Competitor, as: 'LeftCompetitor', attributes: ['name'] },
        { model: models.Competitor, as: 'RightCompetitor', attributes: ['name'] }
      ],
      order: [['id', 'ASC']]
    });

  // Coerce compId to a number to avoid foreign key constraint errors
  compId = Number(compId);
  console.log('[DEBUG] POST /api/competitions/:compId/phases', { compId, rule_doc, phase_order });

  if (!rule_doc) return res.status(400).json({ error: 'rule_doc is required.' });

  let ruleJson;
  try { ruleJson = loadRule(rule_doc); } catch (e) { return res.status(e.status || 500).json({ error: e.message }); }

  const order = phase_order ?? (await models.Phase.max('phase_order', { where: { competition_id: compId } }) || 0) + 1;

  console.log('[DEBUG] Inserting phase:', { competition_id: compId, phase_order: order, type: ruleJson.type, rule_doc: path.basename(rule_doc) });

  const phase = await models.Phase.create({
    competition_id: compId,
    phase_order: order,
    type: ruleJson.type,
    rule_doc: path.basename(rule_doc)
  });
  res.status(201).json(phase);
});

// ---------------------------------------------------------------------------
// GET /api/competitions/:compId/phases/:phaseId  — phase detail with pools
// ---------------------------------------------------------------------------
router.get('/:phaseId', async (req, res) => {
  const { compId, phaseId } = req.params;
  const phase = await models.Phase.findOne({
    where: { id: phaseId, competition_id: compId }
  });
  if (!phase) return res.status(404).json({ error: 'Phase not found.' });

  const pools = await models.Pool.findAll({
    where: { phase_id: phaseId },
    include: [
      { model: models.Referee, attributes: ['name'] },
      { model: models.Strip, attributes: ['name'] }
    ],
    order: [['pool_number', 'ASC']]
  });

  for (const pool of pools) {
    const poolFencers = await models.PoolCompetitor.findAll({
      where: { pool_id: pool.id },
      include: [{ model: models.Competitor }],
      order: [[models.Competitor, 'initial_seed', 'ASC']]
    });
    pool.fencers = poolFencers.map(pc => pc.Competitor);

    pool.bouts = await models.Bout.findAll({
      where: { pool_id: pool.id },
      include: [
        { model: models.Competitor, as: 'LeftCompetitor', attributes: ['name'] },
        { model: models.Competitor, as: 'RightCompetitor', attributes: ['name'] }
      ],
      order: [['id', 'ASC']]
    });
  }

  res.json({ ...phase.toJSON(), pools });
});

// ---------------------------------------------------------------------------
// POST /api/competitions/:compId/phases/:phaseId/generate  — run pool formation
// Body (optional): { poolSizes: [7, 7, 6] }  — pass when confirming a choice
// ---------------------------------------------------------------------------
router.post('/:phaseId/generate', async (req, res) => {
  const { compId, phaseId } = req.params;
  const { poolSizes, blockChoice, advancementChoice } = req.body || {};
  const phase = await models.Phase.findOne({ where: { id: phaseId, competition_id: compId } });
  if (!phase) return res.status(404).json({ error: 'Phase not found.' });
  if (phase.status !== 'pending') return res.status(409).json({ error: 'Can only generate pools for a pending phase.' });
  const existing = await models.Pool.count({ where: { phase_id: phaseId } });
  if (existing > 0) return res.status(409).json({ error: 'Pools already generated. Delete and recreate phase to regenerate.' });

  let rules;
  try { rules = loadRule(phase.rule_doc); } catch (e) { return res.status(500).json({ error: e.message }); }
  if (advancementChoice) {
    rules.advancement = advancementChoice;
    await phase.update({ advancement_choice: JSON.stringify(advancementChoice) });
  }

  // Get all active fencers for this competition
  const fencerEntries = await models.CompetitionFencer.findAll({
    where: { competition_id: compId, status: 'active' },
    include: [{
      model: models.Fencer,
      include: [{ model: models.Person }]
    }]
  });
  const fencers = fencerEntries.map(entry => {
    const f = entry.Fencer;
    const p = f.Person;
    return {
      id: f.id,
      first_name: p.firstName,
      last_name: p.lastName,
      nationality: p.nationality,
      gender: p.gender,
      initial_seed: f.initial_seed,
      status: entry.status
    };
  });

  let chosenSizes;
  // Special handling for block-seeding (level pools)
  if (rules.poolFormation.algorithm === 'block-seeding') {
    const blockSize = rules.poolFormation.blockSize || 6;
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
    } else {
      // If user provided a choice, handle it
      if (blockChoice) {
        if (blockChoice === 'drop') {
          // Drop lowest ranked
          const keep = sorted.slice(0, sorted.length - opts.drop.length);
          chosenSizes = Array(Math.floor(keep.length / blockSize)).fill(blockSize);
          fencers.length = 0; keep.forEach(f => fencers.push(f));
          droppedFencers = opts.drop;
        } else if (blockChoice === 'redistribute' && opts.redistribute) {
          chosenSizes = opts.redistribute;
        } else {
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
      await models.Phase.update(
        { dropped_fencers: JSON.stringify(droppedFencers) },
        { where: { id: phaseId } }
      );
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

  // Form pools and write to DB in a transaction
  let poolData;
  try {
    poolData = formPools(fencers, chosenSizes, rules.poolFormation);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  // Write pools, competitors, and bouts using Sequelize transaction
  try {
    await models.sequelize.transaction(async (t) => {
      for (const { poolNumber, fencers: pFencers, bouts } of poolData) {
        const pool = await models.Pool.create({ phase_id: phaseId, pool_number: poolNumber }, { transaction: t });
        for (const f of pFencers) {
          await models.PoolCompetitor.create({ pool_id: pool.id, competitor_id: f.id }, { transaction: t });
        }
        for (const { left, right } of bouts) {
          await models.Bout.create({ pool_id: pool.id, phase_id: phaseId, left_id: left.id, right_id: right.id }, { transaction: t });
        }
      }
      await phase.update({ status: 'active' }, { transaction: t });
    });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to create pools: ' + e.message });
  }

  // Return updated phase info
  const updated = await models.Phase.findOne({ where: { id: phaseId } });
  const poolCount = await models.Pool.count({ where: { phase_id: phaseId } });
  res.json({ ...updated.toJSON(), pool_count: poolCount });
});
// ...existing code continues...

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
    const left_score = update.left_score ?? '';
    const right_score = update.right_score ?? '';
    const winner_id = update.winner ?? '';

    // Validate bout exists
    const bout = await models.Bout.findOne({ where: { id: saveBoutId, phase_id: phaseId } });
    if (bout) {
      // TODO: Save current state to bouts_history for undo (if you have a Sequelize model for it)

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
      await bout.update({ left_score: left, right_score: right, winner_id: winner });

      // Optionally, update status to 'finished' if both scores are present
      if (left !== null && right !== null) {
        await bout.update({ status: 'finished' });
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
  const bout = await models.Bout.findOne({ where: { id: boutId, phase_id: phaseId } });
  if (!bout) return res.status(404).json({ error: 'Bout not found.' });

  // Validate scores
  const left = (left_score === '' || left_score === null) ? null : Number(left_score);
  const right = (right_score === '' || right_score === null) ? null : Number(right_score);
  if ((left !== null && (isNaN(left) || left < 0 || left > 99)) || (right !== null && (isNaN(right) || right < 0 || right > 99))) {
    return res.status(400).json({ error: 'Scores must be numbers between 0 and 99 or blank.' });
  }

  // TODO: Save current state to bouts_history for undo (if you have a Sequelize model for it)

  // Determine winner
  let winner_id = null;
  if (left !== null && right !== null) {
    if (left !== right) {
      winner_id = left > right ? bout.left_id : bout.right_id;
    } else if (winnerOverride) {
      if ([bout.left_id, bout.right_id].includes(Number(winnerOverride))) {
        winner_id = Number(winnerOverride);
      }
    }
  }

  // Update bout
  await bout.update({ left_score: left, right_score: right, winner_id });

  // Optionally, update status to 'finished' if both scores are present
  let status = bout.status;
  if (left !== null && right !== null) {
    status = 'finished';
    await bout.update({ status });
  }

  res.json({ success: true, left_score: left, right_score: right, winner_id, status });
});

// Undo last bout score change
router.post('/:phaseId/bouts/:boutId/undo', async (req, res) => {
  const { phaseId, boutId } = req.params;
  // Get last history entry
  const hist = await models.BoutHistory.findOne({
    where: { bout_id: boutId },
    order: [ ['changed_at', 'DESC'], ['id', 'DESC'] ]
  });
  if (!hist) return res.status(404).json({ error: 'No undo history for this bout.' });

  const bout = await models.Bout.findByPk(boutId);
  if (!bout) return res.status(404).json({ error: 'Bout not found.' });

  await bout.update({
    left_score: hist.left_score,
    right_score: hist.right_score,
    winner_id: hist.winner_id,
    status: hist.status
  });

  // Optionally, delete the history entry after undo
  await hist.destroy();

  res.json({ success: true, undone: true });
});

// ---------------------------------------------------------------------------
// POST /api/competitions/:compId/phases/:phaseId/close — finalize phase, eliminate fencers
// ---------------------------------------------------------------------------
router.post('/:phaseId/close', async (req, res) => {
  const { compId, phaseId } = req.params;
  const phase = await models.Phase.findOne({ where: { id: phaseId, competition_id: compId } });
  if (!phase) return res.status(404).json({ error: 'Phase not found.' });
  if (phase.status === 'finished') return res.status(409).json({ error: 'Phase already finished.' });

  // Only pool phases supported for now
  if (phase.type !== 'pool') return res.status(400).json({ error: 'Only pool phases can be closed.' });

  // Check all bouts are complete
  const incomplete = await models.Bout.count({
    where: {
      phase_id: phaseId,
      [models.Sequelize.Op.or]: [
        { left_score: null },
        { right_score: null }
      ]
    }
  });
  if (incomplete > 0) return res.status(400).json({ error: 'Not all bouts are complete.' });

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
    if (advanceN < 1) advanceN = multipleOf <= N ? multipleOf : N;
  } else if (adv.method === 'top_per_pool') {
    return res.status(400).json({ error: 'top_per_pool advancement not supported yet.' });
  }

  // Mark eliminated fencers
  const toEliminate = rankings.slice(advanceN);
  const toAdvance = rankings.slice(0, advanceN);
  console.log('[PHASE CLOSE] Advancing:', toAdvance.map(f => ({id: f.competitor_id, pos: f.position})));
  console.log('[PHASE CLOSE] Eliminating:', toEliminate.map(f => ({id: f.competitor_id, pos: f.position})));

  // Transactional update
  await models.sequelize.transaction(async (t) => {
    for (const f of toEliminate) {
      await models.Competitor.update(
        { status: 'eliminated', eliminated_after: phaseId, final_rank: f.position },
        { where: { id: f.competitor_id }, transaction: t }
      );
    }
    for (const f of toAdvance) {
      await models.Competitor.update(
        { status: 'active' },
        { where: { id: f.competitor_id }, transaction: t }
      );
    }
    await phase.update({ status: 'finished' }, { transaction: t });
  });

  res.json({ closed: true, eliminated: toEliminate.length });
});

// ---------------------------------------------------------------------------
// POST /api/competitions/:compId/phases/:phaseId/reopen — set phase back to active
// ---------------------------------------------------------------------------
router.post('/:phaseId/reopen', async (req, res) => {
  const { compId, phaseId } = req.params;
  const phase = await models.Phase.findOne({ where: { id: phaseId, competition_id: compId } });
  if (!phase) return res.status(404).json({ error: 'Phase not found.' });
  if (phase.status !== 'finished') return res.status(409).json({ error: 'Only finished phases can be reopened.' });

  // Undo eliminations for this phase
  await models.Competitor.update(
    { status: 'active', eliminated_after: null, final_rank: null },
    { where: { eliminated_after: phaseId } }
  );
  await phase.update({ status: 'active' });
  res.json({ reopened: true });
});



// POST /api/competitions/:compId/phases/:phaseId/pools/:poolId/assign-strip
router.post('/:phaseId/pools/:poolId/assign-strip', async (req, res) => {
  const { compId, phaseId, poolId } = req.params;
  const { strip_id } = req.body;
  // Validate pool exists
  const pool = await models.Pool.findOne({ where: { id: poolId, phase_id: phaseId } });
  if (!pool) return res.status(404).json({ error: 'Pool not found.' });
  // Optionally validate strip exists
  if (strip_id) {
    const strip = await models.Strip.findByPk(strip_id);
    if (!strip) return res.status(400).json({ error: 'Strip not found.' });
  }
  await pool.update({ strip_id: strip_id || null });
  res.json({ success: true });
});

module.exports = router;
