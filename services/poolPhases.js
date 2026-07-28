'use strict';

// Pool-phase-specific logic, split out of services/phases.js (2026-07-28
// architecture review — that file had grown into a 928-line god service).
// services/phases.js is the orchestrator: it re-exports calcOptions/create/
// calculateRankings from here directly, and owns the genuinely-shared or
// mixed-logic functions (close, simulate, reopen, delete, findById,
// findByCompetition) that branch on phase.type or are invoked generically
// regardless of type. See services/dePhases.js for the DE-side split.

const db             = require('../db');
const { loadRule }   = require('../lib/rules');
const { formPools, calcPoolOptions } = require('../lib/poolFormation');
const Competitor     = require('./competitors');
const Format         = require('./formats');
const Bout           = require('./bouts');
const Settings       = require('./settings');

const DEFAULT_CRITERIA = [
  'victory_ratio_desc', 'indicator_desc',
  'touches_scored_desc', 'touches_received_asc', 'initial_seed_asc',
];

// ---------------------------------------------------------------------------
// Prepared statements — module-level constants (see CLAUDE.md's hard rule;
// hoisted as part of this split rather than before it, so each query only
// has to move once).
// ---------------------------------------------------------------------------
const stmtPhaseById         = db.prepare('SELECT * FROM phases WHERE id = ?');
const stmtCompFormatId      = db.prepare('SELECT format_id FROM competitions WHERE id = ?');
const stmtMaxPhaseOrder     = db.prepare('SELECT COALESCE(MAX(phase_order), 0) AS m FROM phases WHERE competition_id = ?');
const stmtLastPhaseStatus   = db.prepare('SELECT status FROM phases WHERE competition_id = ? ORDER BY phase_order DESC LIMIT 1');
const stmtInsertPoolPhase   = db.prepare(`
  INSERT INTO phases (competition_id, phase_order, type, rule_doc, status, format_stage)
  VALUES (@comp_id, @order, 'pool', @rule_doc, 'active', @format_stage)
`);
const stmtInsertPool        = db.prepare(`INSERT INTO pools (phase_id, pool_number, status) VALUES (?, ?, 'active')`);
const stmtInsertPoolCompetitor = db.prepare('INSERT INTO pool_competitors (pool_id, competitor_id, pool_slot) VALUES (?, ?, ?)');
const stmtInsertPoolBout    = db.prepare(`
  INSERT INTO bouts (phase_id, pool_id, left_id, right_id, status, bout_order)
  VALUES (?, ?, ?, ?, 'pending', ?)
`);

const stmtPrevFinishedPool  = db.prepare(`
  SELECT id FROM phases
  WHERE competition_id = ? AND type = 'pool' AND status = 'finished'
  ORDER BY phase_order DESC LIMIT 1
`);
const stmtAdvancedRankingsForPhase = db.prepare(
  'SELECT competitor_id, position FROM rankings WHERE phase_id = ? AND advanced = 1'
);

const stmtPoolCompetitorRows = db.prepare(`
  SELECT DISTINCT pc.competitor_id, c.initial_seed,
    c.first_name, c.last_name, c.nationality,
    cl.name AS club_name,
    ph.pool_number
  FROM pool_competitors pc
  JOIN pools ph ON ph.id = pc.pool_id AND ph.phase_id = ?
  JOIN competitors c ON c.id = pc.competitor_id
  LEFT JOIN people p  ON p.id  = c.person_id
  LEFT JOIN clubs  cl ON cl.id = p.club_id
`);
const stmtFinishedBouts = db.prepare(`
  SELECT left_id, right_id, left_score, right_score, winner_id
  FROM bouts WHERE phase_id = ? AND left_score IS NOT NULL AND right_score IS NOT NULL
`);
const stmtPrevPoolPhaseBeforeOrder = db.prepare(`
  SELECT id FROM phases
  WHERE competition_id = ? AND type = 'pool' AND phase_order < ?
  ORDER BY phase_order DESC LIMIT 1
`);
const stmtAllRankingsForPhase = db.prepare('SELECT competitor_id, position FROM rankings WHERE phase_id = ?');

// ---------------------------------------------------------------------------
// Returns a Map<competitor_id, rank> from the most recent finished pool phase.
// Used to seed a subsequent pool phase from real results rather than from the
// original pre-competition seed numbers.
// ---------------------------------------------------------------------------
function getPrevPoolRankings(compId) {
  const prev = stmtPrevFinishedPool.get(compId);
  if (!prev) return new Map();
  const rows = stmtAdvancedRankingsForPhase.all(prev.id);
  return new Map(rows.map(r => [r.competitor_id, r.position]));
}

const PoolPhases = {
  // ---------------------------------------------------------------------------
  // Pool options — tell the UI what pool size configurations are possible.
  // Returns { options, recommended, fencerCount } where recommended is the
  // index of the default choice (equal-size pool if N divisible by 6 or 7).
  // formatStageId: when provided, participant count is derived from the format.
  // ---------------------------------------------------------------------------
  calcOptions(compId, ruleDoc, formatStageId = null) {
    const rule = loadRule(ruleDoc);

    let N;
    if (formatStageId) {
      const comp = stmtCompFormatId.get(compId);
      if (comp?.format_id) {
        const format = Format.loadFormat(comp.format_id);
        const stage  = Format.getStage(format, formatStageId);
        if (stage) {
          const participants = Format.resolveParticipants(compId, format, stage);
          N = participants.length;
        }
      }
    }

    if (!N) {
      const competitors = Competitor.findAll(compId).filter(c => c.competitor_status === 'active' && c.checked_in === 1);
      N = competitors.length;
    }

    if (N < 2) throw Object.assign(new Error('At least 2 present competitors required.'), { status: 400 });

    const options = calcPoolOptions(N, rule.poolFormation);

    // Recommended: first uniform (equal-size) option if one exists, otherwise index 0.
    // calcPoolOptions already sorts uniform before mixed, so index 0 is usually best.
    const recIdx = options.findIndex(o => o.every(s => s === o[0]));
    const recommended = recIdx >= 0 ? recIdx : 0;

    return { options, recommended, fencerCount: N, ruleDoc };
  },

  // ---------------------------------------------------------------------------
  // Create pool phase: insert phase + pools + pool_competitors + bouts.
  // chosenSizes: sorted-desc array, e.g. [7, 7, 6]
  // separation: optional override array, e.g. ['club'] or ['nationality','club']
  //             replaces the value from the rule JSON.
  // formatStageId: when provided, participants come from the format definition.
  // ---------------------------------------------------------------------------
  create(compId, ruleDoc, chosenSizes, separation, formatStageId = null) {
    const rule       = loadRule(ruleDoc);
    if (Array.isArray(separation)) rule.poolFormation.separation = separation;

    // Resolve participants — format-aware or all active
    let competitors;
    let resolvedFormat = null;
    let resolvedStage  = null;
    if (formatStageId) {
      const comp = stmtCompFormatId.get(compId);
      if (comp?.format_id) {
        resolvedFormat = Format.loadFormat(comp.format_id);
        resolvedStage  = Format.getStage(resolvedFormat, formatStageId);
        Format.assertNextStage(compId, resolvedFormat, formatStageId);
        const participants = Format.resolveParticipants(compId, resolvedFormat, resolvedStage);
        // findAll returns full rows; we need to re-fetch details for the participant ids
        const ids   = participants.map(p => p.competitor_id);
        const all   = Competitor.findAll(compId);
        competitors = all.filter(c => ids.includes(c.competitor_id));
      }
    }

    // Only competitors explicitly marked present (checkin.html) are entered —
    // a fencer who was never checked in (or explicitly marked absent/withdrawn)
    // never appears in a phase, even if their competitor status is still
    // 'active'. Applies uniformly to every manually-created pool round, not
    // just the first — a survivor of an earlier round is already checked_in=1
    // from having been included then, so this never re-excludes anyone
    // legitimately still in the competition.
    if (!competitors) {
      competitors = Competitor.findAll(compId).filter(c => c.competitor_status === 'active' && c.checked_in === 1);
    }

    if (!competitors.length) {
      throw Object.assign(
        new Error('No present competitors. Mark fencers present on the check-in page before creating a round.'),
        { status: 400 }
      );
    }

    // If a previous pool phase exists, use its rankings as the seed order so
    // that round 2 (and beyond) serpentine-seeds from the actual results of
    // the preceding round rather than from the original pre-competition seed.
    const prevRankings = getPrevPoolRankings(compId);

    // Map competitors to the shape expected by formPools / boutOrder
    const fencerInput = competitors.map(c => ({
      id:            c.competitor_id,
      competitor_id: c.competitor_id,
      initial_seed:  prevRankings.get(c.competitor_id) ?? c.initial_seed,
      nationality:   c.nationality,
      club:          c.club_name,
      first_name:    c.first_name,
      last_name:     c.last_name,
    }));

    const pools = formPools(fencerInput, chosenSizes, rule.poolFormation);

    const phaseId = db.transaction(() => {
      const maxOrder = stmtMaxPhaseOrder.get(compId).m;

      // Legacy "at most one active phase" lock — skipped when a format has
      // already validated this stage's real prerequisites via assertNextStage
      // above (independent parallel tracks, e.g. Division 1 / Division 2, can
      // then have more than one simultaneously-active phase). Free-form
      // (no format) creation keeps the simple sequential lock.
      if (maxOrder > 0 && !resolvedFormat) {
        const prev = stmtLastPhaseStatus.get(compId);
        if (prev && prev.status !== 'finished') {
          throw Object.assign(new Error('Previous phase must be finished before creating a new one.'), { status: 400 });
        }
      }

      const { lastInsertRowid: phaseId } = stmtInsertPoolPhase.run({
        comp_id: Number(compId), order: maxOrder + 1, rule_doc: ruleDoc, format_stage: formatStageId || null,
      });

      for (const pool of pools) {
        const { lastInsertRowid: poolId } = stmtInsertPool.run(phaseId, pool.poolNumber);

        pool.fencers.forEach((fencer, i) => {
          stmtInsertPoolCompetitor.run(poolId, fencer.competitor_id, i + 1);
        });

        pool.bouts.forEach((bout, i) => {
          const { lastInsertRowid: boutId } = stmtInsertPoolBout.run(
            phaseId, poolId, bout.left.competitor_id, bout.right.competitor_id, i + 1
          );
          Bout.normalizeHandedness(boutId);
        });
      }

      return phaseId;
    })();

    return stmtPhaseById.get(phaseId);
  },

  // ---------------------------------------------------------------------------
  // Rankings — computed from bout results. Not yet saved to DB.
  // ---------------------------------------------------------------------------
  calculateRankings(phaseId) {
    const phase = stmtPhaseById.get(phaseId);
    if (!phase) return [];

    const rule       = loadRule(phase.rule_doc);
    const criteria   = rule.seeding?.criteria || DEFAULT_CRITERIA;
    const levelPools = rule.levelPools === true;

    // All competitors in this phase, including their pool_number for level-pool ranking
    const competitorRows = stmtPoolCompetitorRows.all(phaseId);

    // All finished bouts
    const bouts = stmtFinishedBouts.all(phaseId);

    // Accumulate stats per competitor
    const stats = {};
    for (const c of competitorRows) {
      stats[c.competitor_id] = {
        competitor_id:    c.competitor_id,
        first_name:       c.first_name,
        last_name:        c.last_name,
        club_name:        c.club_name,
        nationality:      c.nationality,
        initial_seed:     c.initial_seed ?? 9999,
        pool_number:      c.pool_number,
        victories:        0,
        matches:          0,
        touches_scored:   0,
        touches_received: 0,
        indicator:        0,
        victory_ratio:    0,
      };
    }

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

    for (const s of Object.values(stats)) {
      s.indicator     = s.touches_scored - s.touches_received;
      s.victory_ratio = s.matches > 0 ? s.victories / s.matches : 0;
    }

    const compareByCriteria = (a, b) => {
      for (const crit of criteria) {
        let diff = 0;
        switch (crit) {
          case 'victory_ratio_desc':   diff = b.victory_ratio   - a.victory_ratio;   break;
          case 'victories_desc':       diff = b.victories       - a.victories;       break;
          case 'indicator_desc':       diff = b.indicator       - a.indicator;       break;
          case 'touches_scored_desc':  diff = b.touches_scored  - a.touches_scored;  break;
          case 'touches_received_asc': diff = a.touches_received - b.touches_received; break;
          case 'initial_seed_asc':     diff = (a.initial_seed ?? 9999) - (b.initial_seed ?? 9999); break;
        }
        if (diff !== 0) return diff;
      }
      return 0;
    };

    let sorted;
    if (levelPools) {
      // Rank within each pool independently; pool level order is derived from
      // the actual seeding (previous phase rankings), not from pool_number labels.
      const byPool = {};
      for (const s of Object.values(stats)) {
        if (!byPool[s.pool_number]) byPool[s.pool_number] = [];
        byPool[s.pool_number].push(s);
      }

      // Find previous pool phase to anchor level ordering
      const prevPhase = stmtPrevPoolPhaseBeforeOrder.get(phase.competition_id, phase.phase_order);

      const prevRankMap = prevPhase
        ? new Map(stmtAllRankingsForPhase.all(prevPhase.id).map(r => [r.competitor_id, r.position]))
        : null;

      // Level key = min rank of pool members in the previous phase (or min initial_seed)
      const poolLevelKey = pn => {
        const members = byPool[pn];
        if (prevRankMap) return Math.min(...members.map(m => prevRankMap.get(m.competitor_id) ?? 9999));
        return Math.min(...members.map(m => m.initial_seed));
      };

      sorted = Object.keys(byPool)
        .map(Number)
        .sort((a, b) => poolLevelKey(a) - poolLevelKey(b))
        .flatMap(pn => byPool[pn].sort(compareByCriteria));
    } else {
      sorted = Object.values(stats).sort(compareByCriteria);
    }

    const tieBreak      = Settings.get('tie_break_method') || 'alphabetical';
    const manualEnabled = Settings.get('manual_tie_break') === '1';

    // Manual tie order: flat array of competitor_ids in desired position order.
    let tieOrderMap = null;
    if (manualEnabled) {
      const raw = Settings.get('tie_order_' + phaseId);
      if (raw) {
        try {
          const arr = JSON.parse(raw);
          tieOrderMap = new Map(arr.map((id, idx) => [id, idx]));
        } catch {}
      }
    }

    // Detect tied groups: same V/M, indicator, TS, TR.
    // Within each group apply the chosen tiebreaker, then assign rank (shared)
    // and position (sequential, used for DE seeding).
    const result = [];
    let gi = 0;
    while (gi < sorted.length) {
      let gj = gi + 1;
      const a = sorted[gi];
      while (gj < sorted.length) {
        const b = sorted[gj];
        if (
          Math.abs(a.victory_ratio - b.victory_ratio) < 1e-9 &&
          a.indicator        === b.indicator &&
          a.touches_scored   === b.touches_scored &&
          a.touches_received === b.touches_received
        ) { gj++; } else { break; }
      }
      const group = sorted.slice(gi, gj);
      if (group.length > 1) {
        if (tieOrderMap) {
          group.sort((x, y) => {
            const px = tieOrderMap.has(x.competitor_id) ? tieOrderMap.get(x.competitor_id) : 999999;
            const py = tieOrderMap.has(y.competitor_id) ? tieOrderMap.get(y.competitor_id) : 999999;
            return px - py;
          });
        } else if (tieBreak === 'random') {
          for (let k = group.length - 1; k > 0; k--) {
            const m = Math.floor(Math.random() * (k + 1));
            [group[k], group[m]] = [group[m], group[k]];
          }
        } else {
          group.sort((x, y) => (x.last_name || '').localeCompare(y.last_name || ''));
        }
      }
      const rank = result.length + 1;
      const tied = group.length > 1;
      for (const s of group) {
        result.push({ ...s, position: result.length + 1, rank, tied });
      }
      gi = gj;
    }
    return result;
  },
};

module.exports = PoolPhases;
