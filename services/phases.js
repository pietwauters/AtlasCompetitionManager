'use strict';

// Orchestrator for phase creation/lifecycle — split 2026-07-28 (architecture
// review) from a 928-line file that had grown into a god service. Pool- and
// DE-specific logic now live in services/poolPhases.js / services/dePhases.js
// respectively; this file keeps the genuinely-shared or mixed-type-logic
// functions (close/simulate both branch internally on phase.type; reopen/
// delete/findById/findByCompetition are generic over both types) and
// re-exports calcOptions/create/calculateRankings/getDeOptions/createDE
// directly from the two split files so the external API (routes/phases.js,
// routes/phasesById.js) is completely unchanged.

const db             = require('../db');
const { loadRule }   = require('../lib/rules');
const Settings       = require('./settings');
const Format         = require('./formats');
const Bout           = require('./bouts');
const PoolPhases     = require('./poolPhases');
const DePhases       = require('./dePhases');

// ---------------------------------------------------------------------------
// Prepared statements — module-level constants (see CLAUDE.md's hard rule;
// hoisted as part of this split rather than before it).
// ---------------------------------------------------------------------------
const stmtPhaseById = db.prepare('SELECT * FROM phases WHERE id = ?');
const stmtCompFormatId = db.prepare('SELECT format_id FROM competitions WHERE id = ?');
const stmtFindByCompetition = db.prepare(`
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
`);

// close()
const stmtDeleteRankingsForPhase = db.prepare('DELETE FROM rankings WHERE phase_id = ?');
const stmtInsertRanking = db.prepare(`
  INSERT INTO rankings
    (phase_id, competitor_id, position, victories, matches,
     indicator, touches_scored, touches_received, advanced)
  VALUES (@phase_id, @competitor_id, @position, @victories, @matches,
          @indicator, @touches_scored, @touches_received, @advanced)
`);
const stmtSetCompetitorActive = db.prepare("UPDATE competitors SET status='active' WHERE id=?");
const stmtSetCompetitorEliminated = db.prepare(`
  UPDATE competitors SET status='eliminated', eliminated_after=?, final_rank=?
  WHERE id=?
`);
const stmtFinishPhase = db.prepare("UPDATE phases SET status='finished' WHERE id=?");
const stmtFinishPools = db.prepare("UPDATE pools  SET status='finished' WHERE phase_id=?");

// simulate()
const stmtPendingPoolBouts = db.prepare(`
  SELECT id FROM bouts
  WHERE phase_id=? AND status='pending'
    AND left_id IS NOT NULL AND right_id IS NOT NULL
`);
const stmtPendingDeRoundBouts = db.prepare(`
  SELECT id FROM bouts
  WHERE phase_id=? AND de_round=? AND bracket=? AND status='pending'
    AND left_id IS NOT NULL AND right_id IS NOT NULL
  ORDER BY bout_order
`);
const stmtPendingPlacementBouts = db.prepare(`
  SELECT id FROM bouts
  WHERE phase_id=? AND bracket='placement' AND status='pending'
    AND left_id IS NOT NULL AND right_id IS NOT NULL
  ORDER BY bout_order
`);
const stmtMaxRepechageRound = db.prepare(
  "SELECT COALESCE(MAX(de_round),0) AS m FROM bouts WHERE phase_id=? AND bracket='repechage'"
);
const stmtMainRoundOneCount = db.prepare(
  "SELECT COUNT(*) AS n FROM bouts WHERE phase_id=? AND de_round=1 AND bracket='main'"
);
const stmtMaxMainRound = db.prepare(
  "SELECT MAX(de_round) AS m FROM bouts WHERE phase_id=? AND bracket='main'"
);

// reopen() / delete()
const stmtRestoreEliminated = db.prepare(`
  UPDATE competitors SET status='active', eliminated_after=NULL, final_rank=NULL
  WHERE eliminated_after = ?
`);
const stmtClearFormatCohort = db.prepare(
  'UPDATE competitors SET format_cohort=NULL WHERE competition_id=? AND format_cohort=?'
);
const stmtSetPhaseActive = db.prepare("UPDATE phases SET status='active' WHERE id=?");
const stmtSetPoolsActive = db.prepare("UPDATE pools  SET status='active' WHERE phase_id=?");
const stmtDeletePhase = db.prepare('DELETE FROM phases WHERE id = ?');

const Phase = {
  findByCompetition(compId) {
    return stmtFindByCompetition.all(compId);
  },

  findById(id) {
    return stmtPhaseById.get(id);
  },

  // Pool-specific — see services/poolPhases.js for the implementations.
  calcOptions:       PoolPhases.calcOptions,
  create:            PoolPhases.create,
  calculateRankings: PoolPhases.calculateRankings,

  // DE-specific — see services/dePhases.js for the implementations.
  getDeOptions:   DePhases.getDeOptions,
  createDE:       DePhases.createDE,
  createSkeleton: DePhases.createSkeleton,
  seedSkeleton:   DePhases.seedSkeleton,

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
      const comp = stmtCompFormatId.get(phase.competition_id);
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
      const comp = stmtCompFormatId.get(phase.competition_id);
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
      stmtDeleteRankingsForPhase.run(phaseId);

      for (let i = 0; i < rankings.length; i++) {
        const r        = rankings[i];
        const advanced = i < advanceN ? 1 : 0;
        stmtInsertRanking.run({ ...r, phase_id: phaseId, advanced });

        if (noElimination) {
          // Format stage with no elimination — applyPoolClose already set status/cohort.
          // Do not touch competitor status here.
        } else if (advanced) {
          stmtSetCompetitorActive.run(r.competitor_id);
        } else {
          stmtSetCompetitorEliminated.run(phaseId, r.position, r.competitor_id);
        }
      }

      stmtFinishPhase.run(phaseId);
      stmtFinishPools.run(phaseId);
    })();

    // Remove any manual tie order stored for this phase — no longer needed.
    Settings.delete('tie_order_' + phaseId);

    return { rankings, advanced: advanceN, eliminated: noElimination ? 0 : N - advanceN };
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

    let count = 0;

    if (phase.type === 'pool') {
      const pending = stmtPendingPoolBouts.all(phaseId);
      for (const b of pending) {
        const [ls, rs] = randomScores(touchTarget);
        Bout.updateScore(b.id, ls, rs);
        count++;
      }
    } else if (phase.type === 'de') {
      const ruleDoc       = loadRule(phase.rule_doc);
      const isRepechage   = !!(ruleDoc.repechage?.enabled);

      function scoreRound(bracket, de_round) {
        const pending = stmtPendingDeRoundBouts.all(phaseId, de_round, bracket);
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
          const pending = stmtPendingPlacementBouts.all(phaseId);
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
        const maxRepRound  = stmtMaxRepechageRound.get(phaseId).m;
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
          const comp = stmtCompFormatId.get(phase.competition_id);
          if (comp?.format_id) {
            try {
              const format = Format.loadFormat(comp.format_id);
              const stage  = Format.getStage(format, phase.format_stage);
              if (stage?.advancement?.survivorTarget) {
                const tHalf = stmtMainRoundOneCount.get(phaseId).n;
                stoppingRound = Math.round(Math.log2(tHalf * 2 / stage.advancement.survivorTarget));
              }
            } catch {}
          }
        }

        const maxRound = stoppingRound || (stmtMaxMainRound.get(phaseId).m || 1);

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
      const phase = stmtPhaseById.get(id);
      if (!phase) throw Object.assign(new Error('Phase not found.'), { status: 404 });
      if (phase.status !== 'finished') throw Object.assign(new Error('Only finished phases can be reopened.'), { status: 400 });

      // Restore competitors eliminated by this phase
      stmtRestoreEliminated.run(id);

      // Clear format cohorts that were assigned as part of this phase's close.
      // For a pool phase: pool_exempt cohort. For a DE phase: de_survivors cohort.
      if (phase.format_stage) {
        const comp = stmtCompFormatId.get(phase.competition_id);
        if (comp?.format_id) {
          const format = Format.loadFormat(comp.format_id);
          const stage  = Format.getStage(format, phase.format_stage);
          if (stage?.advancement?.exemptCohort) {
            stmtClearFormatCohort.run(phase.competition_id, stage.advancement.exemptCohort);
          }
          if (stage?.advancement?.survivorCohort || stage?.advancement?.survivorTarget) {
            const cohort = stage.advancement.survivorCohort || 'de_survivors';
            stmtClearFormatCohort.run(phase.competition_id, cohort);
          }
        }
      }

      // Drop saved rankings (live rankings are recomputed on the fly)
      stmtDeleteRankingsForPhase.run(id);

      // Set phase and pools back to active
      stmtSetPhaseActive.run(id);
      stmtSetPoolsActive.run(id);
    })();
  },

  delete(id) {
    db.transaction(() => {
      // Restore any competitors eliminated by this phase before cascading
      stmtRestoreEliminated.run(id);

      // Clear format cohorts assigned during this phase
      const phase = stmtPhaseById.get(id);
      if (phase?.format_stage) {
        const comp = stmtCompFormatId.get(phase.competition_id);
        if (comp?.format_id) {
          try {
            const format = Format.loadFormat(comp.format_id);
            const stage  = Format.getStage(format, phase.format_stage);
            if (stage?.advancement?.exemptCohort) {
              stmtClearFormatCohort.run(phase.competition_id, stage.advancement.exemptCohort);
            }
            if (stage?.advancement?.survivorCohort || stage?.advancement?.survivorTarget) {
              const cohort = stage.advancement.survivorCohort || 'de_survivors';
              stmtClearFormatCohort.run(phase.competition_id, cohort);
            }
            // Also clear initial_exempt if this is the first pool stage
            if (stage?.participants?.initialExemptCohort) {
              stmtClearFormatCohort.run(phase.competition_id, stage.participants.initialExemptCohort);
            }
          } catch {}
        }
      }

      stmtDeletePhase.run(id);
    })();
  },
};

module.exports = Phase;
