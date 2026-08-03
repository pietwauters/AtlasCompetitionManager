'use strict';

// Tournament schedule planner — Phase 1 (estimation/what-if tool). Orchestrates
// the pure per-stage math (schedulePlanEstimate.js), the greedy piste solver
// (schedulePlanSolver.js), and the referee-shortfall analysis
// (schedulePlanReferees.js) into one persisted plan per tournament. See the
// project's schedule-planner design doc for the full model — deliberately
// decoupled from pipeline_slots/phases/pools; nothing here writes to the live
// scheduling tables.

const db = require('../db');
const Strip = require('./strips');
const Competition = require('./competitions');
const Competitor = require('./competitors');
const Format = require('./formats');
const { computeStageMetrics, defaultRuleDoc } = require('./schedulePlanEstimate');
const Solver = require('./schedulePlanSolver');
const { computeShortfalls } = require('./schedulePlanReferees');

// ---------------------------------------------------------------------------
// Prepared statements — module-level constants (CLAUDE.md hard rule).
// ---------------------------------------------------------------------------
const stmtPlanByTournament = db.prepare('SELECT * FROM schedule_plans WHERE tournament_id = ?');
const stmtPlanById         = db.prepare('SELECT * FROM schedule_plans WHERE id = ?');
const stmtInsertPlan       = db.prepare('INSERT INTO schedule_plans (tournament_id) VALUES (?)');
const stmtUpdatePlan       = db.prepare(`
  UPDATE schedule_plans SET day_start = @day_start, abstract_piste_count = @abstract_piste_count,
    abstract_referee_count = @abstract_referee_count, updated_at = datetime('now')
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
    pistes_assigned = @pistes_assigned, depends_on = @depends_on, rule_doc = @rule_doc
  WHERE id = @id
`);
const stmtSetDependsOn    = db.prepare('UPDATE schedule_plan_stages SET depends_on = ? WHERE id = ?');
const stmtSetComputedJson = db.prepare('UPDATE schedule_plan_stages SET computed_json = ? WHERE id = ?');
const stmtDeleteStage     = db.prepare('DELETE FROM schedule_plan_stages WHERE id = ?');

const stmtDeleteSlotsForStage = db.prepare('DELETE FROM schedule_plan_slots WHERE schedule_plan_stage_id = ?');
const stmtInsertSlot = db.prepare(`
  INSERT INTO schedule_plan_slots
    (schedule_plan_stage_id, strip_id, abstract_piste_index, scheduled_start, scheduled_end)
  VALUES (@stage_id, @strip_id, @abstract_piste_index, @start, @end)
`);
const stmtSlotsForPlan = db.prepare(`
  SELECT sl.* FROM schedule_plan_slots sl
  JOIN schedule_plan_stages st ON st.id = sl.schedule_plan_stage_id
  WHERE st.schedule_plan_id = ?
`);

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

const SchedulePlans = {
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
    });
    return stmtPlanById.get(planId);
  },

  findStages(planId) {
    return stmtStagesForPlan.all(planId).map(s => ({ ...s, depends_on: parseDependsOn(s.depends_on) }));
  },

  addStage(planId, data) {
    if (!data.competition_id) throw Object.assign(new Error('competition_id is required'), { status: 400 });
    if (!['pool', 'de'].includes(data.phase_type)) throw Object.assign(new Error('phase_type must be pool or de'), { status: 400 });
    const nextOrder = stmtNextStageOrder.get(planId, data.competition_id).next_order;
    const ruleDoc = data.rule_doc || defaultRuleDoc(data.phase_type);
    const estimatedN = Number.isInteger(data.estimated_n) ? data.estimated_n : defaultEstimatedN(data.competition_id);
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
    });
    return stmtStageById.get(stageId);
  },

  removeStage(stageId) {
    stmtDeleteStage.run(stageId);
  },

  // Director action: reset estimated_n to the competition's current real
  // registered-competitor count. Never automatic (see the design doc) — a
  // deliberate what-if override on a stage's N is never silently clobbered;
  // this only runs when the director explicitly asks for it.
  refreshEstimateFromRegistrations(stageId) {
    const stage = stmtStageById.get(stageId);
    if (!stage) throw Object.assign(new Error('Stage not found'), { status: 404 });
    stmtUpdateStage.run({
      id: stageId, label: stage.label, estimated_n: defaultEstimatedN(stage.competition_id),
      pistes_assigned: stage.pistes_assigned, depends_on: stage.depends_on, rule_doc: stage.rule_doc,
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
        const estimatedN = defaultEstimatedN(competitionId);
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

  // ---------------------------------------------------------------------------
  // Solve
  // ---------------------------------------------------------------------------

  // Non-persisting "what if I had this many pistes" query — pure abstract
  // piste numbering, no schedule_plan_slots written.
  previewForPistes(planId, totalPistes) {
    const plan = stmtPlanById.get(planId);
    if (!plan) throw Object.assign(new Error('Plan not found'), { status: 404 });
    const { solverUnits } = this._buildSolverInput(planId);
    return Solver.solveForPistes(solverUnits, totalPistes, plan.day_start);
  },

  // Non-persisting "how many pistes to meet this deadline" query.
  previewForDeadline(planId, deadlineTime) {
    const plan = stmtPlanById.get(planId);
    if (!plan) throw Object.assign(new Error('Plan not found'), { status: 404 });
    const { solverUnits } = this._buildSolverInput(planId);
    return Solver.solveForDeadline(solverUnits, deadlineTime, plan.day_start);
  },

  // The persisting "make this the plan's current layout" action — uses the
  // plan's own configured piste pool (real strips + abstract_piste_count),
  // writes schedule_plan_slots, and layers the referee-shortfall analysis
  // on top. This is the "auto-solve first, then adjustable" starting point
  // the director then hand-edits; re-running always re-derives every slot
  // from the stages' current inputs (see the design doc's "one evolving
  // plan, re-solved as inputs change" model).
  //
  // A DE stage produces multiple slot rows at DIFFERENT times (one cluster
  // per tableau round — see _buildSolverInput), not one shared window like a
  // pool stage — the schema already supports this (schedule_plan_slots has
  // no constraint tying every slot of a stage to the same start/end), so no
  // migration was needed to fix "all pistes finish the tableau at once".
  resolve(planId) {
    const plan = stmtPlanById.get(planId);
    if (!plan) throw Object.assign(new Error('Plan not found'), { status: 404 });

    const { stages, solverUnits, competitionById } = this._buildSolverInput(planId);
    const realStrips  = Strip.findAll();
    const totalPistes = realStrips.length + plan.abstract_piste_count;
    if (totalPistes < 1) {
      throw Object.assign(new Error('No pistes available — add strips or set an abstract piste count.'), { status: 400 });
    }

    const solved = Solver.simulate(solverUnits, { totalPistes, dayStart: plan.day_start });
    const resultByUnitId = new Map(solved.stageResults.map(r => [r.id, r]));

    // Group unit results back by the real stage they belong to (a pool
    // stage always has exactly one unit; a DE stage has one per round).
    const resultsByStageId = new Map();
    for (const u of solverUnits) {
      const r = resultByUnitId.get(u.id);
      if (!resultsByStageId.has(u.realStageId)) resultsByStageId.set(u.realStageId, []);
      resultsByStageId.get(u.realStageId).push(r);
    }

    // Referee-shortfall clustering only ever looks at pool stages (see
    // schedulePlanReferees.js), which always resolve to a single unit, so a
    // stage's overall [firstStart, lastEnd] window is exactly that unit's window.
    const stageWindows = stages.map(s => {
      const rs = resultsByStageId.get(s.id) || [];
      return { id: s.id, start: rs[0]?.start, end: rs[rs.length - 1]?.end };
    });
    const shortfalls = computeShortfalls(stages, stageWindows, plan.abstract_referee_count);

    const writeAll = db.transaction(() => {
      for (const stage of stages) {
        stmtDeleteSlotsForStage.run(stage.id);
        const results = resultsByStageId.get(stage.id) || [];
        for (const r of results) {
          for (const pisteIdx of r.pistesUsed) {
            const isReal = pisteIdx < realStrips.length;
            stmtInsertSlot.run({
              stage_id: stage.id,
              strip_id: isReal ? realStrips[pisteIdx].id : null,
              abstract_piste_index: isReal ? null : (pisteIdx - realStrips.length + 1),
              start: r.start,
              end: r.end,
            });
          }
        }
        const metrics = computeStageMetrics(stage, competitionById.get(stage.competition_id));
        const window = stageWindows.find(w => w.id === stage.id);
        stmtSetComputedJson.run(
          JSON.stringify({ ...metrics, start: window?.start, end: window?.end, referees: shortfalls.get(stage.id) || null }),
          stage.id
        );
      }
    });
    writeAll();

    return this.findPlanView(planId);
  },

  // Builds the solver-unit list services/schedulePlanSolver.js consumes.
  // A pool stage is exactly one unit. A DE stage explodes into one unit per
  // tableau round (schedulePlanEstimate.js's roundBoutCounts), chained
  // sequentially (round 2 can't start until round 1's winners exist) —
  // each round's piste count is clamped to that round's own bout count, so
  // a stage assigned e.g. 16 pistes naturally tapers: 16 in round 1, 8 in
  // round 2, ..., down to 1 for the final, rather than every assigned piste
  // running the whole tableau's total bout-minutes and finishing together.
  // Every unit is tagged with realStageId so results can be grouped back by
  // the real schedule_plan_stages row after solving.
  _buildSolverInput(planId) {
    const stages = this.findStages(planId);
    const competitionById = new Map();
    for (const s of stages) {
      if (!competitionById.has(s.competition_id)) competitionById.set(s.competition_id, Competition.findById(s.competition_id));
    }

    const units = [];
    const lastUnitIdByStageId = new Map();

    for (const s of stages) {
      const metrics = computeStageMetrics(s, competitionById.get(s.competition_id));

      if (s.phase_type === 'de' && metrics.roundBoutCounts?.length) {
        let prevUnitId = null;
        metrics.roundBoutCounts.forEach((boutsInRound, i) => {
          const pistesForRound = Math.max(1, Math.min(s.pistes_assigned || 1, boutsInRound));
          const unitId = `${s.id}:r${i}`;
          units.push({
            id: unitId,
            realStageId: s.id,
            dependsOn: i === 0 ? null : [prevUnitId], // i===0 filled in below, once every stage's last unit is known
            order: s.stage_order,
            durationMinutes: Math.ceil(boutsInRound * metrics.minutesPerBout / pistesForRound),
            pistesAssigned: pistesForRound,
          });
          prevUnitId = unitId;
        });
        lastUnitIdByStageId.set(s.id, prevUnitId);
      } else {
        const unitId = `${s.id}:main`;
        units.push({
          id: unitId,
          realStageId: s.id,
          dependsOn: null, // filled in below
          order: s.stage_order,
          durationMinutes: metrics.totalBoutMinutes
            ? Math.ceil(metrics.totalBoutMinutes / Math.max(1, s.pistes_assigned))
            : 0,
          pistesAssigned: s.pistes_assigned,
        });
        lastUnitIdByStageId.set(s.id, unitId);
      }
    }

    // A stage's first unit inherits the real stage's own depends_on list,
    // translated from real stage ids to those stages' LAST unit id — so a
    // stage depending on a DE stage waits for its final round, not round 1.
    for (const s of stages) {
      const firstUnit = units.find(u => u.realStageId === s.id && u.dependsOn === null);
      firstUnit.dependsOn = s.depends_on.map(depId => lastUnitIdByStageId.get(depId)).filter(Boolean);
    }

    return { stages, solverUnits: units, competitionById };
  },

  // Full read view: plan + stages (with parsed computed_json) + slots.
  findPlanView(planId) {
    const plan = stmtPlanById.get(planId);
    if (!plan) return null;
    const stages = this.findStages(planId).map(s => ({
      ...s,
      computed: s.computed_json ? JSON.parse(s.computed_json) : null,
    }));
    const slots = stmtSlotsForPlan.all(planId);
    return { plan, stages, slots };
  },
};

module.exports = SchedulePlans;
