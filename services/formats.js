'use strict';

const fs   = require('fs');
const path = require('path');
const db   = require('../db');

const FORMATS_DIR = path.join(__dirname, '..', 'formats');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadFormat(id) {
  if (!id) return null;
  const file = path.join(FORMATS_DIR, path.basename(id) + '.json');
  if (!fs.existsSync(file)) throw Object.assign(new Error('Format not found: ' + id), { status: 404 });
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function listFormats() {
  if (!fs.existsSync(FORMATS_DIR)) return [];
  return fs.readdirSync(FORMATS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        const fmt = JSON.parse(fs.readFileSync(path.join(FORMATS_DIR, f), 'utf8'));
        return {
          id:          fmt.id,
          description: fmt.description,
          params:      fmt.params || [],
          stages:      fmt.stages.map(s => ({ id: s.id, label: s.label, phaseType: s.phaseType })),
        };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => a.description.localeCompare(b.description));
}

function getStage(format, stageId) {
  return format.stages.find(s => s.id === stageId) || null;
}

function getStageIndex(format, stageId) {
  return format.stages.findIndex(s => s.id === stageId);
}

// ---------------------------------------------------------------------------
// Participant resolution
// ---------------------------------------------------------------------------

// Returns an ordered array of { competitor_id } for a given format stage.
// May assign initial_exempt cohort as a side effect (idempotent).
function resolveParticipants(compId, format, stage) {
  const p = stage.participants;

  // ── Final with multiple cohorts ──────────────────────────────────────────
  if (p.cohorts) {
    const result = [];
    for (const cohortSpec of p.cohorts) {
      const members = _resolveCohort(compId, cohortSpec);
      result.push(...members);
    }
    return result;
  }

  // ── Combined seeding (two-pool-rounds final) ─────────────────────────────
  if (p.seedingMethod === 'combined') {
    return _combinedSeeding(compId);
  }

  // ── Last pool seeding (single phase, active competitors only) ────────────
  if (p.seedingMethod === 'last_pool') {
    return _lastPoolSeeding(compId);
  }

  // ── Active remainder (participants who are active with no cohort yet) ─────
  if (p.source === 'active_remainder') {
    const poolStagePhase = _findPhaseByStage(compId, _findPrevPoolStageId(format, stage));
    if (poolStagePhase) {
      return db.prepare(`
        SELECT r.competitor_id
        FROM   rankings r
        JOIN   competitors c ON c.id = r.competitor_id
        WHERE  r.phase_id = ? AND c.format_cohort IS NULL AND c.status = 'active'
        ORDER  BY r.position ASC
      `).all(poolStagePhase.id);
    }
    // Fallback: no pool stage yet — return all active with no cohort
    return db.prepare(`
      SELECT id AS competitor_id FROM competitors
      WHERE competition_id = ? AND status = 'active' AND format_cohort IS NULL
      ORDER BY initial_seed ASC
    `).all(compId);
  }

  // ── Initial (all, or with top-N exclusion) ───────────────────────────────
  if (p.source === 'initial') {
    if (p.excludeTopByInitialSeed) {
      _ensureInitialExemptions(compId, p.excludeTopByInitialSeed, p.initialExemptCohort || 'initial_exempt');
    }
    return db.prepare(`
      SELECT id AS competitor_id FROM competitors
      WHERE competition_id = ? AND status = 'active' AND format_cohort IS NULL
      ORDER BY initial_seed ASC
    `).all(compId);
  }

  // ── Fallback: all active competitors ────────────────────────────────────
  return db.prepare(`
    SELECT id AS competitor_id FROM competitors
    WHERE competition_id = ? AND status = 'active'
    ORDER BY initial_seed ASC
  `).all(compId);
}

// Resolve one cohort spec for the final's multi-cohort participants
function _resolveCohort(compId, spec) {
  if (spec.cohort === 'initial_exempt') {
    return db.prepare(`
      SELECT id AS competitor_id FROM competitors
      WHERE competition_id = ? AND format_cohort = 'initial_exempt'
      ORDER BY initial_seed ASC
    `).all(compId);
  }

  // pool_exempt and de_survivors: sort by their position in the pool stage rankings
  const poolPhase = spec.poolStage ? _findPhaseByStage(compId, spec.poolStage) : null;
  if (poolPhase) {
    return db.prepare(`
      SELECT r.competitor_id
      FROM   rankings r
      JOIN   competitors c ON c.id = r.competitor_id
      WHERE  r.phase_id = ? AND c.format_cohort = ?
      ORDER  BY r.position ASC
    `).all(poolPhase.id, spec.cohort);
  }

  // Fallback: sort by initial_seed
  return db.prepare(`
    SELECT id AS competitor_id FROM competitors
    WHERE competition_id = ? AND format_cohort = ?
    ORDER BY initial_seed ASC
  `).all(compId, spec.cohort);
}

// Assign initial_exempt cohort to the top N active competitors by initial_seed.
// Idempotent: skips if already assigned.
function _ensureInitialExemptions(compId, n, cohort) {
  const already = db.prepare(
    "SELECT COUNT(*) AS cnt FROM competitors WHERE competition_id = ? AND format_cohort = ?"
  ).get(compId, cohort).cnt;
  if (already > 0) return;

  const top = db.prepare(`
    SELECT id FROM competitors
    WHERE competition_id = ? AND status = 'active' AND format_cohort IS NULL
    ORDER BY initial_seed ASC
    LIMIT ?
  `).all(compId, n);

  const stmt = db.prepare("UPDATE competitors SET format_cohort = ? WHERE id = ?");
  for (const c of top) stmt.run(cohort, c.id);
}

// Find the phase DB row for a given format_stage id, or null
function _findPhaseByStage(compId, stageId) {
  if (!stageId) return null;
  return db.prepare(
    'SELECT * FROM phases WHERE competition_id = ? AND format_stage = ?'
  ).get(compId, stageId) || null;
}

// Find the id of the most recent pool stage before the given stage in the format
function _findPrevPoolStageId(format, stage) {
  const idx = getStageIndex(format, stage.id);
  for (let i = idx - 1; i >= 0; i--) {
    if (format.stages[i].phaseType === 'pool') return format.stages[i].id;
  }
  return null;
}

// Seeding by the most recently finished pool phase; only active competitors included.
function _lastPoolSeeding(compId) {
  const last = db.prepare(`
    SELECT id FROM phases
    WHERE competition_id = ? AND type = 'pool' AND status = 'finished'
    ORDER BY phase_order DESC LIMIT 1
  `).get(compId);

  if (!last) {
    return db.prepare(`
      SELECT id AS competitor_id FROM competitors
      WHERE competition_id = ? AND status = 'active'
      ORDER BY initial_seed ASC
    `).all(compId);
  }

  return db.prepare(`
    SELECT r.competitor_id
    FROM   rankings r
    JOIN   competitors c ON c.id = r.competitor_id
    WHERE  r.phase_id = ? AND c.status = 'active'
    ORDER  BY r.position ASC
  `).all(last.id);
}

// Combined seeding across all finished pool phases (same logic as phases._combinedSeeding)
function _combinedSeeding(compId) {
  const finishedPhases = db.prepare(`
    SELECT id FROM phases
    WHERE competition_id = ? AND type = 'pool' AND status = 'finished'
    ORDER BY phase_order
  `).all(compId);

  if (!finishedPhases.length) {
    return db.prepare(`
      SELECT id AS competitor_id FROM competitors
      WHERE competition_id = ? AND status = 'active'
      ORDER BY initial_seed ASC
    `).all(compId);
  }

  const active = db.prepare(`
    SELECT id AS competitor_id, initial_seed FROM competitors
    WHERE competition_id = ? AND status = 'active'
  `).all(compId);

  const stats = {};
  for (const c of active) {
    stats[c.competitor_id] = {
      competitor_id: c.competitor_id,
      initial_seed:  c.initial_seed ?? 9999,
      victories: 0, matches: 0, touches_scored: 0, touches_received: 0,
    };
  }

  const phaseIds    = finishedPhases.map(p => p.id);
  const placeholders = phaseIds.map(() => '?').join(',');
  const bouts = db.prepare(`
    SELECT left_id, right_id, left_score, right_score, winner_id
    FROM bouts
    WHERE phase_id IN (${placeholders}) AND left_score IS NOT NULL AND right_score IS NOT NULL
  `).all(...phaseIds);

  for (const b of bouts) {
    if (stats[b.left_id]) {
      stats[b.left_id].matches++;
      stats[b.left_id].touches_scored   += b.left_score;
      stats[b.left_id].touches_received += b.right_score;
      if (b.winner_id === b.left_id) stats[b.left_id].victories++;
    }
    if (stats[b.right_id]) {
      stats[b.right_id].matches++;
      stats[b.right_id].touches_scored   += b.right_score;
      stats[b.right_id].touches_received += b.left_score;
      if (b.winner_id === b.right_id) stats[b.right_id].victories++;
    }
  }

  return Object.values(stats).map(s => ({
    ...s,
    indicator:     s.touches_scored - s.touches_received,
    victory_ratio: s.matches > 0 ? s.victories / s.matches : 0,
  })).sort((a, b) => {
    for (const fn of [
      () => b.victory_ratio   - a.victory_ratio,
      () => b.indicator       - a.indicator,
      () => b.touches_scored  - a.touches_scored,
      () => a.touches_received - b.touches_received,
      () => a.initial_seed    - b.initial_seed,
    ]) { const d = fn(); if (d !== 0) return d; }
    return 0;
  }).map(s => ({ competitor_id: s.competitor_id }));
}

// ---------------------------------------------------------------------------
// Pool stage close — assigns cohorts, handles no-elimination
// Called from Phase.close() when a pool phase has a format_stage.
// Returns the advanceN to use (how many to mark as advanced=1 in rankings).
// Side effects: writes format_cohort to competitors.
// ---------------------------------------------------------------------------
function applyPoolClose(compId, phaseId, rankings, format, stage) {
  const adv = stage.advancement || {};

  db.transaction(() => {
    if (adv.exemptTop) {
      const n      = adv.exemptTop;
      const cohort = adv.exemptCohort || 'pool_exempt';
      for (let i = 0; i < rankings.length; i++) {
        if (i < n) {
          db.prepare("UPDATE competitors SET format_cohort = ? WHERE id = ?")
            .run(cohort, rankings[i].competitor_id);
        }
      }
    }

    if (adv.noElimination) {
      for (const r of rankings) {
        db.prepare("UPDATE competitors SET status = 'active' WHERE id = ?").run(r.competitor_id);
      }
    }
  })();

  if (adv.noElimination) return rankings.length;

  // isFinalRanking: the level pools IS the result — no next phase, no elimination.
  // Return 0 so every ranking row gets advanced=0, signalling "final" to the results service.
  if (adv.isFinalRanking) return 0;

  // useParam: read advancement % from the competition's stored format_params.
  if (adv.useParam) {
    const comp    = db.prepare('SELECT format_params FROM competitions WHERE id = ?').get(compId);
    const stored  = comp?.format_params ? JSON.parse(comp.format_params) : {};
    const paramDef = (format.params || []).find(p => p.id === adv.useParam);
    const pct     = Number(stored[adv.useParam] ?? paramDef?.default ?? 70) / 100;
    const n       = rankings.length;
    return Math.max(0, Math.min(Math.round(n * pct), n));
  }

  return null;
}

// ---------------------------------------------------------------------------
// Preliminary DE close
// Identifies survivors (competitors with no loss in any bout), assigns the
// survivorCohort, eliminates the rest, and marks the phase finished.
// ---------------------------------------------------------------------------
function closeFormatDE(phaseId, survivorTarget, survivorCohort) {
  const phase = db.prepare('SELECT * FROM phases WHERE id = ?').get(phaseId);
  if (!phase) throw Object.assign(new Error('Phase not found.'), { status: 404 });
  if (phase.status === 'finished') throw Object.assign(new Error('Phase already finished.'), { status: 400 });

  // Determine the stopping round from tableau size and survivor target
  const tHalf = db.prepare(
    "SELECT COUNT(*) AS n FROM bouts WHERE phase_id = ? AND de_round = 1 AND bracket = 'main'"
  ).get(phaseId).n;
  const tableauSize   = tHalf * 2;
  const stoppingRound = Math.round(Math.log2(tableauSize / survivorTarget));

  // Verify stopping round is complete
  const pending = db.prepare(`
    SELECT COUNT(*) AS n FROM bouts
    WHERE phase_id = ? AND de_round <= ? AND bracket = 'main' AND status != 'finished'
      AND left_id IS NOT NULL AND right_id IS NOT NULL
  `).get(phaseId, stoppingRound).n;

  if (pending > 0) {
    throw Object.assign(
      new Error(`${pending} bout(s) still pending in rounds 1–${stoppingRound}. Complete all bouts before closing.`),
      { status: 400 }
    );
  }

  // All competitors who appear in round-1 bouts (the entry round) of this phase.
  // We use round 1 specifically so byes in round 1 count as participants.
  const all = db.prepare(`
    SELECT DISTINCT comp_id FROM (
      SELECT left_id  AS comp_id FROM bouts WHERE phase_id = ? AND de_round = 1 AND left_id  IS NOT NULL
      UNION
      SELECT right_id AS comp_id FROM bouts WHERE phase_id = ? AND de_round = 1 AND right_id IS NOT NULL
    )
  `).all(phaseId, phaseId).map(r => r.comp_id);

  // Those who lost a real bout in rounds 1..stoppingRound (not a bye — bye bouts have right_id NULL)
  const losers = db.prepare(`
    SELECT DISTINCT CASE WHEN winner_id = left_id THEN right_id ELSE left_id END AS comp_id
    FROM bouts
    WHERE phase_id = ? AND de_round <= ? AND status = 'finished' AND winner_id IS NOT NULL
      AND left_id IS NOT NULL AND right_id IS NOT NULL
  `).all(phaseId, stoppingRound).map(r => r.comp_id);

  const loserSet = new Set(losers);
  const survivors = all.filter(id => !loserSet.has(id));

  if (survivors.length !== survivorTarget) {
    throw Object.assign(
      new Error(`Expected ${survivorTarget} survivors but found ${survivors.length}.`),
      { status: 400 }
    );
  }

  const cohort = survivorCohort || 'de_survivors';

  db.transaction(() => {
    for (const id of survivors) {
      db.prepare("UPDATE competitors SET format_cohort = ? WHERE id = ?").run(cohort, id);
    }
    for (const id of losers) {
      db.prepare(`
        UPDATE competitors SET status = 'eliminated', eliminated_after = ?
        WHERE id = ? AND status = 'active'
      `).run(phaseId, id);
    }
    db.prepare("UPDATE phases SET status = 'finished' WHERE id = ?").run(phaseId);
  })();

  return { survivors: survivors.length, eliminated: losers.length };
}

// ---------------------------------------------------------------------------
// Validate that participant counts work for the format
// Throws with a human-readable message if the format cannot run.
// ---------------------------------------------------------------------------
function validateCounts(compId, format) {
  const N = db.prepare(
    "SELECT COUNT(*) AS n FROM competitors WHERE competition_id = ? AND status = 'active'"
  ).get(compId).n;

  for (const stage of format.stages) {
    const p   = stage.participants;
    const adv = stage.advancement || {};

    if (p.excludeTopByInitialSeed) {
      const excluded = p.excludeTopByInitialSeed;
      const inPools  = N - excluded;
      if (inPools < 2) {
        throw Object.assign(
          new Error(`Format "${format.description}" requires more than ${excluded} competitors for the preliminary pool round (currently ${N} total).`),
          { status: 400 }
        );
      }
      if (adv.survivorTarget) {
        const inDE = inPools - (adv.exemptTop || 0);
        if (inDE < adv.survivorTarget) {
          throw Object.assign(
            new Error(`Format "${format.description}" needs at least ${excluded + (adv.exemptTop || 0) + adv.survivorTarget} competitors for the preliminary tableau to produce ${adv.survivorTarget} survivors (currently ${N}).`),
            { status: 400 }
          );
        }
      }
    }

    if (adv.survivorTarget) {
      // Check the preceding pool stage produces enough remainder for the prelim DE.
      const prevPool = format.stages.find(s => s.id !== stage.id && s.phaseType === 'pool');
      if (prevPool) {
        const excluded  = prevPool.participants.excludeTopByInitialSeed || 0;
        const exemptTop = prevPool.advancement?.exemptTop || 0;
        const noElim    = prevPool.advancement?.noElimination || false;
        const inPools   = N - excluded;
        // If pools eliminate, estimate how many advance using the rule's percentage.
        let advFromPools = inPools;
        if (!noElim && prevPool.rule) {
          try {
            const poolRule = require('../rules/' + prevPool.rule);
            const pct = (poolRule.advancement?.value ?? 70) / 100;
            advFromPools = Math.round(inPools * pct);
          } catch {}
        }
        const inDE = advFromPools - exemptTop;
        if (inDE < adv.survivorTarget) {
          throw Object.assign(
            new Error(`Format "${format.description}": with ${N} competitors, the preliminary tableau would have only ~${inDE} fencers — not enough to produce ${adv.survivorTarget} survivors.`),
            { status: 400 }
          );
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Format plan — returns stage statuses + projected participant counts
// ---------------------------------------------------------------------------
function getFormatPlan(compId, format) {
  const phases = db.prepare(
    'SELECT id, format_stage, type, status FROM phases WHERE competition_id = ? ORDER BY phase_order'
  ).all(compId);

  const phaseByStage = {};
  for (const ph of phases) {
    if (ph.format_stage) phaseByStage[ph.format_stage] = ph;
  }

  const N = db.prepare(
    "SELECT COUNT(*) AS n FROM competitors WHERE competition_id = ? AND status IN ('active','eliminated')"
  ).get(compId).n;

  const stages = format.stages.map(stage => {
    const ph = phaseByStage[stage.id] || null;
    return {
      id:               stage.id,
      label:            stage.label,
      phaseType:        stage.phaseType,
      rule:             stage.rule,
      status:           ph ? ph.status : 'pending',
      phaseId:          ph ? ph.id     : null,
      participantCount: _estimateCount(compId, format, stage, N),
      survivorTarget:   stage.advancement?.survivorTarget || null,
    };
  });

  const nextStage = stages.find(s => s.status === 'pending') || null;
  const currentStage = stages.find(s => s.status === 'active') || null;

  return {
    format:         { id: format.id, description: format.description },
    stages,
    currentStageId: currentStage?.id || null,
    nextStageId:    nextStage?.id    || null,
  };
}

function _estimateCount(compId, format, stage, totalN) {
  const p   = stage.participants;
  const adv = stage.advancement || {};

  if (p.cohorts) {
    let total = 0;
    for (const c of p.cohorts) {
      const cnt = db.prepare(
        "SELECT COUNT(*) AS n FROM competitors WHERE competition_id = ? AND format_cohort = ?"
      ).get(compId, c.cohort).n;
      total += cnt;
    }
    if (total > 0) return total;
    // Estimate from format shape
    const gp = format.stages[0];
    const ex = (gp.participants.excludeTopByInitialSeed || 0) + (gp.advancement?.exemptTop || 0);
    const st = format.stages[1]?.advancement?.survivorTarget || 0;
    return (gp.participants.excludeTopByInitialSeed || 0) + (gp.advancement?.exemptTop || 0) + st;
  }

  if (p.source === 'active_remainder') {
    // Count from DB if cohorts are assigned, else estimate
    const actual = db.prepare(
      "SELECT COUNT(*) AS n FROM competitors WHERE competition_id = ? AND status = 'active' AND format_cohort IS NULL"
    ).get(compId).n;
    if (actual > 0) return actual;
    const prevPool = format.stages.find(s => s.phaseType === 'pool');
    const ex = (prevPool?.participants?.excludeTopByInitialSeed || 0) + (prevPool?.advancement?.exemptTop || 0);
    return Math.max(0, totalN - ex);
  }

  if (p.source === 'initial') {
    const ex = p.excludeTopByInitialSeed || 0;
    return Math.max(0, totalN - ex);
  }

  if (p.seedingMethod === 'combined' || p.seedingMethod === 'last_pool') {
    return db.prepare(
      "SELECT COUNT(*) AS n FROM competitors WHERE competition_id = ? AND status = 'active'"
    ).get(compId).n;
  }

  return totalN;
}

// ---------------------------------------------------------------------------
// Validate stage ordering: is this the next expected stage in the format?
// Throws if not.
// ---------------------------------------------------------------------------
function assertNextStage(compId, format, stageId) {
  const phases = db.prepare(
    'SELECT format_stage, status FROM phases WHERE competition_id = ? ORDER BY phase_order'
  ).all(compId);

  const completedStages = new Set(
    phases.filter(p => p.format_stage).map(p => p.format_stage)
  );

  const stageIndex = getStageIndex(format, stageId);
  if (stageIndex < 0) {
    throw Object.assign(new Error(`Stage "${stageId}" not found in format "${format.id}".`), { status: 400 });
  }

  // Every stage before this one must be completed
  for (let i = 0; i < stageIndex; i++) {
    const prev = format.stages[i];
    if (!completedStages.has(prev.id)) {
      throw Object.assign(
        new Error(`Stage "${prev.label}" must be completed before creating "${format.stages[stageIndex].label}".`),
        { status: 400 }
      );
    }
    const prevPhase = phases.find(p => p.format_stage === prev.id);
    if (prevPhase && prevPhase.status !== 'finished') {
      throw Object.assign(
        new Error(`Stage "${prev.label}" must be finished before creating "${format.stages[stageIndex].label}".`),
        { status: 400 }
      );
    }
  }
}

module.exports = {
  loadFormat,
  listFormats,
  getStage,
  resolveParticipants,
  applyPoolClose,
  closeFormatDE,
  validateCounts,
  getFormatPlan,
  assertNextStage,
};
