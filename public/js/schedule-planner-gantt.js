'use strict';
// schedule-planner.html Alpine mixin: Gantt rendering. Same absolutely-
// positioned-percentage-bar technique as public/js/opp2-core.js's
// ganttData (see that file for the precedent) — the only real difference is
// what color encodes: there it's bout status (pending/active/done), here
// it's competition identity (see schedule-planner-core.js's
// competitionColor), since that's the whole point of this view — a director
// telling which competition's estimated stages land where at a glance.

function schedulePlannerGantt() {
  return {
    get ganttData() {
      void this.themeTick;
      const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
      const fmtMin = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

      const stageById = new Map(this.stages.map(s => [s.id, s]));
      const slots = this.slots.filter(sl => sl.scheduled_start && sl.scheduled_end && stageById.has(sl.schedule_plan_stage_id));
      if (!slots.length) return { hasData: false, rows: [], ticks: [], legend: [] };

      const starts = slots.map(sl => toMin(sl.scheduled_start));
      const ends   = slots.map(sl => toMin(sl.scheduled_end));
      const axisStart = Math.floor(Math.min(...starts) / 30) * 30;
      const axisEnd   = Math.ceil(Math.max(...ends) / 30) * 30;
      const total = Math.max(axisEnd - axisStart, 30);

      const ticks = [];
      for (let t = axisStart; t <= axisEnd; t += 30) {
        ticks.push({ label: fmtMin(t), left: (t - axisStart) / total * 100, isHour: t % 60 === 0 });
      }

      // One row per piste (real strip or abstract placeholder), keyed so
      // real and abstract pistes never collide even if their numeric ids overlap.
      const pisteKey = sl => sl.strip_id != null ? `strip:${sl.strip_id}` : `abstract:${sl.abstract_piste_index}`;
      const pisteLabel = sl => sl.strip_id != null ? this.stripName(sl.strip_id) : `Piste (extra) ${sl.abstract_piste_index}`;
      const pisteSort = sl => sl.strip_id != null ? [0, sl.strip_id] : [1, sl.abstract_piste_index];

      // A DE stage's slots span several distinct (start,end) blocks, one per
      // tableau round, all sharing the same schedule_plan_stage_id — the
      // slot rows themselves don't carry a round number. But the rounds run
      // strictly in chronological order (round 2 can't start before round 1
      // finishes — see _buildSolverInput's dependsOn chain), so sorting each
      // DE stage's distinct blocks by start time and pairing them 1:1 with
      // stage.computed.roundBoutCounts (same order, biggest round first)
      // recovers which round each block is, with no extra persisted state.
      const roundTableauByStageBlock = new Map(); // stageId -> Map(`${start}|${end}` -> tableauSize)
      for (const stage of this.stages) {
        const counts = stage.computed?.roundBoutCounts;
        if (stage.phase_type !== 'de' || !counts?.length) continue;
        const blocks = [...new Set(
          slots.filter(sl => sl.schedule_plan_stage_id === stage.id).map(sl => `${sl.scheduled_start}|${sl.scheduled_end}`)
        )].sort((a, b) => toMin(a.split('|')[0]) - toMin(b.split('|')[0]));
        const byBlock = new Map();
        blocks.forEach((block, i) => { if (counts[i] != null) byBlock.set(block, counts[i] * 2); });
        roundTableauByStageBlock.set(stage.id, byBlock);
      }

      const rowMap = new Map();
      for (const sl of slots) {
        const key = pisteKey(sl);
        if (!rowMap.has(key)) rowMap.set(key, { key, name: pisteLabel(sl), sortKey: pisteSort(sl), bars: [] });
        const stage = stageById.get(sl.schedule_plan_stage_id);
        const s0 = toMin(sl.scheduled_start);
        const s1 = toMin(sl.scheduled_end);
        const tableauSize = roundTableauByStageBlock.get(stage.id)?.get(`${sl.scheduled_start}|${sl.scheduled_end}`);
        rowMap.get(key).bars.push({
          id: sl.id,
          left: (s0 - axisStart) / total * 100,
          width: Math.max((s1 - s0) / total * 100, 0.5),
          color: this.competitionColor(stage.competition_id),
          label: `${this.competitionName(stage.competition_id)} — ${stage.label}` + (tableauSize ? ` · T${tableauSize}` : ''),
          start: sl.scheduled_start,
          end: sl.scheduled_end,
        });
      }

      const rows = [...rowMap.values()].sort((a, b) =>
        a.sortKey[0] - b.sortKey[0] || a.sortKey[1] - b.sortKey[1]);

      const legend = this.competitionOrder.map(compId => ({
        competition_id: compId,
        name: this.competitionName(compId),
        color: this.competitionColor(compId),
      }));

      return { hasData: true, rows, ticks, legend };
    },
  };
}
