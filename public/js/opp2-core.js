// opp2.html Alpine mixin — core state, lifecycle loads, strip-list helpers,
// misc formatting/partition-math helpers, and the two low-level building
// blocks (_patchSlot/_computeSlotEnd) other mixins (conflict resolution,
// drag/reorder) share. Split out of opp2.html's single ~1200-line app()
// (2026-07-29 architecture-review god-file split) — see opp2.html's own
// <script> block for how the mixins are merged back into one Alpine
// component, and why a naive {...a, ...b} spread would have silently
// broken every `get xxx()` computed property here.
function opp2Core() {
  return {
    notice: { text: '', error: false },
    status: { connected: false, brokerUrl: '', pistes: [] },
    strips: [],
    expandedSlots: new Set(),
    _tick: 0,
    hideOffline: false,
    referees: [],
    availablePools: [],
    availableDePhases: [],
    availableTeamMatches: [],
    availableVirtualStages: [],
    selectedStripId: null,
    boutStandards: [],
    poolAssignmentMap: {},   // { pool_id: [strip names] }
    noStartTimeModal: { open: false, onContinue: null },
    ganttVersion: 0,
    isNarrow: false,

    async init() {
      await Promise.all([
        this.loadStatus(),
        this.loadStrips(),
        this.loadReferees(),
        this.loadAvailablePhases(),
        this.loadBoutStandards(),
      ]);
      this.resetAddForm();
      setInterval(() => this.loadStatus(), 5000);
      setInterval(() => this._tick++, 60000);

      // Below this width, the strip list and pipeline detail can't both fit
      // comfortably side by side — switch to a master-detail drill-down
      // instead of squeezing both panels. Width-driven, not orientation:
      // a narrow landscape phone should behave the same as a narrow portrait one.
      const mq = window.matchMedia('(max-width: 900px)');
      this.isNarrow = mq.matches;
      mq.addEventListener('change', (e) => { this.isNarrow = e.matches; });
    },

    backToStrips() { this.selectedStripId = null; },

    async loadStatus() {
      const s = await fetch('/api/opp2/status').then(r => r.json()).catch(() => ({ connected: false, pistes: [] }));
      this.status = s;
    },

    async loadStrips() {
      const data = await fetch('/api/opp2/pipeline').then(r => r.json()).catch(() => []);
      this.strips = data;
      this.ganttVersion++;
      // Rebuild pool assignment map each time strips refresh.
      const map = {};
      for (const s of this.strips) {
        for (const sl of s.slots) {
          if (sl.pool_id) {
            if (!map[sl.pool_id]) map[sl.pool_id] = [];
            map[sl.pool_id].push(s.name || 'Piste ' + s.strip_number);
          }
        }
      }
      this.poolAssignmentMap = map;
    },

    // "Clear the entire schedule" — every strip's queue, system-wide, real
    // and planned/virtual slots alike (services/pipelineSlots.js's
    // clearAll()). Destructive and irreversible — a plain browser confirm()
    // stating exactly how many slots are about to go, not a silent action.
    // Does not touch phases/pools/bouts/competitors/results or
    // schedule-planner.html's own separate plan.
    async clearEntireSchedule() {
      const n = this.strips.reduce((sum, s) => sum + (s.slots?.length || 0), 0);
      if (n === 0) { this.showNotice('Schedule is already empty'); return; }
      if (!confirm(
        `Clear the ENTIRE schedule — all ${n} slot${n !== 1 ? 's' : ''} across every strip, ` +
        `including any "planned" placeholders? This cannot be undone. Phases, pools, bouts, ` +
        `and competitors are not affected — only the strip schedule itself.`
      )) return;
      const r = await fetch('/api/opp2/pipeline', { method: 'DELETE' });
      if (!r.ok) { const d = await r.json().catch(() => ({})); this.showNotice(d.error || 'Clear failed', true); return; }
      const result = await r.json();
      this.lastBulkSlotIds = [];
      await this.loadStrips();
      this.showNotice(`Schedule cleared — ${result.cleared} slot${result.cleared !== 1 ? 's' : ''} removed.`);
    },

    async loadReferees() {
      this.referees = await fetch('/api/people?role=referee').then(r => r.json()).catch(() => []);
    },

    async loadBoutStandards() {
      this.boutStandards = await fetch('/api/opp2/bout-standards').then(r => r.json()).catch(() => []);
    },

    async loadAvailablePhases() {
      const [comps, teamMatches] = await Promise.all([
        fetch('/api/competitions').then(r => r.json()).catch(() => []),
        fetch('/api/team-matches/available').then(r => r.json()).catch(() => []),
      ]);
      const pools = [], dePhases = [], virtualStages = [];
      for (const c of comps) {
        // Fetched up front (not just for virtualStages below) so a skeleton
        // DE phase's round-1 bulk-assign preview can show an expected-bye
        // count before seedSkeleton ever runs — see estimatedAdvancedCount
        // below and services/formats.js's getFormatPlan.
        const plan = c.format_id
          ? await fetch(`/api/competitions/${c.id}/format-plan`).then(r => r.json()).catch(() => null)
          : null;

        const phases = await fetch(`/api/competitions/${c.id}/phases`).then(r => r.json()).catch(() => []);
        for (const ph of phases) {
          if (ph.type === 'pool') {
            const phPools = await fetch(`/api/phases/${ph.id}/pools`).then(r => r.json()).catch(() => []);
            for (const p of phPools) {
              pools.push({ ...p, competition_name: c.name, competition_id: c.id,
                           phase_status: ph.status, weapon: c.weapon, gender: c.gender });
            }
          } else if (ph.type === 'de') {
            const stage = ph.status === 'skeleton'
              ? plan?.stages.find(s => s.id === ph.format_stage) : null;
            dePhases.push({ ...ph, competition_name: c.name,
              weapon: c.weapon, gender: c.gender,
              phase_label: `DE Phase ${ph.phase_order} (${ph.status})`,
              estimated_advanced_count: stage?.estimatedAdvancedCount ?? null });
          }
        }

        // Pool format stages that don't have a real phase yet — a placeholder
        // to reserve strip time before the phase exists at all. DE stages are
        // deliberately excluded here: services/dePhases.js's createSkeleton
        // (competition-detail.html's "Build bracket now") is strictly better
        // for DE — a real phase with real rounds/matches, fencers filled in
        // later, not an opaque blob — so DE should always go through that
        // instead of a virtual placeholder. Pools have no such skeleton
        // mechanism yet (pool sizing depends on near-final registration, not
        // just the format), so this is still the only option there.
        // GET /api/competitions/:id/format-plan already computes phaseId
        // (null == not yet real) per stage; no new endpoint needed.
        for (const stage of plan?.stages || []) {
          if (stage.phaseId != null || stage.phaseType !== 'pool') continue;
          virtualStages.push({
            competition_id: c.id, competition_name: c.name,
            weapon: c.weapon, gender: c.gender,
            format_stage_id: stage.id, phase_type: stage.phaseType, label: stage.label,
          });
        }
      }
      this.availablePools         = pools;
      this.availableDePhases      = dePhases;
      this.availableTeamMatches   = teamMatches;
      this.availableVirtualStages = virtualStages;
    },

    // ── Computed ─────────────────────────────────────────────────────────────

    get selectedStrip() {
      return this.strips.find(s => s.id === this.selectedStripId) || null;
    },

    get sortedStrips() {
      return [...this.strips].sort((a, b) => {
        const la = this.liveState(a.name), lb = this.liveState(b.name);
        const offA = la !== null && !la?.apparatusOnline ? 1 : 0;
        const offB = lb !== null && !lb?.apparatusOnline ? 1 : 0;
        if (offA !== offB) return offA - offB;
        const actA = la?.bout ? -1 : 0, actB = lb?.bout ? -1 : 0;
        if (actA !== actB) return actA - actB;
        return a.strip_number - b.strip_number;
      });
    },

    get otherStrips() {
      return this.strips.filter(s => s.id !== this.selectedStripId);
    },

    get areStripsAdjacent() {
      if (!this.multiStrips.length) return true;
      const cur = this.selectedStrip;
      if (!cur) return true;
      const nums = [cur.strip_number, ...this.multiStrips.map(sid => {
        const s = this.strips.find(st => st.id === sid);
        return s ? s.strip_number : null;
      })].filter(n => n != null).sort((a, b) => a - b);
      for (let i = 1; i < nums.length; i++) {
        if (nums[i] - nums[i - 1] > 1) return false;
      }
      return true;
    },

    get ganttData() {
      void this._tick;
      void this.ganttVersion;
      const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
      const fmtMin = m => `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
      const colorOf = s => s.status === 'done' ? '#999' : s.status === 'active' ? '#1e8449' : '#1a6bab';
      const scheduled = this.strips.flatMap(strip =>
        strip.slots.filter(s => s.scheduled_start).map(s => ({ strip, slot: s }))
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
      const rows = this.strips
        .filter(strip => strip.slots.some(s => s.scheduled_start))
        .map(strip => ({
          name: strip.name || ('Piste ' + strip.strip_number),
          bars: strip.slots.filter(s => s.scheduled_start).map(s => {
            const adjustedEnd = this.predictedAdjustedEnd(s);
            const s0 = toMin(s.scheduled_start);
            const s1 = adjustedEnd ? toMin(adjustedEnd) : s0 + 30;
            return { id: s.id, left: (s0 - axisStart) / total * 100,
                     width: Math.max((s1 - s0) / total * 100, 0.5),
                     color: colorOf(s), label: this.slotLabel(s),
                     start: s.scheduled_start, end: adjustedEnd };
          }),
        }));
      const now = new Date();
      const nowLeft = Math.max(0, Math.min(100, (now.getHours() * 60 + now.getMinutes() - axisStart) / total * 100));
      return { hasData: true, rows, ticks, nowLeft };
    },

    // ── Strip list helpers ────────────────────────────────────────────────────

    selectStrip(strip) {
      this.selectedStripId = strip.id;
      this.resetAddForm();
    },

    dotStyle(strip) {
      const s = this.liveState(strip.name);
      if (!s) return 'background:#ccc';
      return s.apparatusOnline ? 'background:#1e8449' : 'background:#c0392b';
    },

    pendingSlotCount(strip) {
      return strip.slots.filter(s => s.status !== 'done').length;
    },

    stripTimeRange(strip) {
      const starts = strip.slots.filter(s => s.scheduled_start).map(s => s.scheduled_start);
      const ends   = strip.slots.filter(s => s.predicted_end).map(s => this.predictedAdjustedEnd(s));
      if (!starts.length) return '';
      const start = starts.reduce((a, b) => a < b ? a : b);
      const end   = ends.length ? ends.reduce((a, b) => a > b ? a : b) : '';
      return end ? `${start} → ${end}` : start;
    },

    liveState(stripName) {
      return this.status.pistes?.find(p => p.pisteId === stripName) || null;
    },

    isOffline(strip) {
      const s = this.liveState(strip.name);
      return s !== null && !s.apparatusOnline;
    },

    // ── Pool assignment helpers ───────────────────────────────────────────────

    poolIsAssigned(poolId) {
      // Treat as assigned only if assigned to a strip OTHER than the current one.
      const names = this.poolAssignmentMap[poolId];
      if (!names?.length) return false;
      const curName = this.selectedStrip ? (this.selectedStrip.name || 'Piste ' + this.selectedStrip.strip_number) : null;
      return names.some(n => n !== curName);
    },

    poolAssignedStrips(poolId) {
      return (this.poolAssignmentMap[poolId] || []).join(', ');
    },

    // ── Misc helpers ──────────────────────────────────────────────────────────

    showSlot(slot, idx, slots) {
      if (slot.status !== 'done') return true;
      const lastDoneIdx = slots.reduce((last, s, i) => s.status === 'done' ? i : last, -1);
      return idx === lastDoneIdx;
    },

    slotLabel(slot) {
      if (slot.type === 'pool')
        return `${slot.competition_name || '?'} — Pool ${slot.pool_number || '?'}`;
      if (slot.type === 'de') {
        const name = slot.competition_name || '?';
        const t = slot.tableau || '?';
        // Which round this is within the tableau — the one thing a bare "DE
        // T8" label never showed, easy to miss once a bracket has several
        // rounds pre-scheduled at once (services/dePhases.js's
        // createSkeleton makes that routine, not an edge case).
        const roundLabel = slot.bracket === 'repechage' ? `Rep D${slot.de_round ?? '?'}`
          : slot.bracket === 'placement' ? 'Placement'
          : slot.de_round ? `R${slot.de_round}` : '';
        const prefix = `${name} — DE T${t}` + (roundLabel ? ` ${roundLabel}` : '');
        const [lo, hi] = this.boutRangeForPartition(slot.partition, slot.tableau);
        const boutsInSlot = hi - lo + 1;
        // fillDeByeInfo (lib/deSlotMath.js) only resolves once round 1 has
        // been seeded with real competitors — before that de_bye_count/
        // de_bout_total are undefined, and slotPredictedByeCount above fills
        // the gap with a clearly-marked estimate instead (same math as
        // opp2-bulk-assign.js's bulkDePreview shows before this slot even
        // existed).
        const resolvedCount = slot.de_bye_count > 0 ? slot.de_bye_count : 0;
        const predictedCount = resolvedCount ? 0 : this.slotPredictedByeCount(slot);
        const byeSuffix = resolvedCount
          ? (resolvedCount === slot.de_bout_total ? ' (bye)' : ` (${resolvedCount} bye)`)
          : predictedCount
            ? (predictedCount === boutsInSlot ? ' (predicted bye)' : ` (~${predictedCount} predicted bye)`)
            : '';
        if (!slot.partition || slot.partition === 'full') return prefix + byeSuffix;
        return (lo === hi ? `${prefix} bout ${lo}` : `${prefix} bouts ${lo}–${hi}`) + byeSuffix;
      }
      if (slot.type === 'team_match')
        return `${slot.competition_name || '?'} — ${slot.left_team_name || '?'} vs ${slot.right_team_name || '?'}`;
      if (slot.type === 'virtual')
        return `${slot.competition_name || '?'} — ${slot.virtual_label || '?'} (planned)`;
      return slot.type || '—';
    },

    roleLabel(role) {
      return {
        referee: 'Referee', referee2: 'Referee 2', video_assistant: 'Video Assistant',
        assessor1: 'Assessor 1', assessor2: 'Assessor 2',
      }[role] || role;
    },

    addMinutes(hhmm, mins) {
      if (!hhmm || !mins) return hhmm || null;
      const [h, m] = hhmm.split(':').map(Number);
      const total = h * 60 + m + Math.round(mins);
      return `${String(Math.floor(total / 60) % 24).padStart(2,'0')}:${String(total % 60).padStart(2,'0')}`;
    },

    hasOverlap(prev, curr) {
      if (!prev?.predicted_end || !curr?.scheduled_start) return false;
      return curr.scheduled_start < prev.predicted_end;
    },

    round5(time) {
      if (!time) return time;
      const [h, m] = time.split(':').map(Number);
      const r = Math.round(m / 5) * 5;
      const hh = r === 60 ? h + 1 : h;
      const mm = r === 60 ? 0 : r;
      return `${String(hh % 24).padStart(2,'0')}:${String(mm).padStart(2,'0')}`;
    },

    // ── DE partition math ────────────────────────────────────────────────────
    // Mirrors lib/deSlotMath.js's partitionToRange/rangeToPartition server-side
    // (documented, accepted client/server duplication — a browser page can't
    // require() a server file). Used by slotLabel above, opp2-add-slot.js's
    // submitAddSlot, and opp2-bulk-assign.js's bulkDePreview.

    boutRangeForPartition(partition, tableau) {
      const n = tableau / 2;
      if (!partition || partition === 'full') return [1, n];
      let lo = 1, hi = n;
      for (const ch of partition) {
        const mid = Math.floor((lo + hi) / 2);
        if ('A1aceg'.includes(ch)) hi = mid; else lo = mid + 1;
      }
      return [lo, hi];
    },

    // Inverse of boutRangeForPartition: encode [lo,hi] in [1,n] to a partition code.
    // Returns null if [lo,hi] does not align with a binary-tree node (use multiple slots).
    rangeToPartition(lo, hi, n) {
      if (lo === 1 && hi === n) return 'full';
      const loChars = ['A', '1', 'a', 'c', 'e', 'g'];
      const hiChars = ['B', '2', 'b', 'd', 'f', 'h'];
      let lo_ = 1, hi_ = n, code = '', depth = 0;
      while (lo_ < hi_) {
        const mid = Math.floor((lo_ + hi_) / 2);
        if (lo >= lo_ && hi <= mid)      { code += loChars[depth]; hi_ = mid; }
        else if (lo >= mid + 1 && hi <= hi_) { code += hiChars[depth]; lo_ = mid + 1; }
        else break;
        depth++;
      }
      return (lo_ === lo && hi_ === hi) ? code : null;
    },

    // Mirrors lib/deFormation.js's buildSeedPositions/predictedByePositions —
    // used by opp2-bulk-assign.js's bulkDePreview to flag *which* round-1 DE
    // bouts in a skeleton phase are predicted byes from the estimated
    // headcount, before real seeding resolves them for real (see
    // lib/deSlotMath.js's fillDeByeInfo for the post-seeding, confirmed
    // equivalent shown once the phase is no longer a skeleton).
    buildSeedPositionsClient(T) {
      let slots = [1, 2], cur = 2;
      while (cur < T) {
        cur *= 2;
        const next = [];
        for (let i = 0; i < slots.length; i++) {
          const s = slots[i];
          if (i % 2 === 0) next.push(s, cur + 1 - s);
          else             next.push(cur + 1 - s, s);
        }
        slots = next;
      }
      return slots;
    },

    predictedByePositions(T, N) {
      const seedSlots = this.buildSeedPositionsClient(T);
      const positions = new Set();
      for (let i = 0; i < T; i += 2) {
        if (seedSlots[i] > N || seedSlots[i + 1] > N) positions.add(i / 2 + 1);
      }
      return positions;
    },

    // How many of an already-created DE slot's round-1 bouts are predicted
    // byes, for a skeleton phase that hasn't been seeded yet — the same
    // prediction opp2-bulk-assign.js shows before such a slot is even
    // created, kept visible afterward too (on the strip card and the Gantt
    // bar, both of which render through slotLabel below) so a director
    // reading the schedule can see a round-1 strip will likely run short.
    // Returns 0 once the phase is seeded ('active') — from then on the real,
    // resolved de_bye_count (lib/deSlotMath.js's fillDeByeInfo) takes over.
    slotPredictedByeCount(slot) {
      if (slot.type !== 'de' || slot.de_round !== 1 || !slot.tableau) return 0;
      if (slot.bracket && slot.bracket !== 'main') return 0;
      const phase = this.availableDePhases.find(p => p.id === slot.phase_id);
      if (!phase || phase.status !== 'skeleton' || phase.estimated_advanced_count == null) return 0;
      const predicted = this.predictedByePositions(slot.tableau, phase.estimated_advanced_count);
      const [lo, hi] = this.boutRangeForPartition(slot.partition, slot.tableau);
      let count = 0;
      for (let pos = lo; pos <= hi; pos++) if (predicted.has(pos)) count++;
      return count;
    },

    // services/pipelineSlots.js's withPredictedEnd already discounts a
    // *confirmed* bye (real, post-seeding) from predicted_end server-side.
    // This covers the pre-seeding case: a still-unseeded skeleton's
    // *estimated* byes, which the server deliberately leaves out of
    // predicted_end since they're provisional. Used by ganttData below and
    // opp2-bulk-assign.js's pisteIsBusy, so a round expected to run short
    // doesn't visually/functionally block the next round's start time —
    // falls straight back to the server's own predicted_end whenever no
    // prediction applies (already-seeded, non-DE, or round-1-bye-free).
    predictedAdjustedEnd(slot) {
      if (!slot.predicted_end || !slot.scheduled_start || !slot.effective_minutes_per_bout) return slot.predicted_end;
      const predictedByeCount = this.slotPredictedByeCount(slot);
      if (!predictedByeCount) return slot.predicted_end;
      const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
      const startMin = toMin(slot.scheduled_start);
      const adjustedMin = Math.max(startMin, toMin(slot.predicted_end) - predictedByeCount * slot.effective_minutes_per_bout);
      return `${String(Math.floor(adjustedMin / 60) % 24).padStart(2,'0')}:${String(adjustedMin % 60).padStart(2,'0')}`;
    },

    // Returns the unique partition code for the single bout at round_index i (1-based)
    // in a round of n total bouts.
    partitionForBoutIndex(i, n) {
      if (n === 1) return 'full';
      const loChars = ['A', '1', 'a', 'c', 'e', 'g'];
      const hiChars = ['B', '2', 'b', 'd', 'f', 'h'];
      let lo = 1, hi = n, code = '', depth = 0;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (i <= mid) { code += loChars[depth]; hi = mid; }
        else { code += hiChars[depth]; lo = mid + 1; }
        depth++;
      }
      return code;
    },

    // ── Shared low-level helpers ─────────────────────────────────────────────
    // Used by both opp2-conflict.js (applyConflictResolution/dismissRestore/
    // applyRestore/_conflictPairStillHolds) and opp2-schedule-ops.js
    // (_recascadeStrip) — kept here rather than duplicated per CLAUDE.md's
    // "shared statement, one file" precedent from the services/ split work.

    _computeSlotEnd(slot, start) {
      const mins   = slot.effective_minutes_per_bout || slot.minutes_per_bout;
      const bouts  = slot.bout_count || 1;
      if (!start || !mins || !bouts) return null;
      return this.addMinutes(start, Math.round(mins * bouts));
    },

    async _patchSlot(id, fields) {
      await fetch(`/api/opp2/pipeline/slots/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
      });
    },

    // Shared "no start time" warning modal (see CLAUDE.md) — reused by both
    // opp2-conflict.js's assignOfficial and opp2-bulk-assign.js's
    // confirmSubmitBulkAssign, hence living in Core rather than either.
    async cancelNoStartTime() {
      this.noStartTimeModal = { open: false, onContinue: null };
      // Same reasoning as cancelConflict(): a <select> here uses :selected
      // bindings, not x-model, so the browser may already be showing the
      // just-picked (uncommitted) option — reload to snap it back.
      await this.loadStrips();
    },

    async continueNoStartTime() {
      const fn = this.noStartTimeModal.onContinue;
      this.noStartTimeModal = { open: false, onContinue: null };
      if (fn) await fn();
    },

    showNotice(text, error = false) {
      this.notice = { text, error };
      setTimeout(() => { this.notice = { text: '', error: false }; }, 4000);
    },
  };
}
