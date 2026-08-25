// opp2.html Alpine mixin — the by-referee Gantt/schedule view. Split out of
// opp2.html's single ~1200-line app() (2026-07-29 architecture-review
// god-file split) — see opp2-core.js for the merge-mixins explanation.
function opp2RefereeSchedule() {
  return {
    selectedReferee: '',
    refSchedule: [],

    get refGanttData() {
      void this._tick;
      void this.ganttVersion;
      const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
      const fmtMin = m => `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
      const colorOf = s => s.status === 'done' ? '#999' : s.status === 'active' ? '#1e8449' : '#1a6bab';
      const scheduled = this.strips.flatMap(strip =>
        strip.slots.filter(s => s.scheduled_start && s.officials?.length).map(s => ({ strip, slot: s }))
      );
      if (!scheduled.length) return { hasData: false, rows: [], ticks: [], nowLeft: null };
      const starts = scheduled.map(({ slot: s }) => toMin(s.scheduled_start));
      const ends   = scheduled.filter(({ slot: s }) => s.predicted_end).map(({ slot: s }) => toMin(this.predictedAdjustedEnd(s)));
      const axisStart = Math.floor(Math.min(...starts) / 30) * 30;
      const axisEnd   = Math.ceil((ends.length ? Math.max(...ends) : Math.max(...starts) + 60) / 30) * 30;
      const total = axisEnd - axisStart;
      const ticks = [];
      for (let t = axisStart; t <= axisEnd; t += 30)
        ticks.push({ label: fmtMin(t), left: (t - axisStart) / total * 100, isHour: t % 60 === 0 });
      const refMap = new Map();
      for (const { strip, slot } of scheduled) {
        for (const official of slot.officials) {
          if (!refMap.has(official.referee_id)) {
            const name = [official.last_name, official.first_name].filter(Boolean).join(', ') || `Referee ${official.referee_id}`;
            refMap.set(official.referee_id, { name, bars: [] });
          }
          const adjustedEnd = this.predictedAdjustedEnd(slot);
          const s0 = toMin(slot.scheduled_start);
          const s1 = adjustedEnd ? toMin(adjustedEnd) : s0 + 30;
          const roleSuffix = official.role === 'referee' ? '' : ` (${this.roleLabel(official.role)})`;
          refMap.get(official.referee_id).bars.push({
            id: slot.id + '_' + official.role, left: (s0 - axisStart) / total * 100,
            width: Math.max((s1 - s0) / total * 100, 0.5),
            color: colorOf(slot), label: (strip.name || 'Piste ' + strip.strip_number) + ' — ' + this.slotLabel(slot) + roleSuffix,
            start: slot.scheduled_start, end: adjustedEnd,
          });
        }
      }
      const rows = [...refMap.values()].sort((a, b) => a.name.localeCompare(b.name));
      const now = new Date();
      const nowLeft = Math.max(0, Math.min(100, (now.getHours() * 60 + now.getMinutes() - axisStart) / total * 100));
      return { hasData: true, rows, ticks, nowLeft };
    },

    async loadRefereeSchedule() {
      if (!this.selectedReferee) { this.refSchedule = []; return; }
      this.refSchedule = await fetch(`/api/opp2/pipeline/referee/${this.selectedReferee}`)
        .then(r => r.json()).catch(() => []);
    },
  };
}
