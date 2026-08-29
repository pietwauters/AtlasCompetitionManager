'use strict';

// Tournament schedule planner — Phase 1 (estimation/what-if tool). Orchestrates
// the pure per-stage math (schedulePlanEstimate.js), the greedy piste solver
// (schedulePlanSolver.js), and the referee-shortfall analysis
// (schedulePlanReferees.js) into one persisted plan per tournament. See
// docs/schedule-planner-algorithm.md for the full model — deliberately
// decoupled from pipeline_slots/phases/pools; nothing here writes to the live
// scheduling tables.
//
// This file itself covers plan/stage CRUD, format sync, and per-competition
// start overrides — it merges in two split-out files (2026-08-28, once this
// file crossed the project's god-file threshold): schedulePlanOverrides.js
// (round overrides + piste reservations, pure CRUD, low expected growth) and
// schedulePlanResolve.js (the solve orchestration itself — _buildSolverInput/
// resolve/preview — the piece expected to keep growing as more referee-
// related constraints get added). The merge is a plain Object.assign onto one
// object, not each file exporting its own separately-called object, so every
// method still sees the same `this` regardless of which file defined it —
// avoids the this-binding hazard a similar split (services/phases.js) hit
// once; services/pipeline.js's split avoided it the same way.

const db = require('../db');
const Competition = require('./competitions');
const Competitor = require('./competitors');
const Format = require('./formats');
const { computeStageMetrics, defaultRuleDoc, projectAdvancement } = require('./schedulePlanEstimate');
const Overrides = require('./schedulePlanOverrides');
const Resolve = require('./schedulePlanResolve');

// ---------------------------------------------------------------------------
// Prepared statements — module-level constants (CLAUDE.md hard rule).
// ---------------------------------------------------------------------------
const stmtPlanByTournament = db.prepare('SELECT * FROM schedule_plans WHERE tournament_id = ?');
const stmtPlanById         = db.prepare('SELECT * FROM schedule_plans WHERE id = ?');
const stmtInsertPlan       = db.prepare('INSERT INTO schedule_plans (tournament_id) VALUES (?)');
const stmtUpdatePlan       = db.prepare(`
  UPDATE schedule_plans SET day_start = @day_start, abstract_piste_count = @abstract_piste_count,
    abstract_referee_count = @abstract_referee_count,
    default_max_flights_pool = @default_max_flights_pool, default_max_flights_de = @default_max_flights_de,
    de_rest_minutes = @de_rest_minutes, default_max_pistes_de = @default_max_pistes_de,
    updated_at = datetime('now')
  WHERE id = @id
`);

const stmtStagesForPlan = db.prepare(
  'SELECT * FROM schedule_plan_stages WHERE schedule_plan_id = ? ORDER BY competition_id, stage_order'
);
const stmtStageById = db.prepare('SELECT * FROM schedule_plan_stages WHERE id = ?');
const stmtFindStageByFormatStageId = db.prepare(`
  SELECT * FROM schedule_plan_stages WHERE schedule_plan_id = ? AND competition_id = ? AND format_stage_id = ?
`);
const stmtNextStageOrder = db.prepare(`
  SELECT COALESCE(MAX(stage_order), 0) + 1 AS next_order FROM schedule_plan_stages
  WHERE schedule_plan_id = ? AND competition_id = ?
`);
const stmtInsertStage = db.prepare(`
  INSERT INTO schedule_plan_stages
    (schedule_plan_id, competition_id, format_stage_id, label, stage_order, depends_on,
     phase_type, rule_doc, estimated_n, pistes_assigned)
  VALUES (@plan_id, @competition_id, @format_stage_id, @label, @stage_order, @depends_on,
          @phase_type, @rule_doc, @estimated_n, @pistes_assigned)
`);
const stmtUpdateStageFromFormat = db.prepare(
  'UPDATE schedule_plan_stages SET label = @label, phase_type = @phase_type, rule_doc = @rule_doc WHERE id = @id'
);
const stmtUpdateStage = db.prepare(`
  UPDATE schedule_plan_stages SET label = @label, estimated_n = @estimated_n,
    pistes_assigned = @pistes_assigned, depends_on = @depends_on, rule_doc = @rule_doc,
    max_flights = @max_flights, max_pistes = @max_pistes
  WHERE id = @id
`);
const stmtSetDependsOn = db.prepare('UPDATE schedule_plan_stages SET depends_on = ? WHERE id = ?');
const stmtDeleteStage  = db.prepare('DELETE FROM schedule_plan_stages WHERE id = ?');

const stmtSlotsForPlan = db.prepare(`
  SELECT sl.* FROM schedule_plan_slots sl
  JOIN schedule_plan_stages st ON st.id = sl.schedule_plan_stage_id
  WHERE st.schedule_plan_id = ?
`);
const stmtSlotById = db.prepare('SELECT * FROM schedule_plan_slots WHERE id = ?');
const stmtUpdateSlot = db.prepare(`
  UPDATE schedule_plan_slots SET
    strip_id = @strip_id, abstract_piste_index = @abstract_piste_index,
    scheduled_start = @scheduled_start, scheduled_end = @scheduled_end
  WHERE id = @id
`);

// Per-competition start-time overrides — see setCompetitionStart below.
const stmtCompetitionStartsForPlan = db.prepare(
  'SELECT competition_id, day_start FROM schedule_plan_competition_starts WHERE schedule_plan_id = ?'
);
const stmtUpsertCompetitionStart = db.prepare(`
  INSERT INTO schedule_plan_competition_starts (schedule_plan_id, competition_id, day_start)
  VALUES (@plan_id, @competition_id, @day_start)
  ON CONFLICT (schedule_plan_id, competition_id) DO UPDATE SET day_start = excluded.day_start
`);
const stmtDeleteCompetitionStart = db.prepare(
  'DELETE FROM schedule_plan_competition_starts WHERE schedule_plan_id = ? AND competition_id = ?'
);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function parseDependsOn(json) {
  if (!json) return [];
  try { const arr = JSON.parse(json); return Array.isArray(arr) ? arr : []; } catch { return []; }
}

function defaultEstimatedN(competitionId) {
  return Competitor.findAll(competitionId).length;
}

// A DE stage's estimated_n must reflect who actually ADVANCES out of its
// pool dependency (schedulePlanEstimate.js's projectAdvancement), not just
// default to the same raw entrant count as the pool stage itself — that was
// a real bug: e.g. 66 pool entrants at a 70% cut advances ~46, but
// defaulting straight to 66 projected a T128 tableau instead of the real
// T64, wildly inflating round-1's piste demand (64 pistes requested instead
// of ~32) and cascading into a schedule that looked far more piste-starved/
// sequential than reality. poolDependency is the pool stage's own current
// row ({ estimated_n, rule_doc }) — undefined/null when a DE stage has no
// pool dependency (stand-alone, or depends on something other than a pool),
// in which case there's nothing to project from and the raw registrant
// count is the best available default, same as before.
function estimatedNForDeStage(competitionId, poolDependency) {
  if (poolDependency) {
    return projectAdvancement(Number(poolDependency.estimated_n) || 0, poolDependency.rule_doc);
  }
  return defaultEstimatedN(competitionId);
}

const SchedulePlanCore = {
  getOrCreate(tournamentId) {
    let plan = stmtPlanByTournament.get(tournamentId);
    if (!plan) {
      const { lastInsertRowid } = stmtInsertPlan.run(tournamentId);
      plan = stmtPlanById.get(lastInsertRowid);
    }
    return plan;
  },

  update(planId, patch) {
    const plan = stmtPlanById.get(planId);
    if (!plan) throw Object.assign(new Error('Plan not found'), { status: 404 });
    stmtUpdatePlan.run({
      id: planId,
      day_start: patch.day_start ?? plan.day_start,
      abstract_piste_count: Number.isInteger(patch.abstract_piste_count) ? patch.abstract_piste_count : plan.abstract_piste_count,
      abstract_referee_count: Number.isInteger(patch.abstract_referee_count) ? patch.abstract_referee_count : plan.abstract_referee_count,
      default_max_flights_pool: patch.default_max_flights_pool === undefined
        ? plan.default_max_flights_pool : (patch.default_max_flights_pool || null),
      default_max_flights_de: patch.default_max_flights_de === undefined
        ? plan.default_max_flights_de : (patch.default_max_flights_de || null),
      de_rest_minutes: patch.de_rest_minutes === undefined
        ? plan.de_rest_minutes : (Number(patch.de_rest_minutes) || 0),
      default_max_pistes_de: patch.default_max_pistes_de === undefined
        ? plan.default_max_pistes_de : (patch.default_max_pistes_de || null),
    });
    return stmtPlanById.get(planId);
  },

  findStages(planId) {
    return stmtStagesForPlan.all(planId).map(s => ({ ...s, depends_on: parseDependsOn(s.depends_on) }));
  },

  // Per-competition start-time overrides, as { [competitionId]: 'HH:MM' } —
  // e.g. Sabre starting later than Foil/Epee in the same tournament because
  // it has fewer fencers and shorter bouts. A competition with no row here
  // falls back to the plan's own day_start (see _buildSolverInput).
  findCompetitionStarts(planId) {
    const out = {};
    for (const row of stmtCompetitionStartsForPlan.all(planId)) out[row.competition_id] = row.day_start;
    return out;
  },

  // dayStart: null/'' clears the override (falls back to the plan's own
  // day_start again); otherwise upserts it.
  setCompetitionStart(planId, competitionId, dayStart) {
    if (!dayStart) {
      stmtDeleteCompetitionStart.run(planId, competitionId);
    } else {
      stmtUpsertCompetitionStart.run({ plan_id: planId, competition_id: competitionId, day_start: dayStart });
    }
    return this.findCompetitionStarts(planId);
  },

  addStage(planId, data) {
    if (!data.competition_id) throw Object.assign(new Error('competition_id is required'), { status: 400 });
    if (!['pool', 'de'].includes(data.phase_type)) throw Object.assign(new Error('phase_type must be pool or de'), { status: 400 });
    const nextOrder = stmtNextStageOrder.get(planId, data.competition_id).next_order;
    const ruleDoc = data.rule_doc || defaultRuleDoc(data.phase_type);
    const estimatedN = Number.isInteger(data.estimated_n)
      ? data.estimated_n
      : (data.phase_type === 'de'
          ? estimatedNForDeStage(data.competition_id, this._poolDependency(data.depends_on))
          : defaultEstimatedN(data.competition_id));
    const pistesAssigned = Number.isInteger(data.pistes_assigned)
      ? data.pistes_assigned
      : this._suggestedPistes({ phase_type: data.phase_type, rule_doc: ruleDoc, estimated_n: estimatedN }, data.competition_id);
    const { lastInsertRowid } = stmtInsertStage.run({
      plan_id: planId,
      competition_id: data.competition_id,
      format_stage_id: null,
      label: data.label || (data.phase_type === 'pool' ? 'Pool Round' : 'Direct Elimination'),
      stage_order: nextOrder,
      depends_on: JSON.stringify(Array.isArray(data.depends_on) ? data.depends_on : []),
      phase_type: data.phase_type,
      rule_doc: ruleDoc,
      estimated_n: estimatedN,
      pistes_assigned: pistesAssigned,
    });
    return stmtStageById.get(lastInsertRowid);
  },

  // A stage's initial pistes_assigned defaults to the computed "run every
  // pool/DE-round-chunk in parallel" suggestion (schedulePlanEstimate.js's
  // suggestedPistes) instead of a flat 1 — otherwise a large field's whole
  // pool round would default to a single piste, running every pool
  // sequentially, which is never what the director actually wants as a
  // starting point (see "the scheduler puts all pools on one piste").
  // Clamped to real+available pistes by the solver itself at resolve time,
  // so an oversized suggestion here never breaks anything — just gets
  // capped. Always overridable by the director afterward either way.
  _suggestedPistes(stageLike, competitionId) {
    const competition = Competition.findById(competitionId);
    const metrics = computeStageMetrics(stageLike, competition);
    return metrics.suggestedPistes || 1;
  },

  // Finds the pool-type stage among dependsOn (local schedule_plan_stages
  // ids), if any — used by estimatedNForDeStage above to project a DE
  // stage's estimate from what actually advances out of pools, rather than
  // defaulting to the same raw entrant count. Only the first pool dependency
  // found is used; a DE stage depending on more than one pool stage isn't a
  // shape this tool models.
  _poolDependency(dependsOnIds) {
    for (const id of (dependsOnIds || [])) {
      const dep = stmtStageById.get(id);
      if (dep && dep.phase_type === 'pool') return dep;
    }
    return null;
  },

  updateStage(stageId, patch) {
    const stage = stmtStageById.get(stageId);
    if (!stage) throw Object.assign(new Error('Stage not found'), { status: 404 });
    stmtUpdateStage.run({
      id: stageId,
      label: patch.label ?? stage.label,
      estimated_n: Number.isInteger(patch.estimated_n) ? patch.estimated_n : stage.estimated_n,
      pistes_assigned: Number.isInteger(patch.pistes_assigned) ? patch.pistes_assigned : stage.pistes_assigned,
      depends_on: patch.depends_on !== undefined ? JSON.stringify(patch.depends_on) : stage.depends_on,
      rule_doc: patch.rule_doc ?? stage.rule_doc,
      max_flights: patch.max_flights === undefined ? stage.max_flights : (patch.max_flights || null),
      max_pistes: patch.max_pistes === undefined ? stage.max_pistes : (patch.max_pistes || null),
    });
    return stmtStageById.get(stageId);
  },

  removeStage(stageId) {
    stmtDeleteStage.run(stageId);
  },

  // Director action: reset estimated_n. Never automatic (see
  // docs/schedule-planner-algorithm.md) — a deliberate what-if override on a
  // stage's N is never silently clobbered; this only runs when the director
  // explicitly asks for it. For a pool stage (or a stand-alone DE stage),
  // that's the competition's current real registered-competitor count. For a
  // DE stage that depends on a pool stage, it's a projection of what
  // actually advances out of that pool stage's *current* estimated_n (see
  // estimatedNForDeStage) — refresh the pool stage first if you also want
  // that number updated from registrations; this only re-derives the DE
  // stage's own number from whatever the pool stage currently says.
  refreshEstimateFromRegistrations(stageId) {
    const stage = stmtStageById.get(stageId);
    if (!stage) throw Object.assign(new Error('Stage not found'), { status: 404 });
    const estimatedN = stage.phase_type === 'de'
      ? estimatedNForDeStage(stage.competition_id, this._poolDependency(parseDependsOn(stage.depends_on)))
      : defaultEstimatedN(stage.competition_id);
    stmtUpdateStage.run({
      id: stageId, label: stage.label, estimated_n: estimatedN,
      pistes_assigned: stage.pistes_assigned, depends_on: stage.depends_on, rule_doc: stage.rule_doc,
      max_flights: stage.max_flights, max_pistes: stage.max_pistes,
    });
    return stmtStageById.get(stageId);
  },

  // Creates/refreshes one schedule_plan_stages row per format.stages[]
  // entry for a format-driven competition (services/formats.js's
  // Format.loadFormat/stageDependencies). Idempotent: re-running when the
  // format hasn't changed only refreshes label/rule_doc on already-synced
  // stages — estimated_n/pistes_assigned/manual edits are left untouched.
  syncStagesFromFormat(planId, competitionId) {
    const comp = Competition.findById(competitionId);
    if (!comp?.format_id) throw Object.assign(new Error('Competition has no format assigned'), { status: 400 });
    const format = Format.loadFormat(comp.format_id);
    if (!format) throw Object.assign(new Error('Format not found: ' + comp.format_id), { status: 400 });

    const localIdByFormatStageId = new Map();

    for (const stage of format.stages) {
      const ruleDoc = stage.rule || defaultRuleDoc(stage.phaseType);
      const existing = stmtFindStageByFormatStageId.get(planId, competitionId, stage.id);
      if (existing) {
        stmtUpdateStageFromFormat.run({ id: existing.id, label: stage.label, phase_type: stage.phaseType, rule_doc: ruleDoc });
        localIdByFormatStageId.set(stage.id, existing.id);
      } else {
        const nextOrder = stmtNextStageOrder.get(planId, competitionId).next_order;
        // format.stages lists a pool stage before whatever depends on it, so
        // by the time we reach a DE stage its pool dependency (if any)
        // already has a local row this loop either just inserted or found
        // pre-existing above — read it back to project a realistic estimate
        // (see estimatedNForDeStage) instead of defaulting to the same raw
        // entrant count as the pool stage itself.
        let poolDependency = null;
        if (stage.phaseType === 'de') {
          for (const depFormatId of Format.stageDependencies(format, stage)) {
            const depFormatStage = format.stages.find(fs => fs.id === depFormatId);
            const depLocalId = localIdByFormatStageId.get(depFormatId);
            if (depFormatStage?.phaseType === 'pool' && depLocalId != null) {
              poolDependency = stmtStageById.get(depLocalId);
              break;
            }
          }
        }
        const estimatedN = stage.phaseType === 'de'
          ? estimatedNForDeStage(competitionId, poolDependency)
          : defaultEstimatedN(competitionId);
        const pistesAssigned = this._suggestedPistes(
          { phase_type: stage.phaseType, rule_doc: ruleDoc, estimated_n: estimatedN }, competitionId
        );
        const { lastInsertRowid } = stmtInsertStage.run({
          plan_id: planId, competition_id: competitionId, format_stage_id: stage.id,
          label: stage.label, stage_order: nextOrder, depends_on: '[]',
          phase_type: stage.phaseType, rule_doc: ruleDoc,
          estimated_n: estimatedN, pistes_assigned: pistesAssigned,
        });
        localIdByFormatStageId.set(stage.id, lastInsertRowid);
      }
    }

    // Second pass: translate each format stage's dependsOn (format stage
    // ids) into the local schedule_plan_stages ids now that every stage in
    // this format has a local row.
    for (const stage of format.stages) {
      const deps = Format.stageDependencies(format, stage)
        .map(depId => localIdByFormatStageId.get(depId))
        .filter(id => id != null);
      stmtSetDependsOn.run(JSON.stringify(deps), localIdByFormatStageId.get(stage.id));
    }

    return this.findStages(planId).filter(s => s.competition_id === competitionId);
  },

  // Director's manual override of a single solved slot (2026-08-29) — e.g.
  // swapping which piste a round landed on, via the double-click dialog on
  // schedule-planner.html's Gantt. Provisional by design, same as any other
  // hand-adjustment to the auto-solved layout: schedule_plan_slots is
  // wholesale replaced on every resolve() call, so this edit naturally lasts
  // only until the plan is next re-solved. Accepts any of strip_id/
  // abstract_piste_index/scheduled_start/scheduled_end — only the v1 dialog
  // sends strip_id today, but a future dialog field (e.g. editing time)
  // needs no backend change, just a new field in the same PATCH body.
  // strip_id and abstract_piste_index are mutually exclusive (schema CHECK
  // constraint) — setting one always clears the other; whichever field the
  // caller doesn't mention keeps its current value.
  updateSlot(slotId, patch) {
    const slot = stmtSlotById.get(slotId);
    if (!slot) throw Object.assign(new Error('Slot not found'), { status: 404 });
    let strip_id = slot.strip_id;
    let abstract_piste_index = slot.abstract_piste_index;
    if (patch.strip_id !== undefined) {
      strip_id = patch.strip_id || null;
      abstract_piste_index = strip_id ? null : abstract_piste_index;
    }
    if (patch.abstract_piste_index !== undefined) {
      abstract_piste_index = patch.abstract_piste_index || null;
      strip_id = abstract_piste_index ? null : strip_id;
    }
    stmtUpdateSlot.run({
      id: slotId,
      strip_id,
      abstract_piste_index,
      scheduled_start: patch.scheduled_start ?? slot.scheduled_start,
      scheduled_end: patch.scheduled_end ?? slot.scheduled_end,
    });
    return stmtSlotById.get(slotId);
  },

  // Full read view: plan + stages (with parsed computed_json) + slots +
  // per-competition start overrides + per-round overrides + piste reservations.
  findPlanView(planId) {
    const plan = stmtPlanById.get(planId);
    if (!plan) return null;
    const stages = this.findStages(planId).map(s => ({
      ...s,
      computed: s.computed_json ? JSON.parse(s.computed_json) : null,
    }));
    const slots = stmtSlotsForPlan.all(planId);
    const competitionStarts = this.findCompetitionStarts(planId);
    // Grouped { [stageId]: { [tableauSize]: { fixed_start, buffer_after_minutes } } }
    // for convenient per-stage, per-round lookup in the UI — tableau_size 0
    // is the pool/whole-stage sentinel (see migration 044).
    const roundOverrides = {};
    for (const o of this.findRoundOverrides(planId)) {
      (roundOverrides[o.schedule_plan_stage_id] ??= {})[o.tableau_size] = {
        fixed_start: o.fixed_start, buffer_after_minutes: o.buffer_after_minutes,
      };
    }
    // { [stripId]: { competition_id, from_tableau_size } } — see migration 045.
    const pisteReservations = {};
    for (const r of this.findPisteReservations(planId)) {
      pisteReservations[r.strip_id] = { competition_id: r.competition_id, from_tableau_size: r.from_tableau_size };
    }
    return { plan, stages, slots, competitionStarts, roundOverrides, pisteReservations };
  },
};

const SchedulePlans = Object.assign({}, SchedulePlanCore, Overrides, Resolve);

module.exports = SchedulePlans;
