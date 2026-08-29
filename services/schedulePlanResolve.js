'use strict';

// The tournament schedule planner's solve orchestration — builds the solver-
// unit list services/schedulePlanSolver.js consumes, turns it into a real
// piste layout, and persists it. See docs/schedule-planner-algorithm.md for
// the full model. Split out of schedulePlans.js (2026-08-28) once that file
// crossed the project's god-file threshold — this is the piece expected to
// keep growing (more referee-related constraints are planned), so isolating
// it now gives that growth an obvious home. Merged back onto the same
// SchedulePlans object in schedulePlans.js (Object.assign), not required
// independently, so every method still sees the same `this` (findStages,
// findRoundOverrides, findPisteReservations, findCompetitionStarts,
// findPlanView all live in the other split files) regardless of which file
// defined it.

const db = require('../db');
const Strip = require('./strips');
const Competition = require('./competitions');
const { computeStageMetrics } = require('./schedulePlanEstimate');
const Solver = require('./schedulePlanSolver');
const { computeShortfalls } = require('./schedulePlanReferees');

// Re-declared here (also in schedulePlans.js) rather than requiring that
// file back — a second prepared statement for the same trivial SELECT is
// cheap and avoids a circular require between the split files.
const stmtPlanById = db.prepare('SELECT * FROM schedule_plans WHERE id = ?');

const stmtDeleteSlotsForStage = db.prepare('DELETE FROM schedule_plan_slots WHERE schedule_plan_stage_id = ?');
const stmtInsertSlot = db.prepare(`
  INSERT INTO schedule_plan_slots
    (schedule_plan_stage_id, strip_id, abstract_piste_index, scheduled_start, scheduled_end)
  VALUES (@stage_id, @strip_id, @abstract_piste_index, @start, @end)
`);
const stmtSetComputedJson = db.prepare('UPDATE schedule_plan_stages SET computed_json = ? WHERE id = ?');

module.exports = {
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
    const stagesById = new Map(stages.map(s => [s.id, s]));

    // Per-round overrides (fixed start / explicit buffer-after — 2026-08-28
    // discussion), keyed the same way they're stored: `${stageId}:${tableauSize}`,
    // 0 meaning "the stage's own single unit" (a pool phase). A stage's
    // OUTPUT point for buffer-after purposes is its pool unit (0) or its
    // DE final (tableau_size 2, always the last round regardless of bracket
    // size) — used below when a unit's dependency is a WHOLE OTHER STAGE
    // (round 0 of a DE stage, or a pool unit) rather than the previous
    // round within its own stage.
    const overridesMap = new Map(
      this.findRoundOverrides(planId).map(o => [`${o.schedule_plan_stage_id}:${o.tableau_size}`, o])
    );
    const stageOutputKey = depStage => (depStage.phase_type === 'pool' ? 0 : 2);
    const explicitBufferFromStageDeps = depIds => {
      const bufs = (depIds || []).map(depId => {
        const depStage = stagesById.get(depId);
        return depStage ? (overridesMap.get(`${depId}:${stageOutputKey(depStage)}`)?.buffer_after_minutes || 0) : 0;
      });
      return bufs.length ? Math.max(...bufs) : 0;
    };

    const units = [];
    const lastUnitIdByStageId = new Map();

    for (const s of stages) {
      const metrics = computeStageMetrics(s, competitionById.get(s.competition_id));
      const maxFlights = s.max_flights
        || (s.phase_type === 'pool' ? plan.default_max_flights_pool : plan.default_max_flights_de)
        || null;
      // Referee-driven hard cap on simultaneous DE piste usage (migration
      // 046, 2026-08-28): once opportunistic widening lets a round grab
      // every free/eligible piste, the real limit stops being pistes and
      // becomes qualified referees. Plan-wide default + per-stage override,
      // same pattern as max_flights. DE only.
      const maxPistesDe = s.phase_type === 'de'
        ? (s.max_pistes || plan.default_max_pistes_de || null)
        : null;

      if (s.phase_type === 'de' && metrics.roundBoutCounts?.length) {
        let prevUnitId = null;
        let prevFlights = null;
        let prevTableauSize = null;
        metrics.roundBoutCounts.forEach((boutsInRound, i) => {
          // flightsFloor is the TRUE flights-math target (or the director's
          // own fixed number in non-flights mode) — kept separate from
          // pistesForRound below purely so the flights-warning can still
          // report "you wanted N" accurately even when a referee cap (not
          // piste eligibility) is what actually reduced it.
          const flightsFloor = maxFlights
            ? Math.max(1, Math.ceil(boutsInRound / maxFlights))
            : Math.max(1, Math.min(s.pistes_assigned || 1, boutsInRound));
          // pistesForRound is what actually gets asked of the solver as the
          // floor — referees are a hard physical constraint regardless of
          // mode, so the cap clamps this even in fixed (non-flights) mode.
          const pistesForRound = maxPistesDe ? Math.min(flightsFloor, maxPistesDe) : flightsFloor;
          // The one-flight-worth ceiling (opportunistic-widening upper
          // bound) gets the same referee clamp.
          const pistesCeiling = maxFlights ? boutsInRound : pistesForRound;
          const cappedCeiling = maxPistesDe ? Math.min(pistesCeiling, maxPistesDe) : pistesCeiling;
          // flights (used below for the rest-buffer minGap formula) is
          // deliberately derived from the CLAMPED floor, not flightsFloor —
          // if referees genuinely limit this round to fewer pistes than the
          // flights setting wanted, more flights are really needed, and the
          // safety calculation should reflect that reality, not the
          // unclamped target.
          const flights = Math.ceil(boutsInRound / pistesForRound);
          const tableauSize = boutsInRound * 2;
          const unitId = `${s.id}:r${i}`;

          // Fencer-safety buffer (2026-08-27/28 discussion) — DE round-to-
          // round only (i>0); round 0's dependency is nothing or a pool
          // stage, handled via explicitBufferFromStageDeps below instead.
          // Both rounds process bouts in tableau-position order via
          // contiguous per-piste chunks (matches real bout-to-piste
          // assignment elsewhere — o.87.1/o.93.2's "one quarter of the
          // table per piste"), so every piste-chunk boundary in the
          // PREVIOUS round (prevFlights) lands at that round's own true
          // finish time. The current round's tightest bout is only fed by
          // one of those late-finishing bouts — zero natural gap — when
          // prevFlights isn't dramatically larger than this round's own
          // flights count; otherwise the earliest chunk boundary already
          // falls past this round's own first flight, leaving real natural
          // slack that reduces (or eliminates) the auto-calculated top-up.
          // A director's own explicit buffer-after (on the PREVIOUS round's
          // override) can only push this higher, never lower than the
          // auto-calculated safety minimum — "take the longer" per the
          // 2026-08-28 discussion.
          let restMinutes = 0;
          if (i > 0) {
            const configured = plan.de_rest_minutes || 0;
            const minGap = Math.max(0, Math.ceil(Math.ceil(prevFlights / 2) / flights) - 1) * metrics.minutesPerBout;
            const autoCalc = Math.max(0, configured - minGap);
            const explicitBuffer = overridesMap.get(`${s.id}:${prevTableauSize}`)?.buffer_after_minutes || 0;
            restMinutes = Math.max(autoCalc, explicitBuffer);
          }
          const fixedStart = overridesMap.get(`${s.id}:${tableauSize}`)?.fixed_start || null;

          units.push({
            id: unitId,
            realStageId: s.id,
            competitionId: s.competition_id,
            dependsOn: i === 0 ? null : [prevUnitId], // i===0 filled in below, once every stage's last unit is known
            order: s.stage_order,
            // workMinutes is the round's total bout-minutes — the solver
            // derives actual duration from however many pistes it ends up
            // using (see schedulePlanSolver.js's findBestSlot), not a fixed
            // number computed here.
            workMinutes: boutsInRound * metrics.minutesPerBout,
            // pistesAssigned is what actually goes to the solver as the
            // floor — the flights-cap floor (or the director's own fixed
            // number in non-flights mode), clamped by the referee cap if
            // one applies. maxPistesAssigned (one-flight-worth, also
            // referee-capped) lets the solver use idle extra pistes to
            // finish this round sooner instead of always settling for the
            // floor even when nothing else needs the rest (2026-08-28).
            // targetPistesAssigned keeps the TRUE, unclamped flights target
            // around purely for the flights-warning below, so a referee-cap
            // shortfall is reported accurately ("wanted N") even though the
            // solver itself never asked for more than the capped amount.
            pistesAssigned: pistesForRound,
            maxPistesAssigned: cappedCeiling,
            targetPistesAssigned: flightsFloor,
            phaseType: 'de',
            // Tableau size for this round — boutsInRound is half the round's
            // own tableau (round of 32 = 16 bouts, etc; see
            // schedulePlanEstimate.js's deRoundBoutCounts) — used against a
            // piste's max_de_tableau (services/strips.js) and as the
            // override key above.
            tableauSize,
            targetFlights: maxFlights,
            workUnitCount: boutsInRound,
            roundIndex: i,
            restMinutes,
            fixedStart,
          });
          prevUnitId = unitId;
          prevFlights = flights;
          prevTableauSize = tableauSize;
        });
        lastUnitIdByStageId.set(s.id, prevUnitId);
      } else {
        const poolCount = metrics.poolCount || 1;
        const pistesAssigned = maxFlights
          ? Math.max(1, Math.ceil(poolCount / maxFlights))
          : s.pistes_assigned;
        // One piste per pool is the natural ceiling — no benefit running
        // more than poolCount pistes for a pool stage. Only widens in
        // flights mode for an actual pool stage; the rare DE-with-
        // insufficient-N edge case (falls in here since it has no
        // roundBoutCounts to derive a real ceiling from) just keeps its
        // fixed pistesAssigned, same as non-flights mode.
        const maxPistesAssigned = maxFlights && s.phase_type === 'pool'
          ? Math.max(1, poolCount)
          : pistesAssigned;
        const unitId = `${s.id}:main`;
        units.push({
          id: unitId,
          realStageId: s.id,
          competitionId: s.competition_id,
          dependsOn: null, // filled in below
          order: s.stage_order,
          workMinutes: metrics.totalBoutMinutes || 0,
          pistesAssigned,
          maxPistesAssigned,
          phaseType: s.phase_type,
          targetFlights: s.phase_type === 'pool' ? maxFlights : null,
          workUnitCount: s.phase_type === 'pool' ? poolCount : null,
          // restMinutes filled in below (depends on s.depends_on, resolved
          // once for every dependsOn===null unit alongside dependsOn itself).
          fixedStart: overridesMap.get(`${s.id}:0`)?.fixed_start || null,
        });
        lastUnitIdByStageId.set(s.id, unitId);
      }
    }

    // A stage's first unit inherits the real stage's own depends_on list,
    // translated from real stage ids to those stages' LAST unit id — so a
    // stage depending on a DE stage waits for its final round, not round 1.
    // Its restMinutes (round 0 of a DE stage, or a pool unit — anything
    // whose dependency is a WHOLE OTHER STAGE rather than the previous
    // round within its own stage) comes purely from any explicit buffer-
    // after configured on that dependency's own output — there's no
    // auto-calculated fencer-rest component for a pool->DE handoff or a
    // pool->pool chain, only what the director explicitly asks for.
    for (const s of stages) {
      const firstUnit = units.find(u => u.realStageId === s.id && u.dependsOn === null);
      firstUnit.dependsOn = s.depends_on.map(depId => lastUnitIdByStageId.get(depId)).filter(Boolean);
      firstUnit.restMinutes = Math.max(firstUnit.restMinutes || 0, explicitBufferFromStageDeps(s.depends_on));
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
  // planId: needed to look up this plan's own competition-exclusive piste
  // reservations (migration 045) — plan-scoped, not a strips property, so
  // it can't come from Strip.findAll() alone.
  _buildPisteList(n, planId) {
    const realStrips = Strip.findAll();
    const reservationByStripId = new Map(
      this.findPisteReservations(planId).map(r => [r.strip_id, r])
    );
    const pistes = [];
    for (let i = 0; i < n; i++) {
      const strip = realStrips[i];
      const reservation = strip ? reservationByStripId.get(strip.id) : null;
      pistes.push(strip
        ? {
            poolsAllowed: !!strip.pools_allowed, deAllowed: !!strip.de_allowed,
            maxDeTableau: strip.max_de_tableau, minDeTableau: strip.min_de_tableau,
            reservedForCompetitionId: reservation?.competition_id ?? null,
            reservedFromTableauSize: reservation?.from_tableau_size ?? null,
          }
        : {
            poolsAllowed: true, deAllowed: true, maxDeTableau: null, minDeTableau: null,
            reservedForCompetitionId: null, reservedFromTableauSize: null,
          });
    }
    return pistes;
  },

  // Non-persisting "what if I had this many pistes" query — pure abstract
  // piste numbering, no schedule_plan_slots written.
  previewForPistes(planId, totalPistes) {
    const plan = stmtPlanById.get(planId);
    if (!plan) throw Object.assign(new Error('Plan not found'), { status: 404 });
    const { solverUnits } = this._buildSolverInput(planId);
    const competitionStart = this.findCompetitionStarts(planId);
    return Solver.solveForPistes(solverUnits, this._buildPisteList(totalPistes, planId), plan.day_start, competitionStart);
  },

  // Non-persisting "how many pistes to meet this deadline" query.
  previewForDeadline(planId, deadlineTime) {
    const plan = stmtPlanById.get(planId);
    if (!plan) throw Object.assign(new Error('Plan not found'), { status: 404 });
    const { solverUnits } = this._buildSolverInput(planId);
    const competitionStart = this.findCompetitionStarts(planId);
    return Solver.solveForDeadline(
      solverUnits, deadlineTime, plan.day_start, competitionStart, n => this._buildPisteList(n, planId)
    );
  },

  // The persisting "make this the plan's current layout" action — uses the
  // plan's own configured piste pool (real strips + abstract_piste_count),
  // writes schedule_plan_slots, and layers the referee-shortfall analysis
  // on top. This is the "auto-solve first, then adjustable" starting point
  // the director then hand-edits; re-running always re-derives every slot
  // from the stages' current inputs (see docs/schedule-planner-algorithm.md's
  // "one evolving plan, re-solved as inputs change" model).
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
      pistes: this._buildPisteList(totalPistes, planId), dayStart: plan.day_start, competitionStart,
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
    // fewer pistes than its flights target wanted — either the solver's own
    // eligibility clamp (services/schedulePlanSolver.js) found fewer
    // eligible pistes than requested, or a referee-driven max-pistes-de cap
    // (migration 046) capped it below the target itself. targetPistesAssigned
    // is the TRUE, unclamped flights target (falls back to pistesAssigned
    // for pool units, which the referee cap never touches), so the "wanted"
    // figure stays accurate either way. Surfaced per real stage (a DE
    // stage's rounds are merged into one list) the same way referee
    // shortfalls already are.
    const flightsWarningsByStageId = new Map();
    for (const u of solverUnits) {
      if (!u.targetFlights) continue;
      const r = resultByUnitId.get(u.id);
      const pistesGot = r?.pistesUsed?.length || 0;
      const pistesWanted = u.targetPistesAssigned ?? u.pistesAssigned;
      if (pistesGot >= pistesWanted) continue; // target was met
      const actualFlights = Math.ceil(u.workUnitCount / Math.max(1, pistesGot));
      if (!flightsWarningsByStageId.has(u.realStageId)) flightsWarningsByStageId.set(u.realStageId, []);
      flightsWarningsByStageId.get(u.realStageId).push({
        round: u.roundIndex != null ? u.roundIndex + 1 : null,
        tableauSize: u.tableauSize || null,
        targetFlights: u.targetFlights,
        actualFlights,
        pistesWanted,
        pistesGot,
      });
    }

    // Fixed-start notices: two kinds, different severity. A unit with a
    // fixed_start override (services/schedulePlanSolver.js applies it as a
    // floor, never pulling the start earlier) either got pushed past it —
    // a real "missed" warning, comparing the FINAL actual start (which can
    // be later than the fixed time for either a dependency-timing reason or
    // a piste-availability one, both real causes) — or has natural slack
    // before it, an "idle" info note only (often intentional, e.g. the
    // final running in a different room/venue — not something to flag as
    // wrong, per the 2026-08-28 discussion).
    const fixedStartNoticesByStageId = new Map();
    for (const u of solverUnits) {
      if (!u.fixedStart) continue;
      const r = resultByUnitId.get(u.id);
      if (!r) continue;
      const requestedMin = Solver.toMinutes(u.fixedStart);
      const actualMin = Solver.toMinutes(r.start);
      const naturalMin = Solver.toMinutes(r.naturalStart);
      const notice = actualMin > requestedMin
        ? { severity: 'warning', requested: u.fixedStart, actual: r.start, missedByMinutes: actualMin - requestedMin }
        : naturalMin < requestedMin
          ? { severity: 'info', requested: u.fixedStart, idleMinutes: requestedMin - naturalMin }
          : null;
      if (!notice) continue;
      notice.round = u.roundIndex != null ? u.roundIndex + 1 : null;
      notice.tableauSize = u.tableauSize || null;
      if (!fixedStartNoticesByStageId.has(u.realStageId)) fixedStartNoticesByStageId.set(u.realStageId, []);
      fixedStartNoticesByStageId.get(u.realStageId).push(notice);
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
            fixedStartNotices: fixedStartNoticesByStageId.get(stage.id) || null,
          }),
          stage.id
        );
      }
    });
    writeAll();

    return this.findPlanView(planId);
  },
};
