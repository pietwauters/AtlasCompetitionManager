// phasesService.js — Business logic for phases
// Contains database operations and calculations for phases

const db = require('../db/db');
const path = require('path');
const fs = require('fs');

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

// Calculate pool rankings for a phase

async function calculatePoolRankings(phaseId, models) {
  const phase = await models.Phase.findByPk(phaseId);
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

  if (rule.levelPools) {
    const pools = await models.Pool.findAll({ where: { phase_id: phaseId }, order: [['pool_number', 'ASC']] });
    let ranked = [];
    let pos = 1;
    for (const pool of pools) {
      const poolFencers = await models.PoolCompetitor.findAll({
        where: { pool_id: pool.id },
        include: [{ model: models.Competitor }]
      });
      const fencers = poolFencers.map(pc => pc.Competitor);
      const bouts = await models.Bout.findAll({
        where: {
          pool_id: pool.id,
          left_score: { [models.Sequelize.Op.not]: null },
          right_score: { [models.Sequelize.Op.not]: null }
        }
      });
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
        if (stats[bout.left_id]) {
          stats[bout.left_id].touches_scored += bout.left_score;
          stats[bout.left_id].touches_received += bout.right_score;
          stats[bout.left_id].matches += 1;
          if (bout.winner_id === bout.left_id) stats[bout.left_id].victories += 1;
        }
        if (stats[bout.right_id]) {
          stats[bout.right_id].touches_scored += bout.right_score;
          stats[bout.right_id].touches_received += bout.left_score;
          stats[bout.right_id].matches += 1;
          if (bout.winner_id === bout.right_id) stats[bout.right_id].victories += 1;
        }
      }
      for (const s of Object.values(stats)) {
        s.indicator = s.touches_scored - s.touches_received;
        s.victory_ratio = s.matches > 0 ? s.victories / s.matches : 0;
      }
      const poolRanked = Object.values(stats).sort((a, b) => {
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
      });
      poolRanked.forEach((s, i) => { s.position = pos + i; });
      ranked = ranked.concat(poolRanked);
      pos += poolRanked.length;
    }
    return ranked;
  }

  // Default: classic pool ranking across all pools
  const poolFencers = await models.PoolCompetitor.findAll({
    include: [
      { model: models.Competitor },
      { model: models.Pool, where: { phase_id: phaseId } }
    ]
  });
  const fencers = poolFencers.map(pc => pc.Competitor);
  const bouts = await models.Bout.findAll({
    where: {
      phase_id: phaseId,
      left_score: { [models.Sequelize.Op.not]: null },
      right_score: { [models.Sequelize.Op.not]: null }
    }
  });
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
    if (stats[bout.left_id]) {
      stats[bout.left_id].touches_scored += bout.left_score;
      stats[bout.left_id].touches_received += bout.right_score;
      stats[bout.left_id].matches += 1;
      if (bout.winner_id === bout.left_id) stats[bout.left_id].victories += 1;
    }
    if (stats[bout.right_id]) {
      stats[bout.right_id].touches_scored += bout.right_score;
      stats[bout.right_id].touches_received += bout.left_score;
      stats[bout.right_id].matches += 1;
      if (bout.winner_id === bout.right_id) stats[bout.right_id].victories += 1;
    }
  }
  for (const s of Object.values(stats)) {
    s.indicator = s.touches_scored - s.touches_received;
    s.victory_ratio = s.matches > 0 ? s.victories / s.matches : 0;
  }
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

module.exports = {
  calculatePoolRankings,
  loadRule,
  resolveRulePath
};
