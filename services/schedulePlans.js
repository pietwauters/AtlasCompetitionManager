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
const { computeStageMetrics, defaultRuleDoc, projectAdvancement } = require('./schedulePlanEstimate');
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
    abstract_referee_count = @abstract_referee_count,
    default_max_flights_pool = @default_max_flights_pool, default_max_flights_de = @default_max_flights_de,
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
    max_flights = @max_flights
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
      default_max_flights_pool: patch.default_max_flights_pool === undefined
        ? plan.default_max_flights_pool : (patch.default_max_flights_pool || null),
      default_max_flights_de: patch.default_max_flights_de === undefined
        ? plan.default_max_flights_de : (patch.default_max_flights_de || null),
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
    });
    return stmtStageById.get(stageId);
  },

  removeStage(stageId) {
    stmtDeleteStage.run(stageId);
  },

  // Director action: reset estimated_n. Never automatic (see the design
  // doc) — a deliberate what-if override on a stage's N is never silently
  // clobbered; this only runs when the director explicitly asks for it. For
  // a pool stage (or a stand-alone DE stage), that's the competition's
  // current real registered-competitor count. For a DE stage that depends
  // on a pool stage, it's a projection of what actually advances out of
  // that pool stage's *current* estimated_n (see estimatedNForDeStage) —
  // refresh the pool stage first if you also want that number updated from
  // registrations; this only re-derives the DE stage's own number from
  // whatever the pool stage currently says.
  refreshEstimateFromRegistrations(stageId) {
    const stage = stmtStageById.get(stageId);
    if (!stage) throw Object.assign(new Error('Stage not found'), { status: 404 });
    const estimatedN = stage.phase_type === 'de'
      ? estimatedNForDeStage(stage.competition_id, this._poolDependency(parseDependsOn(stage.depends_on)))
      : defaultEstimatedN(stage.competition_id);
    stmtUpdateStage.run({
      id: stageId, label: stage.label, estimated_n: estimatedN,
      pistes_assigned: stage.pistes_assigned, depends_on: stage.depends_on, rule_doc: stage.rule_doc,
      max_flights: stage.max_flights,
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

  // ---------------------------------------------------------------------------
  // Solve
  // ---------------------------------------------------------------------------

  // Non-persisting "what if I had this many pistes" query — pure abstract
  // piste numbering, no schedule_plan_slots written.
  previewForPistes(planId, totalPistes) {
    const plan = stmtPlanById.get(planId);
    if (!plan) throw Object.assign(new Error('Plan not found'), { status: 404 });
    const { solverUnits } = this._buildSolverInput(planId);
    const competitionStart = this.findCompetitionStarts(planId);
    return Solver.solveForPistes(solverUnits, this._buildPisteList(totalPistes), plan.day_start, competitionStart);
  },

  // Non-persisting "how many pistes to meet this deadline" query.
  previewForDeadline(planId, deadlineTime) {
    const plan = stmtPlanById.get(planId);
    if (!plan) throw Object.assign(new Error('Plan not found'), { status: 404 });
    const { solverUnits } = this._buildSolverInput(planId);
    const competitionStart = this.findCompetitionStarts(planId);
    return Solver.solveForDeadline(
      solverUnits, deadlineTime, plan.day_start, competitionStart, n => this._buildPisteList(n)
    );
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
    const competitionStart = this.findCompetitionStarts(planId);

    const solved = Solver.simulate(solverUnits, {
      pistes: this._buildPisteList(totalPistes), dayStart: plan.day_start, competitionStart,
    });
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

    // Flights warning: a unit in max-flights mode (_buildSolverInput) got
    // fewer pistes than its flights target wanted — the only way that
    // happens is the solver's own eligibility clamp (services/
    // schedulePlanSolver.js) finding fewer eligible pistes than requested,
    // since the request itself was already the *minimum* needed to hit the
    // target. Surfaced per real stage (a DE stage's rounds are merged into
    // one list) the same way referee shortfalls already are.
    const flightsWarningsByStageId = new Map();
    for (const u of solverUnits) {
      if (!u.targetFlights) continue;
      const r = resultByUnitId.get(u.id);
      const pistesGot = r?.pistesUsed?.length || 0;
      if (pistesGot >= u.pistesAssigned) continue; // target was met
      const actualFlights = Math.ceil(u.workUnitCount / Math.max(1, pistesGot));
      if (!flightsWarningsByStageId.has(u.realStageId)) flightsWarningsByStageId.set(u.realStageId, []);
      flightsWarningsByStageId.get(u.realStageId).push({
        round: u.roundIndex != null ? u.roundIndex + 1 : null,
        tableauSize: u.tableauSize || null,
        targetFlights: u.targetFlights,
        actualFlights,
        pistesWanted: u.pistesAssigned,
        pistesGot,
      });
    }

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
          JSON.stringify({
            ...metrics, start: window?.start, end: window?.end,
            referees: shortfalls.get(stage.id) || null,
            flightsWarnings: flightsWarningsByStageId.get(stage.id) || null,
          }),
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
  // sequentially (round 2 can't start until round 1's winners exist).
  //
  // Each unit's piste count comes from one of two modes (see the 2026-08-27
  // "flights" design note):
  //   - max-flights mode (stage.max_flights, or failing that the plan's own
  //     default_max_flights_pool/_de for that phase type): the piste count
  //     is *derived* — "never use more pistes than needed to stay within N
  //     flights" — ceil(poolCount / maxFlights) for a pool stage, or
  //     ceil(boutsInRound / maxFlights) per DE round. This is what makes a
  //     stage only ever claim the minimum it needs, leaving room for other
  //     competitions' stages to run concurrently on the rest.
  //   - fixed mode (today's behavior, when neither is set): the director's
  //     own pistes_assigned number is used directly, clamped to a round's
  //     own bout count for DE so a final never "uses" more pistes than
  //     there are bouts.
  // Either way each unit carries targetFlights/workUnitCount so resolve()
  // can tell, after solving, whether piste *eligibility* forced fewer
  // pistes than the flights target wanted — see the flights-warning code
  // there.
  // Every unit is tagged with realStageId so results can be grouped back by
  // the real schedule_plan_stages row after solving.
  _buildSolverInput(planId) {
    const plan = stmtPlanById.get(planId);
    const stages = this.findStages(planId);
    const competitionById = new Map();
    for (const s of stages) {
      if (!competitionById.has(s.competition_id)) competitionById.set(s.competition_id, Competition.findById(s.competition_id));
    }

    const units = [];
    const lastUnitIdByStageId = new Map();

    for (const s of stages) {
      const metrics = computeStageMetrics(s, competitionById.get(s.competition_id));
      const maxFlights = s.max_flights
        || (s.phase_type === 'pool' ? plan.default_max_flights_pool : plan.default_max_flights_de)
        || null;

      if (s.phase_type === 'de' && metrics.roundBoutCounts?.length) {
        let prevUnitId = null;
        metrics.roundBoutCounts.forEach((boutsInRound, i) => {
          const pistesForRound = maxFlights
            ? Math.max(1, Math.ceil(boutsInRound / maxFlights))
            : Math.max(1, Math.min(s.pistes_assigned || 1, boutsInRound));
          const unitId = `${s.id}:r${i}`;
          units.push({
            id: unitId,
            realStageId: s.id,
            competitionId: s.competition_id,
            dependsOn: i === 0 ? null : [prevUnitId], // i===0 filled in below, once every stage's last unit is known
            order: s.stage_order,
            durationMinutes: Math.ceil(boutsInRound * metrics.minutesPerBout / pistesForRound),
            pistesAssigned: pistesForRound,
            phaseType: 'de',
            // Tableau size for this round — boutsInRound is half the round's
            // own tableau (round of 32 = 16 bouts, etc; see
            // schedulePlanEstimate.js's deRoundBoutCounts) — used against a
            // piste's max_de_tableau (services/strips.js).
            tableauSize: boutsInRound * 2,
            targetFlights: maxFlights,
            workUnitCount: boutsInRound,
            roundIndex: i,
          });
          prevUnitId = unitId;
        });
        lastUnitIdByStageId.set(s.id, prevUnitId);
      } else {
        const poolCount = metrics.poolCount || 1;
        const pistesAssigned = maxFlights
          ? Math.max(1, Math.ceil(poolCount / maxFlights))
          : s.pistes_assigned;
        const unitId = `${s.id}:main`;
        units.push({
          id: unitId,
          realStageId: s.id,
          competitionId: s.competition_id,
          dependsOn: null, // filled in below
          order: s.stage_order,
          durationMinutes: metrics.totalBoutMinutes
            ? Math.ceil(metrics.totalBoutMinutes / Math.max(1, pistesAssigned))
            : 0,
          pistesAssigned,
          phaseType: s.phase_type,
          targetFlights: s.phase_type === 'pool' ? maxFlights : null,
          workUnitCount: s.phase_type === 'pool' ? poolCount : null,
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

  // Builds a piste-capability list of exactly `n` entries for
  // services/schedulePlanSolver.js: as many real strips' own capabilities as
  // fit (services/strips.js's pools_allowed/de_allowed/max_de_tableau/min_de_tableau,
  // ordered by strip_number same as everywhere else pistes get numbered),
  // padded with fully-open abstract pistes for the rest — an abstract piste
  // is a hypothetical "if we had one more" placeholder, never a specific
  // physical piste, so it has no capability restriction of its own. Shared
  // by previewForPistes/previewForDeadline (arbitrary n, purely
  // hypothetical) and resolve (n = real strips + abstract_piste_count,
  // reusing every real strip's actual capabilities).
  _buildPisteList(n) {
    const realStrips = Strip.findAll();
    const pistes = [];
    for (let i = 0; i < n; i++) {
      const strip = realStrips[i];
      pistes.push(strip
        ? {
            poolsAllowed: !!strip.pools_allowed, deAllowed: !!strip.de_allowed,
            maxDeTableau: strip.max_de_tableau, minDeTableau: strip.min_de_tableau,
          }
        : { poolsAllowed: true, deAllowed: true, maxDeTableau: null, minDeTableau: null });
    }
    return pistes;
  },

  // Full read view: plan + stages (with parsed computed_json) + slots +
  // per-competition start overrides.
  findPlanView(planId) {
    const plan = stmtPlanById.get(planId);
    if (!plan) return null;
    const stages = this.findStages(planId).map(s => ({
      ...s,
      computed: s.computed_json ? JSON.parse(s.computed_json) : null,
    }));
    const slots = stmtSlotsForPlan.all(planId);
    const competitionStarts = this.findCompetitionStarts(planId);
    return { plan, stages, slots, competitionStarts };
  },
};

module.exports = SchedulePlans;
