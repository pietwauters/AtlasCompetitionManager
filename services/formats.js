'use strict';

const fs   = require('fs');
const path = require('path');
const db   = require('../db');
const { loadRule } = require('../lib/rules');

const FORMATS_DIR  = path.join(__dirname, '..', 'formats');
const CATALOG_FILE = path.join(FORMATS_DIR, 'catalog.json');

const shapeCache     = new Map();
let   catalogCache   = null;
let   formatListCache = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Load a raw formats/*.json shape file by its own id (unchanged mechanism —
// never renamed, so any pre-existing competitions.format_id referencing a
// shape id directly keeps working with no migration).
function loadShape(id) {
  if (!id) return null;
  if (shapeCache.has(id)) return shapeCache.get(id);
  const file = path.join(FORMATS_DIR, path.basename(id) + '.json');
  if (!fs.existsSync(file)) throw Object.assign(new Error('Format not found: ' + id), { status: 404 });
  const fmt = JSON.parse(fs.readFileSync(file, 'utf8'));
  shapeCache.set(id, fmt);
  return fmt;
}

// formats/catalog.json — named, taggable entries that alias a shape. Multiple
// entries may point at the same shape (e.g. Worlds/World Cup/Grand Prix all
// alias "grand-prix-fie" per FIE o.83). See docs/format-system-comparison.md §7-8.
function loadCatalog() {
  if (catalogCache) return catalogCache;
  catalogCache = fs.existsSync(CATALOG_FILE)
    ? JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'))
    : [];
  return catalogCache;
}

function resolveCatalogEntry(id) {
  return loadCatalog().find(e => e.id === id) || null;
}

// ---------------------------------------------------------------------------
// Plain-language pipeline description — computed from live stage/rule data,
// never hand-written, so it can't drift out of sync with what a format
// actually does. This is the "mechanical" half of a catalog entry's
// description; `why` in catalog.json (hand-written, human-reviewed) is the
// other half — see docs/format-system-comparison.md §11.
// ---------------------------------------------------------------------------

function _describeParticipants(stage) {
  const p = stage.participants || {};
  if (p.cohorts) {
    return 'combines: ' + p.cohorts.map(c => c.cohort.replace(/_/g, ' ')).join(', ');
  }
  if (p.seedingMethod === 'combined') return 'seeded by combined stats across every finished pool round';
  if (p.seedingMethod === 'last_pool') return "seeded by the most recent pool round's ranking";
  if (p.source === 'active_remainder') return 'everyone still active with no cohort assigned yet';
  if (p.source === 'rank_range') {
    const basis = p.basedOn === 'last_pool' ? 'pool result' : 'initial seed';
    const range = p.to == null ? `rank ${p.from} and below` : `ranks ${p.from}-${p.to}`;
    return `${range}, by ${basis}`;
  }
  if (p.source === 'initial') {
    return p.excludeTopByInitialSeed
      ? `everyone except the top ${p.excludeTopByInitialSeed} by initial seed (who are exempt from this stage)`
      : 'everyone, by initial seed';
  }
  return 'all active competitors';
}

function _describeStageAdvancement(stage) {
  const adv = stage.advancement || {};
  if (adv.noElimination) return 'no one is eliminated';
  if (adv.isFinalRanking) return 'this round IS the final ranking, no further stage';
  if (adv.exemptTop) return `top ${adv.exemptTop} by result are exempted from the next stage`;
  if (adv.survivorTarget) return `runs until ${adv.survivorTarget} survivors remain`;
  if (adv.useParam) return 'advancement % is chosen when the format is applied';
  return null;
}

function _describeRuleAdvancement(ruleDoc) {
  try {
    const a = loadRule(ruleDoc).advancement;
    if (!a) return null;
    if (a.method === 'count') return `top ${a.value} advance`;
    if (a.method === 'multiple') return `advances to a multiple of ${a.multipleOf}`;
    return `top ${a.value ?? 70}% advance`;
  } catch { return null; }
}

function _describeDeRule(ruleDoc) {
  try {
    const rule = loadRule(ruleDoc);
    const parts = [];
    if (rule.repechage?.enabled) {
      parts.push(`repechage — losers get a second chance and rejoin the main survivors at a tableau of ${rule.repechage.reentryAt}`);
    }
    if (rule.placement?.allPlacesFenced) {
      parts.push(`every place from ${rule.placement.allPlacesFenced}th downward is decided by an actual bout, not shared`);
    } else if (rule.placement?.thirdPlaceBout === false) {
      parts.push('no bronze bout — semifinal losers share 3rd');
    } else if (rule.placement?.thirdPlaceBout) {
      parts.push('bronze bout for 3rd place');
    }
    return parts.join('; ') || null;
  } catch { return null; }
}

function _describeStage(stage) {
  const who = _describeParticipants(stage);
  if (stage.phaseType === 'pool') {
    const adv = _describeStageAdvancement(stage) || _describeRuleAdvancement(stage.rule) || 'advancement per the pool rule';
    return `${stage.label} (${who}; ${adv})`;
  }
  if (stage.phaseType === 'de') {
    const deInfo = _describeDeRule(stage.rule);
    return `${stage.label} (${who}${deInfo ? '; ' + deInfo : ''})`;
  }
  return stage.label;
}

// Groups stages into dependency "waves" — a wave is every stage whose
// dependencies are all satisfied by earlier waves. Two stages in the same
// wave run independently of each other (neither is a prerequisite of the
// other), even if they happen to sit next to each other in the JSON array —
// this is what stops Division 1 / Division 2 from being described as if
// Division 2 happens "after" Division 1, when they're actually parallel.
function _computeWaves(format) {
  const waves = [];
  const placed = new Set();
  let remaining = [...format.stages];
  while (remaining.length) {
    const wave = remaining.filter(s => _stageDependencies(format, s).every(d => placed.has(d)));
    if (!wave.length) { waves.push(remaining); break; } // malformed dependsOn — surface the rest rather than loop forever
    waves.push(wave);
    wave.forEach(s => placed.add(s.id));
    remaining = remaining.filter(s => !wave.includes(s));
  }
  return waves;
}

// Public: full pipeline in plain language, e.g.
// "1. Pool Round (everyone, by initial seed; top 70% advance)  →  2. Direct Elimination (seeded by the most recent pool round's ranking; bronze bout for 3rd place)"
// Independent/parallel stages (see _computeWaves) share one step number,
// joined with "•" and flagged explicitly instead of implying sequence.
function describePipeline(format) {
  return _computeWaves(format).map((wave, i) => {
    const step = wave.length > 1
      ? wave.map(s => _describeStage(s)).join('  •  ') + '  [independently — neither is a prerequisite of the other]'
      : _describeStage(wave[0]);
    return `${i + 1}. ${step}`;
  }).join('  →  ');
}

// Resolve a catalog entry into a full format object: the shape's stages
// unchanged, params with paramOverrides applied to their `default`, and the
// catalog entry's own id/label/tags in place of the shape's own.
function resolveCatalogFormat(entry) {
  const shape  = loadShape(entry.shape);
  const params = (shape.params || []).map(p => {
    const override = entry.paramOverrides && entry.paramOverrides[p.id];
    return override === undefined ? p : { ...p, default: override };
  });
  return {
    id:           entry.id,
    description:  entry.label,
    scope:        entry.scope,
    eventType:    entry.eventType,
    tier:         entry.tier,
    ageCategory:  entry.ageCategory,
    ruleRefs:     entry.ruleRefs,
    note:         entry.note,
    why:          entry.why || null,
    mechanics:    describePipeline(shape),
    params,
    stages:       shape.stages,
  };
}

function loadFormat(id) {
  if (!id) return null;
  const entry = resolveCatalogEntry(id);
  if (entry) return resolveCatalogFormat(entry);
  // Not a catalog id — fall back to treating it as a raw shape id directly,
  // exactly as before the catalog existed.
  return loadShape(id);
}

function listFormats() {
  if (formatListCache) return formatListCache;
  if (!fs.existsSync(FORMATS_DIR)) return [];

  const catalog       = loadCatalog();
  const cataloguedIds = new Set(catalog.map(e => e.shape));

  const catalogueEntries = catalog.map(entry => {
    try {
      const fmt = resolveCatalogFormat(entry);
      return {
        id:          fmt.id,
        description: fmt.description,
        scope:       fmt.scope,
        eventType:   fmt.eventType,
        tier:        fmt.tier,
        ageCategory: fmt.ageCategory,
        ruleRefs:    fmt.ruleRefs,
        note:        fmt.note,
        why:         fmt.why,
        mechanics:   fmt.mechanics,
        params:      fmt.params || [],
        stages:      fmt.stages.map(s => ({ id: s.id, label: s.label, phaseType: s.phaseType })),
      };
    } catch { return null; }
  }).filter(Boolean);

  // Any shape file with no catalog entry pointing at it is a self-authored,
  // custom format — surface it automatically, same as before the catalog
  // existed, tagged so the UI can group it separately.
  const customEntries = fs.readdirSync(FORMATS_DIR)
    .filter(f => f.endsWith('.json') && f !== 'catalog.json')
    .map(f => f.slice(0, -5))
    .filter(id => !cataloguedIds.has(id))
    .map(id => {
      try {
        const fmt = loadShape(id);
        return {
          id:          fmt.id,
          description: fmt.description,
          scope:       'custom',
          eventType:   null,
          tier:        null,
          ageCategory: null,
          ruleRefs:    null,
          note:        null,
          why:         null,
          mechanics:   describePipeline(fmt),
          params:      fmt.params || [],
          stages:      fmt.stages.map(s => ({ id: s.id, label: s.label, phaseType: s.phaseType })),
        };
      } catch { return null; }
    })
    .filter(Boolean);

  const scopeOrder = { fie: 0, club: 1, custom: 2 };
  formatListCache = [...catalogueEntries, ...customEntries]
    .sort((a, b) => (scopeOrder[a.scope] ?? 9) - (scopeOrder[b.scope] ?? 9)
      || a.description.localeCompare(b.description));
  return formatListCache;
}

function getStage(format, stageId) {
  return format.stages.find(s => s.id === stageId) || null;
}

function getStageIndex(format, stageId) {
  return format.stages.findIndex(s => s.id === stageId);
}

// Stage prerequisites. Default (dependsOn absent) = the single immediately-
// preceding stage in the array — every format shipped before parallel tracks
// existed relies on this and must keep getting exactly this list. An explicit
// `dependsOn` (including `[]`) overrides it — `[]` means "no prerequisite,"
// which is how independent parallel tracks (e.g. Division 1 / Division 2)
// both become available at once instead of gating on each other.
function _stageDependencies(format, stage) {
  if (stage.dependsOn !== undefined) return stage.dependsOn;
  const idx = getStageIndex(format, stage.id);
  return idx > 0 ? [format.stages[idx - 1].id] : [];
}

// Stages nothing else depends on — for a linear format, that's the single
// final stage (same as today's "last DE phase" assumption in results.js).
// For independent parallel tracks (Division 1 / Division 2), it's every
// track's own final stage — results.js merges one ranking per terminal stage.
function getTerminalStages(format) {
  const dependedUpon = new Set();
  for (const stage of format.stages) {
    for (const dep of _stageDependencies(format, stage)) dependedUpon.add(dep);
  }
  return format.stages.filter(s => !dependedUpon.has(s.id)).map(s => s.id);
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
    // Fallback: no pool stage yet — return all present with no cohort
    return db.prepare(`
      SELECT id AS competitor_id FROM competitors
      WHERE competition_id = ? AND status = 'active' AND checked_in = 1 AND format_cohort IS NULL
      ORDER BY initial_seed ASC
    `).all(compId);
  }

  // ── Rank range (independent parallel tracks, e.g. Division 1 / Division 2) ──
  // Slices active competitors by initial_seed, 1-indexed inclusive. `to: null`
  // means open-ended (rest of the field). Reads the seed number directly —
  // matches Engarde's own "classement_initial N-M" semantics exactly.
  if (p.source === 'rank_range') {
    const from = p.from ?? 1;

    // basedOn: "last_pool" — split by pool *result* (rankings.position from the
    // most recently finished pool phase) instead of pre-competition seed. Same
    // rank_range concept, different ranking to slice — e.g. a pool round used
    // purely to sort the field before splitting into independent divisions
    // (an "Elite Division" / "Division 1" split by pool performance, not by
    // initial seed).
    if (p.basedOn === 'last_pool') {
      const lastPool = db.prepare(`
        SELECT id FROM phases
        WHERE competition_id = ? AND type = 'pool' AND status = 'finished'
        ORDER BY phase_order DESC LIMIT 1
      `).get(compId);
      if (!lastPool) {
        throw Object.assign(
          new Error('This stage needs a finished pool phase before it can split by pool result.'),
          { status: 400 }
        );
      }
      if (p.to == null) {
        return db.prepare(`
          SELECT r.competitor_id FROM rankings r
          JOIN   competitors c ON c.id = r.competitor_id
          WHERE  r.phase_id = ? AND c.status = 'active' AND r.position >= ?
          ORDER  BY r.position ASC
        `).all(lastPool.id, from);
      }
      return db.prepare(`
        SELECT r.competitor_id FROM rankings r
        JOIN   competitors c ON c.id = r.competitor_id
        WHERE  r.phase_id = ? AND c.status = 'active' AND r.position BETWEEN ? AND ?
        ORDER  BY r.position ASC
      `).all(lastPool.id, from, p.to);
    }

    if (p.to == null) {
      return db.prepare(`
        SELECT id AS competitor_id FROM competitors
        WHERE competition_id = ? AND status = 'active' AND checked_in = 1 AND initial_seed >= ?
        ORDER BY initial_seed ASC
      `).all(compId, from);
    }
    return db.prepare(`
      SELECT id AS competitor_id FROM competitors
      WHERE competition_id = ? AND status = 'active' AND checked_in = 1 AND initial_seed BETWEEN ? AND ?
      ORDER BY initial_seed ASC
    `).all(compId, from, p.to);
  }

  // ── Initial (all, or with top-N exclusion) ───────────────────────────────
  if (p.source === 'initial') {
    if (p.excludeTopByInitialSeed) {
      _ensureInitialExemptions(compId, p.excludeTopByInitialSeed, p.initialExemptCohort || 'initial_exempt');
    }
    return db.prepare(`
      SELECT id AS competitor_id FROM competitors
      WHERE competition_id = ? AND status = 'active' AND checked_in = 1 AND format_cohort IS NULL
      ORDER BY initial_seed ASC
    `).all(compId);
  }

  // ── Fallback: all present competitors ───────────────────────────────────
  return db.prepare(`
    SELECT id AS competitor_id FROM competitors
    WHERE competition_id = ? AND status = 'active' AND checked_in = 1
    ORDER BY initial_seed ASC
  `).all(compId);
}

// FIE o.87.2 / o.102.1 "drawing lots in pairs": within a ranked cohort, adjacent rank
// pairs (1st&2nd, 3rd&4th, ...) always land on adjacent seed numbers, which are always
// siblings from the same tier split in buildSeedPositions — equally difficult bracket
// slots, just not identical. FIE draws lots per pair to decide which entrant gets the
// lower seed rather than fixing it by rank. Odd one out (odd cohort size) keeps its slot.
// See docs/format-system-comparison.md §5 for the full derivation.
function _pairedLotDraw(rows) {
  const out = [...rows];
  for (let i = 0; i + 1 < out.length; i += 2) {
    if (Math.random() < 0.5) [out[i], out[i + 1]] = [out[i + 1], out[i]];
  }
  return out;
}

// Resolve one cohort spec for the final's multi-cohort participants
function _resolveCohort(compId, spec) {
  let rows;

  if (spec.cohort === 'initial_exempt') {
    rows = db.prepare(`
      SELECT id AS competitor_id FROM competitors
      WHERE competition_id = ? AND format_cohort = 'initial_exempt'
      ORDER BY initial_seed ASC
    `).all(compId);
  } else {
    // pool_exempt and de_survivors: sort by their position in the pool stage rankings
    const poolPhase = spec.poolStage ? _findPhaseByStage(compId, spec.poolStage) : null;
    if (poolPhase) {
      rows = db.prepare(`
        SELECT r.competitor_id
        FROM   rankings r
        JOIN   competitors c ON c.id = r.competitor_id
        WHERE  r.phase_id = ? AND c.format_cohort = ?
        ORDER  BY r.position ASC
      `).all(poolPhase.id, spec.cohort);
    } else {
      // Fallback: sort by initial_seed
      rows = db.prepare(`
        SELECT id AS competitor_id FROM competitors
        WHERE competition_id = ? AND format_cohort = ?
        ORDER BY initial_seed ASC
      `).all(compId, spec.cohort);
    }
  }

  return spec.pairedLotDraw ? _pairedLotDraw(rows) : rows;
}

// Assign initial_exempt cohort to the top N present competitors by initial_seed.
// Idempotent: skips if already assigned.
function _ensureInitialExemptions(compId, n, cohort) {
  const already = db.prepare(
    "SELECT COUNT(*) AS cnt FROM competitors WHERE competition_id = ? AND format_cohort = ?"
  ).get(compId, cohort).cnt;
  if (already > 0) return;

  const top = db.prepare(`
    SELECT id FROM competitors
    WHERE competition_id = ? AND status = 'active' AND checked_in = 1 AND format_cohort IS NULL
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
      WHERE competition_id = ? AND status = 'active' AND checked_in = 1
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
      WHERE competition_id = ? AND status = 'active' AND checked_in = 1
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
    "SELECT COUNT(*) AS n FROM competitors WHERE competition_id = ? AND status = 'active' AND checked_in = 1"
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

  // A pending stage is "next" when every stage it depends on (see
  // _stageDependencies — defaults to the single preceding stage) is finished.
  // For a linear format this is still exactly one stage; independent parallel
  // tracks (dependsOn: []) can each be ready at the same time.
  const nextStages = format.stages
    .filter(stage => {
      const s = stages.find(x => x.id === stage.id);
      if (s.status !== 'pending') return false;
      const deps = _stageDependencies(format, stage);
      return deps.every(depId => phaseByStage[depId]?.status === 'finished');
    })
    .map(stage => stages.find(x => x.id === stage.id));

  const currentStage = stages.find(s => s.status === 'active') || null;

  return {
    format:         { id: format.id, description: format.description },
    stages,
    currentStageId: currentStage?.id   || null,
    nextStageId:    nextStages[0]?.id  || null,
    nextStages,
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

  const stageIndex = getStageIndex(format, stageId);
  if (stageIndex < 0) {
    throw Object.assign(new Error(`Stage "${stageId}" not found in format "${format.id}".`), { status: 400 });
  }

  // Every stage this one depends on must be completed and finished. Default
  // dependency (no explicit dependsOn) is the single preceding stage — same
  // check as before, just expressed generically. See _stageDependencies.
  const deps = _stageDependencies(format, format.stages[stageIndex]);
  for (const depId of deps) {
    const dep = getStage(format, depId);
    const depPhase = phases.find(p => p.format_stage === depId);
    if (!depPhase) {
      throw Object.assign(
        new Error(`Stage "${dep?.label || depId}" must be completed before creating "${format.stages[stageIndex].label}".`),
        { status: 400 }
      );
    }
    if (depPhase.status !== 'finished') {
      throw Object.assign(
        new Error(`Stage "${dep?.label || depId}" must be finished before creating "${format.stages[stageIndex].label}".`),
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
  getTerminalStages,
};
