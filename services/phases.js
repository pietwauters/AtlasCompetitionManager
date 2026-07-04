'use strict';

const db             = require('../db');
const { loadRule }   = require('../lib/rules');
const { formPools, calcPoolOptions } = require('../lib/poolFormation');
const { buildFullBracket } = require('../lib/deFormation');
const Competitor     = require('./competitors');
const Settings       = require('./settings');
const Format         = require('./formats');

const DEFAULT_CRITERIA = [
  'victory_ratio_desc', 'indicator_desc',
  'touches_scored_desc', 'touches_received_asc', 'initial_seed_asc',
];

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const Phase = {
  findByCompetition(compId) {
    return db.prepare(`
      SELECT ph.*,
        COUNT(DISTINCT p.id)  AS pool_count,
        COUNT(b.id)           AS bouts_total,
        SUM(CASE WHEN b.status='finished' THEN 1 ELSE 0 END) AS bouts_complete
      FROM phases ph
      LEFT JOIN pools p ON p.phase_id = ph.id
      LEFT JOIN bouts b ON b.phase_id = ph.id
      WHERE ph.competition_id = ?
      GROUP BY ph.id
      ORDER BY ph.phase_order
    `).all(compId);
  },

  findById(id) {
    return db.prepare('SELECT * FROM phases WHERE id = ?').get(id);
  },

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
      const comp = db.prepare('SELECT format_id FROM competitions WHERE id = ?').get(compId);
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
      const competitors = Competitor.findAll(compId).filter(c => c.competitor_status === 'active');
      N = competitors.length;
    }

    if (N < 2) throw Object.assign(new Error('At least 2 active competitors required.'), { status: 400 });

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
      const comp = db.prepare('SELECT format_id FROM competitions WHERE id = ?').get(compId);
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

    if (!competitors) {
      competitors = Competitor.findAll(compId).filter(c => c.competitor_status === 'active');
    }

    if (!competitors.length) throw Object.assign(new Error('No active competitors.'), { status: 400 });

    // If a previous pool phase exists, use its rankings as the seed order so
    // that round 2 (and beyond) serpentine-seeds from the actual results of
    // the preceding round rather than from the original pre-competition seed.
    const prevRankings = this._getPrevPoolRankings(compId);

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
      const maxOrder = db.prepare(
        'SELECT COALESCE(MAX(phase_order), 0) AS m FROM phases WHERE competition_id = ?'
      ).get(compId).m;

      // Legacy "at most one active phase" lock — skipped when a format has
      // already validated this stage's real prerequisites via assertNextStage
      // above (independent parallel tracks, e.g. Division 1 / Division 2, can
      // then have more than one simultaneously-active phase). Free-form
      // (no format) creation keeps the simple sequential lock.
      if (maxOrder > 0 && !resolvedFormat) {
        const prev = db.prepare(
          'SELECT status FROM phases WHERE competition_id = ? ORDER BY phase_order DESC LIMIT 1'
        ).get(compId);
        if (prev && prev.status !== 'finished') {
          throw Object.assign(new Error('Previous phase must be finished before creating a new one.'), { status: 400 });
        }
      }

      const { lastInsertRowid: phaseId } = db.prepare(`
        INSERT INTO phases (competition_id, phase_order, type, rule_doc, status, format_stage)
        VALUES (@comp_id, @order, 'pool', @rule_doc, 'active', @format_stage)
      `).run({ comp_id: Number(compId), order: maxOrder + 1, rule_doc: ruleDoc, format_stage: formatStageId || null });

      for (const pool of pools) {
        const { lastInsertRowid: poolId } = db.prepare(`
          INSERT INTO pools (phase_id, pool_number, status) VALUES (?, ?, 'active')
        `).run(phaseId, pool.poolNumber);

        pool.fencers.forEach((fencer, i) => {
          db.prepare(
            'INSERT INTO pool_competitors (pool_id, competitor_id, pool_slot) VALUES (?, ?, ?)'
          ).run(poolId, fencer.competitor_id, i + 1);
        });

        pool.bouts.forEach((bout, i) => {
          db.prepare(`
            INSERT INTO bouts (phase_id, pool_id, left_id, right_id, status, bout_order)
            VALUES (?, ?, ?, ?, 'pending', ?)
          `).run(phaseId, poolId, bout.left.competitor_id, bout.right.competitor_id, i + 1);
        });
      }

      return phaseId;
    })();

    return this.findById(phaseId);
  },

  // ---------------------------------------------------------------------------
  // Rankings — computed from bout results. Not yet saved to DB.
  // ---------------------------------------------------------------------------
  calculateRankings(phaseId) {
    const phase = this.findById(phaseId);
    if (!phase) return [];

    const rule       = loadRule(phase.rule_doc);
    const criteria   = rule.seeding?.criteria || DEFAULT_CRITERIA;
    const levelPools = rule.levelPools === true;

    // All competitors in this phase, including their pool_number for level-pool ranking
    const competitorRows = db.prepare(`
      SELECT DISTINCT pc.competitor_id, c.initial_seed,
        c.first_name, c.last_name, c.nationality,
        cl.name AS club_name,
        ph.pool_number
      FROM pool_competitors pc
      JOIN pools ph ON ph.id = pc.pool_id AND ph.phase_id = ?
      JOIN competitors c ON c.id = pc.competitor_id
      LEFT JOIN people p  ON p.id  = c.person_id
      LEFT JOIN clubs  cl ON cl.id = p.club_id
    `).all(phaseId);

    // All finished bouts
    const bouts = db.prepare(`
      SELECT left_id, right_id, left_score, right_score, winner_id
      FROM bouts WHERE phase_id = ? AND left_score IS NOT NULL AND right_score IS NOT NULL
    `).all(phaseId);

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
      const prevPhase = db.prepare(`
        SELECT id FROM phases
        WHERE competition_id = ? AND type = 'pool' AND phase_order < ?
        ORDER BY phase_order DESC LIMIT 1
      `).get(phase.competition_id, phase.phase_order);

      const prevRankMap = prevPhase
        ? new Map(db.prepare('SELECT competitor_id, position FROM rankings WHERE phase_id = ?')
            .all(prevPhase.id).map(r => [r.competitor_id, r.position]))
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

  // ---------------------------------------------------------------------------
  // Close phase: save rankings, mark advanced/eliminated, update statuses.
  // advancementOverride: optional { method, value, multipleOf } from manager.
  // For format-driven DE stages with survivorTarget, delegates to formats.closeFormatDE.
  // ---------------------------------------------------------------------------
  close(phaseId, advancementOverride = null) {
    const phase = this.findById(phaseId);
    if (!phase) throw Object.assign(new Error('Phase not found.'), { status: 404 });

    // Format-driven DE close (preliminary tableau with survivorTarget)
    if (phase.type === 'de' && phase.format_stage) {
      const comp = db.prepare('SELECT format_id FROM competitions WHERE id = ?').get(phase.competition_id);
      if (comp?.format_id) {
        const format = Format.loadFormat(comp.format_id);
        const stage  = Format.getStage(format, phase.format_stage);
        if (stage?.advancement?.survivorTarget) {
          return Format.closeFormatDE(phaseId, stage.advancement.survivorTarget, stage.advancement.survivorCohort);
        }
      }
    }

    const rankings = this.calculateRankings(phaseId);
    const N        = rankings.length;

    // Determine advancement rule
    let resolvedFormat = null;
    let resolvedStage  = null;
    if (phase.format_stage) {
      const comp = db.prepare('SELECT format_id FROM competitions WHERE id = ?').get(phase.competition_id);
      if (comp?.format_id) {
        resolvedFormat = Format.loadFormat(comp.format_id);
        resolvedStage  = Format.getStage(resolvedFormat, phase.format_stage);
      }
    }

    const rule = loadRule(phase.rule_doc);
    const adv = advancementOverride || rule.advancement || { method: 'percentage', value: 70 };

    // Format-driven pool stage: delegate advancement/cohort logic to the format service.
    // applyPoolClose returns the advanceN to use, or null to fall back to rule logic.
    let formatAdvanceN = null;
    if (resolvedStage && !advancementOverride) {
      formatAdvanceN = Format.applyPoolClose(phase.competition_id, phaseId, rankings, resolvedFormat, resolvedStage);
    }

    let advanceN;
    if (formatAdvanceN !== null) {
      advanceN = formatAdvanceN;
    } else if (!advancementOverride && rule.advancement?.minForCut && N < Number(rule.advancement.minForCut)) {
      // Field too small for this rule's cut to make sense — advance everyone.
      // Only guards the rule's own automatic cut; an explicit director override
      // at close time is always respected regardless of field size.
      advanceN = N;
    } else {
      advanceN = N;
      switch (adv.method) {
        case 'count':
          advanceN = Math.min(Number(adv.value), N);
          break;
        case 'multiple':
          advanceN = Math.floor(N / Number(adv.multipleOf)) * Number(adv.multipleOf);
          if (advanceN < 1) advanceN = N;
          break;
        case 'percentage':
        default: {
          const pct = Number(adv.value ?? 70) / 100;
          advanceN = Math.round(N * pct);
          if (adv.roundTo) {
            const rt = Number(adv.roundTo);
            advanceN = Math.ceil(advanceN / rt) * rt;
          }
          break;
        }
      }
      advanceN = Math.max(0, Math.min(advanceN, N));
    }

    const noElimination = (resolvedStage?.advancement?.noElimination || resolvedStage?.advancement?.isFinalRanking) && !advancementOverride;

    db.transaction(() => {
      // Clear previous rankings for this phase (in case of re-close)
      db.prepare('DELETE FROM rankings WHERE phase_id = ?').run(phaseId);

      const insertRanking = db.prepare(`
        INSERT INTO rankings
          (phase_id, competitor_id, position, victories, matches,
           indicator, touches_scored, touches_received, advanced)
        VALUES (@phase_id, @competitor_id, @position, @victories, @matches,
                @indicator, @touches_scored, @touches_received, @advanced)
      `);

      for (let i = 0; i < rankings.length; i++) {
        const r        = rankings[i];
        const advanced = i < advanceN ? 1 : 0;
        insertRanking.run({ ...r, phase_id: phaseId, advanced });

        if (noElimination) {
          // Format stage with no elimination — applyPoolClose already set status/cohort.
          // Do not touch competitor status here.
        } else if (advanced) {
          db.prepare("UPDATE competitors SET status='active' WHERE id=?").run(r.competitor_id);
        } else {
          db.prepare(`
            UPDATE competitors SET status='eliminated', eliminated_after=?, final_rank=?
            WHERE id=?
          `).run(phaseId, r.position, r.competitor_id);
        }
      }

      db.prepare("UPDATE phases SET status='finished' WHERE id=?").run(phaseId);
      db.prepare("UPDATE pools  SET status='finished' WHERE phase_id=?").run(phaseId);
    })();

    // Remove any manual tie order stored for this phase — no longer needed.
    Settings.delete('tie_order_' + phaseId);

    return { rankings, advanced: advanceN, eliminated: noElimination ? 0 : N - advanceN };
  },

  // ---------------------------------------------------------------------------
  // Returns a Map<competitor_id, rank> from the most recent finished pool phase.
  // Used to seed a subsequent pool phase from real results rather than from the
  // original pre-competition seed numbers.
  // ---------------------------------------------------------------------------
  _getPrevPoolRankings(compId) {
    const prev = db.prepare(`
      SELECT id FROM phases
      WHERE competition_id = ? AND type = 'pool' AND status = 'finished'
      ORDER BY phase_order DESC LIMIT 1
    `).get(compId);
    if (!prev) return new Map();
    const rows = db.prepare(
      'SELECT competitor_id, position FROM rankings WHERE phase_id = ? AND advanced = 1'
    ).all(prev.id);
    return new Map(rows.map(r => [r.competitor_id, r.position]));
  },

  // ---------------------------------------------------------------------------
  // DE: preview — returns { N, tableauSize, byeCount, totalRounds, finishedPoolPhases }
  // finishedPoolPhases: count of finished pool phases (drives the seeding selector)
  // ---------------------------------------------------------------------------
  getDeOptions(compId) {
    const finishedPoolPhases = db.prepare(
      "SELECT COUNT(*) AS n FROM phases WHERE competition_id=? AND type='pool' AND status='finished'"
    ).get(compId).n;
    const rows = this._getDeSeeding(compId, 'last');
    if (rows.length < 2) throw Object.assign(new Error('At least 2 active competitors required.'), { status: 400 });
    const T = 2 ** Math.ceil(Math.log2(rows.length));
    return { N: rows.length, tableauSize: T, byeCount: T - rows.length, totalRounds: Math.log2(T), finishedPoolPhases };
  },

  // Returns an ordered array of { competitor_id } for DE seeding.
  //
  // seedingMethod:
  //   'last'     — rank from the most recent finished pool phase (advanced only)
  //   'combined' — aggregate stats across ALL finished pool phases, re-rank,
  //                include all currently active competitors
  //   (fallback) — active competitors sorted by initial_seed
  _getDeSeeding(compId, seedingMethod = 'last') {
    const finishedPhases = db.prepare(`
      SELECT id FROM phases
      WHERE competition_id = ? AND type = 'pool' AND status = 'finished'
      ORDER BY phase_order
    `).all(compId);

    if (finishedPhases.length === 0) {
      return Competitor.findAll(compId)
        .filter(c => c.competitor_status === 'active')
        .sort((a, b) => (a.initial_seed || 9999) - (b.initial_seed || 9999))
        .map(c => ({ competitor_id: c.competitor_id }));
    }

    if (seedingMethod === 'combined') {
      return this._combinedSeeding(compId, finishedPhases);
    }

    // 'last': use only the most recent finished pool phase
    const lastId = finishedPhases[finishedPhases.length - 1].id;
    return db.prepare(`
      SELECT r.competitor_id
      FROM rankings r
      WHERE r.phase_id = ? AND r.advanced = 1
      ORDER BY r.position
    `).all(lastId);
  },

  // Aggregate bout stats across every finished pool phase, re-rank using FIE
  // criteria, and return all active competitors in that combined order.
  _combinedSeeding(compId, finishedPhases) {
    const phaseIds = finishedPhases.map(p => p.id);

    // Collect all active competitors
    const active = Competitor.findAll(compId).filter(c => c.competitor_status === 'active');
    const stats  = {};
    for (const c of active) {
      stats[c.competitor_id] = {
        competitor_id:    c.competitor_id,
        initial_seed:     c.initial_seed ?? 9999,
        victories:        0, matches:          0,
        touches_scored:   0, touches_received: 0,
      };
    }

    // Sum bout stats across all finished pool phases
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

    const sorted = Object.values(stats).map(s => ({
      ...s,
      indicator:     s.touches_scored - s.touches_received,
      victory_ratio: s.matches > 0 ? s.victories / s.matches : 0,
    })).sort((a, b) => {
      for (const [fn] of [
        [() => b.victory_ratio   - a.victory_ratio],
        [() => b.indicator       - a.indicator],
        [() => b.touches_scored  - a.touches_scored],
        [() => a.touches_received - b.touches_received],
        [() => a.initial_seed    - b.initial_seed],
      ]) {
        const d = fn(); if (d !== 0) return d;
      }
      return 0;
    });

    return sorted.map(s => ({ competitor_id: s.competitor_id }));
  },

  // ---------------------------------------------------------------------------
  // Create DE phase: inserts phase + all bout slots for every round.
  // seedingMethod: 'last' (default) or 'combined'
  // formatStageId: when provided, participants come from the format definition.
  // ---------------------------------------------------------------------------
  createDE(compId, ruleDoc, seedingMethod = 'last', formatStageId = null) {
    let competitors;
    let resolvedFormat = null;
    let resolvedStage  = null;

    if (formatStageId) {
      const comp = db.prepare('SELECT format_id FROM competitions WHERE id = ?').get(compId);
      if (comp?.format_id) {
        resolvedFormat = Format.loadFormat(comp.format_id);
        resolvedStage  = Format.getStage(resolvedFormat, formatStageId);
        Format.assertNextStage(compId, resolvedFormat, formatStageId);
        competitors = Format.resolveParticipants(compId, resolvedFormat, resolvedStage);
      }
    }

    if (!competitors) {
      const seeding = this._getDeSeeding(compId, seedingMethod);
      competitors = seeding.map(r => ({ competitor_id: r.competitor_id }));
    }

    const rule = loadRule(ruleDoc);

    const { nodes, tableauSize, totalRounds } = buildFullBracket(competitors, rule);

    const phaseId = db.transaction(() => {
      const maxOrder = db.prepare(
        'SELECT COALESCE(MAX(phase_order), 0) AS m FROM phases WHERE competition_id = ?'
      ).get(compId).m;

      // See the matching comment in Phase.create — skipped once a format has
      // already validated this stage's real prerequisites (assertNextStage
      // above), so independent parallel tracks can both be active at once.
      if (maxOrder > 0 && !resolvedFormat) {
        const prev = db.prepare(
          'SELECT status FROM phases WHERE competition_id = ? ORDER BY phase_order DESC LIMIT 1'
        ).get(compId);
        if (prev && prev.status !== 'finished') {
          throw Object.assign(
            new Error('Previous phase must be finished before creating a new one.'),
            { status: 400 }
          );
        }
      }

      const { lastInsertRowid: phaseId } = db.prepare(`
        INSERT INTO phases (competition_id, phase_order, type, rule_doc, status, format_stage)
        VALUES (@comp_id, @order, 'de', @rule_doc, 'active', @format_stage)
      `).run({ comp_id: Number(compId), order: maxOrder + 1, rule_doc: ruleDoc, format_stage: formatStageId || null });

      // Pass 1 — insert every bout; collect DB ids indexed by tempId.
      const insertBout = db.prepare(`
        INSERT INTO bouts
          (phase_id, left_id, right_id, de_round, tableau_position,
           bracket, status, winner_id, left_score, right_score,
           bout_order, place_rank)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const dbIds = new Array(nodes.length); // dbIds[tempId] = DB row id
      for (const n of nodes) {
        const { lastInsertRowid } = insertBout.run(
          phaseId,
          n.leftCompetitorId,
          n.rightCompetitorId,
          n.de_round,
          n.tableau_position,
          n.bracket,
          n.status,
          n.winner_id,
          n.left_score,
          n.right_score,
          n.bout_order,
          n.place_rank,
        );
        dbIds[n.tempId] = lastInsertRowid;
        n.dbId = lastInsertRowid;
      }

      // Pass 2 — set routing pointers now that all DB ids are known.
      const updateRouting = db.prepare(`
        UPDATE bouts
        SET winner_next_bout_id = @wnb, winner_next_side = @wns,
            loser_next_bout_id  = @lnb, loser_next_side  = @lns
        WHERE id = @id
      `);

      for (const n of nodes) {
        const hasRouting = n.winnerNextTempId !== null || n.loserNextTempId !== null;
        if (!hasRouting) continue;
        updateRouting.run({
          id:  n.dbId,
          wnb: n.winnerNextTempId !== null ? dbIds[n.winnerNextTempId] : null,
          wns: n.winnerNextSide   ?? null,
          lnb: n.loserNextTempId  !== null ? dbIds[n.loserNextTempId]  : null,
          lns: n.loserNextSide    ?? null,
        });
      }

      // Pass 3 — wire bye winners into their next-round slots immediately,
      // mirroring what routeBoutResult would do when bouts finish at run time.
      const updateSlot = db.prepare(`UPDATE bouts SET left_id = ? WHERE id = ?`);
      const updateSlotR = db.prepare(`UPDATE bouts SET right_id = ? WHERE id = ?`);
      for (const n of nodes) {
        if (n.status !== 'finished' || !n.winner_id || !n.winnerNextTempId) continue;
        const nextDbId = dbIds[n.winnerNextTempId];
        if (n.winnerNextSide === 'left')  updateSlot.run(n.winner_id, nextDbId);
        else                              updateSlotR.run(n.winner_id, nextDbId);
      }

      // Pass 4 — run the real routing/cascade check for every bye created above.
      // Pass 3 only forwards a bye's winner; it never checks whether the bye's
      // (nonexistent) loser leaves a repechage/placement slot permanently
      // starved — e.g. two adjacent R1 byes paired into the same repechage
      // Table D slot, neither of which has a loser to send there. That slot
      // would otherwise sit pending forever and stall everything downstream.
      // routeBoutResult's cascade check (services/bouts.js) already detects
      // this; byes just need to actually go through it once.
      const Bout = require('./bouts');
      for (const n of nodes) {
        if (n.status === 'finished') Bout.routeBoutResult(n.dbId);
      }

      return phaseId;
    })();

    return this.findById(phaseId);
  },

  // ---------------------------------------------------------------------------
  // Simulate: randomly score all pending bouts in the phase.
  // Pool: scores every pending bout.
  // DE: processes round by round so each winner is placed before the next
  //     round is simulated.
  // Returns count of bouts simulated.
  // ---------------------------------------------------------------------------
  simulate(phaseId) {
    const phase = this.findById(phaseId);
    if (!phase) throw Object.assign(new Error('Phase not found'), { status: 404 });

    const rule        = loadRule(phase.rule_doc);
    const touchTarget = rule.bout?.touchTarget ?? (phase.type === 'de' ? 15 : 5);

    function randomScores(target) {
      const winnerLeft = Math.random() < 0.5;
      const loserScore = Math.floor(Math.random() * target);
      return winnerLeft ? [target, loserScore] : [loserScore, target];
    }

    const Bout = require('./bouts');
    let count = 0;

    if (phase.type === 'pool') {
      const pending = db.prepare(`
        SELECT id FROM bouts
        WHERE phase_id=? AND status='pending'
          AND left_id IS NOT NULL AND right_id IS NOT NULL
      `).all(phaseId);
      for (const b of pending) {
        const [ls, rs] = randomScores(touchTarget);
        Bout.updateScore(b.id, ls, rs);
        count++;
      }
    } else if (phase.type === 'de') {
      const ruleDoc       = loadRule(phase.rule_doc);
      const isRepechage   = !!(ruleDoc.repechage?.enabled);

      function scoreRound(bracket, de_round) {
        const pending = db.prepare(`
          SELECT id FROM bouts
          WHERE phase_id=? AND de_round=? AND bracket=? AND status='pending'
            AND left_id IS NOT NULL AND right_id IS NOT NULL
          ORDER BY bout_order
        `).all(phaseId, de_round, bracket);
        for (const b of pending) {
          const [ls, rs] = randomScores(touchTarget);
          Bout.updateScore(b.id, ls, rs);
          count++;
        }
      }

      function scorePlacement() {
        let anyScored = true;
        while (anyScored) {
          anyScored = false;
          const pending = db.prepare(`
            SELECT id FROM bouts
            WHERE phase_id=? AND bracket='placement' AND status='pending'
              AND left_id IS NOT NULL AND right_id IS NOT NULL
            ORDER BY bout_order
          `).all(phaseId);
          for (const b of pending) {
            const [ls, rs] = randomScores(touchTarget);
            Bout.updateScore(b.id, ls, rs);
            count++;
            anyScored = true;
          }
        }
      }

      if (isRepechage) {
        // Process rounds in dependency order: main Ri → rep D → main R(i+1) → rep E → rep F → ...
        // Derive n from actual repechage bouts (robust against any T, not just fromTableau).
        const reT          = ruleDoc.repechage.reentryAt;
        const maxRepRound  = db.prepare(
          "SELECT COALESCE(MAX(de_round),0) AS m FROM bouts WHERE phase_id=? AND bracket='repechage'"
        ).get(phaseId).m;
        const n            = maxRepRound / 2;
        const lastMainRound = n + 1;
        const finalsRounds  = Math.log2(reT);

        scoreRound('main', 1);         // R1
        scoreRound('repechage', 1);    // D

        for (let inj = 0; inj < n; inj++) {
          scoreRound('main', inj + 2);           // R2, R3
          scoreRound('repechage', 2 * inj + 2);  // E, G
          if (inj < n - 1) {
            scoreRound('repechage', 2 * inj + 3); // F (between E and G)
          }
        }

        for (let fr = 1; fr <= finalsRounds; fr++) {
          scoreRound('main', lastMainRound + fr); // H, I, J
        }

        scorePlacement(); // bronze
      } else {
        // For format-driven preliminary DEs, only simulate up to the stopping round.
        // The manager closes the phase manually after that; later rounds stay pending.
        let stoppingRound = null;
        if (phase.format_stage) {
          const comp = db.prepare('SELECT format_id FROM competitions WHERE id = ?').get(phase.competition_id);
          if (comp?.format_id) {
            try {
              const format = Format.loadFormat(comp.format_id);
              const stage  = Format.getStage(format, phase.format_stage);
              if (stage?.advancement?.survivorTarget) {
                const tHalf = db.prepare(
                  "SELECT COUNT(*) AS n FROM bouts WHERE phase_id=? AND de_round=1 AND bracket='main'"
                ).get(phaseId).n;
                stoppingRound = Math.round(Math.log2(tHalf * 2 / stage.advancement.survivorTarget));
              }
            } catch {}
          }
        }

        const maxRound = stoppingRound || (db.prepare(
          "SELECT MAX(de_round) AS m FROM bouts WHERE phase_id=? AND bracket='main'"
        ).get(phaseId).m || 1);

        for (let r = 1; r <= maxRound; r++) {
          scoreRound('main', r);
        }

        if (!stoppingRound) scorePlacement();
      }
    }

    return { simulated: count };
  },

  // ---------------------------------------------------------------------------
  // Reopen a finished phase: undo the close — restore eliminated competitors,
  // drop saved rankings, set phase and pools back to active.
  // Scores are untouched; the manager re-closes when ready.
  // ---------------------------------------------------------------------------
  reopen(id) {
    db.transaction(() => {
      const phase = db.prepare('SELECT * FROM phases WHERE id = ?').get(id);
      if (!phase) throw Object.assign(new Error('Phase not found.'), { status: 404 });
      if (phase.status !== 'finished') throw Object.assign(new Error('Only finished phases can be reopened.'), { status: 400 });

      // Restore competitors eliminated by this phase
      db.prepare(`
        UPDATE competitors SET status='active', eliminated_after=NULL, final_rank=NULL
        WHERE eliminated_after = ?
      `).run(id);

      // Clear format cohorts that were assigned as part of this phase's close.
      // For a pool phase: pool_exempt cohort. For a DE phase: de_survivors cohort.
      if (phase.format_stage) {
        const comp = db.prepare('SELECT format_id FROM competitions WHERE id = ?').get(phase.competition_id);
        if (comp?.format_id) {
          const format = Format.loadFormat(comp.format_id);
          const stage  = Format.getStage(format, phase.format_stage);
          if (stage?.advancement?.exemptCohort) {
            db.prepare("UPDATE competitors SET format_cohort=NULL WHERE competition_id=? AND format_cohort=?")
              .run(phase.competition_id, stage.advancement.exemptCohort);
          }
          if (stage?.advancement?.survivorCohort || stage?.advancement?.survivorTarget) {
            const cohort = stage.advancement.survivorCohort || 'de_survivors';
            db.prepare("UPDATE competitors SET format_cohort=NULL WHERE competition_id=? AND format_cohort=?")
              .run(phase.competition_id, cohort);
          }
        }
      }

      // Drop saved rankings (live rankings are recomputed on the fly)
      db.prepare('DELETE FROM rankings WHERE phase_id = ?').run(id);

      // Set phase and pools back to active
      db.prepare("UPDATE phases SET status='active' WHERE id=?").run(id);
      db.prepare("UPDATE pools  SET status='active' WHERE phase_id=?").run(id);
    })();
  },

  delete(id) {
    db.transaction(() => {
      // Restore any competitors eliminated by this phase before cascading
      db.prepare(`
        UPDATE competitors SET status='active', eliminated_after=NULL, final_rank=NULL
        WHERE eliminated_after = ?
      `).run(id);

      // Clear format cohorts assigned during this phase
      const phase = db.prepare('SELECT * FROM phases WHERE id = ?').get(id);
      if (phase?.format_stage) {
        const comp = db.prepare('SELECT format_id FROM competitions WHERE id = ?').get(phase.competition_id);
        if (comp?.format_id) {
          try {
            const format = Format.loadFormat(comp.format_id);
            const stage  = Format.getStage(format, phase.format_stage);
            if (stage?.advancement?.exemptCohort) {
              db.prepare("UPDATE competitors SET format_cohort=NULL WHERE competition_id=? AND format_cohort=?")
                .run(phase.competition_id, stage.advancement.exemptCohort);
            }
            if (stage?.advancement?.survivorCohort || stage?.advancement?.survivorTarget) {
              const cohort = stage.advancement.survivorCohort || 'de_survivors';
              db.prepare("UPDATE competitors SET format_cohort=NULL WHERE competition_id=? AND format_cohort=?")
                .run(phase.competition_id, cohort);
            }
            // Also clear initial_exempt if this is the first pool stage
            if (stage?.participants?.initialExemptCohort) {
              db.prepare("UPDATE competitors SET format_cohort=NULL WHERE competition_id=? AND format_cohort=?")
                .run(phase.competition_id, stage.participants.initialExemptCohort);
            }
          } catch {}
        }
      }

      db.prepare('DELETE FROM phases WHERE id = ?').run(id);
    })();
  },
};

module.exports = Phase;
