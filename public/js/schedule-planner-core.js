'use strict';
// schedule-planner.html Alpine mixin: page state/lifecycle, competition list,
// real strips list, the plan/stage/slot data itself, per-competition color
// assignment, and basic stage CRUD (add/edit/remove/sync-from-format). See
// public/js/schedule-planner-gantt.js for the Gantt rendering that consumes
// this state, schedule-planner-solve.js for the solve actions, and
// schedule-planner-referees.js for the shortfall summary.

// Validated 8-hue categorical palette (colorblind-safe in both themes) —
// see the dataviz skill's reference palette. Assigned in fixed order of
// first appearance, never re-sorted, so a competition keeps its color for
// the life of the plan.
const SCHEDULE_PLANNER_PALETTE = [
  { light: '#2a78d6', dark: '#3987e5' },
  { light: '#eb6834', dark: '#d95926' },
  { light: '#1baf7a', dark: '#199e70' },
  { light: '#eda100', dark: '#c98500' },
  { light: '#e87ba4', dark: '#d55181' },
  { light: '#008300', dark: '#008300' },
  { light: '#4a3aa7', dark: '#9085e9' },
  { light: '#e34948', dark: '#e66767' },
];
const SCHEDULE_PLANNER_OTHER_COLOR = { light: '#9a9890', dark: '#6b6a64' };

function schedulePlannerCore() {
  return {
    tournamentId: null,
    tournament: null,
    competitions: [],
    strips: [],
    plan: null,
    stages: [],
    slots: [],
    loading: true,
    error: '',
    notice: '',
    themeTick: 0,

    newStage: { competition_id: '', phase_type: 'pool', label: '', estimated_n: '', pistes_assigned: 1 },

    async init() {
      const params = new URLSearchParams(location.search);
      this.tournamentId = params.get('tournament_id');
      if (!this.tournamentId) { this.error = 'No tournament_id in URL.'; this.loading = false; return; }
      await this.loadAll();
      this.loading = false;

      // nav.js's theme toggle flips documentElement's data-theme attribute
      // directly — not an Alpine-tracked signal, so ganttData's colors
      // wouldn't otherwise recompute on toggle. Mirrors opp2-core.js's own
      // `void this._tick`-style forced-recompute pattern.
      new MutationObserver(() => { this.themeTick++; })
        .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { this.themeTick++; });
    },

    async loadAll() {
      try {
        const [tournament, competitions, strips, planView] = await Promise.all([
          fetch(`/api/tournaments/${this.tournamentId}`).then(r => r.ok ? r.json() : null),
          fetch(`/api/competitions?tournament_id=${this.tournamentId}`).then(r => r.json()),
          fetch('/api/strips').then(r => r.json()),
          fetch(`/api/schedule-plans/tournament/${this.tournamentId}`).then(r => r.json()),
        ]);
        this.tournament = tournament;
        this.competitions = competitions;
        this.strips = strips;
        this.plan = planView.plan;
        this.stages = planView.stages;
        this.slots = planView.slots;
      } catch (e) {
        this.error = 'Failed to load: ' + e.message;
      }
    },

    async reload() {
      const planView = await fetch(`/api/schedule-plans/tournament/${this.tournamentId}`).then(r => r.json());
      this.plan = planView.plan;
      this.stages = planView.stages;
      this.slots = planView.slots;
    },

    competitionName(compId) {
      const c = this.competitions.find(c => c.id == compId);
      return c ? c.name : ('Competition ' + compId);
    },

    // Fixed order of first appearance — the earliest (lowest-id) stage
    // belonging to each competition decides its palette slot.
    get competitionOrder() {
      const order = [];
      for (const s of [...this.stages].sort((a, b) => a.id - b.id)) {
        if (!order.includes(s.competition_id)) order.push(s.competition_id);
      }
      return order;
    },

    competitionColorPair(compId) {
      const idx = this.competitionOrder.indexOf(compId);
      return idx >= 0 && idx < SCHEDULE_PLANNER_PALETTE.length
        ? SCHEDULE_PLANNER_PALETTE[idx]
        : SCHEDULE_PLANNER_OTHER_COLOR;
    },

    competitionColor(compId) {
      const dark = document.documentElement.getAttribute('data-theme') === 'dark'
        || (!document.documentElement.getAttribute('data-theme') && matchMedia('(prefers-color-scheme: dark)').matches);
      const pair = this.competitionColorPair(compId);
      return dark ? pair.dark : pair.light;
    },

    stagesForCompetition(compId) {
      return this.stages.filter(s => s.competition_id == compId).sort((a, b) => a.stage_order - b.stage_order);
    },

    stripName(stripId) {
      const s = this.strips.find(s => s.id === stripId);
      return s ? (s.name || ('Piste ' + s.strip_number)) : ('Piste ' + stripId);
    },

    async addStage() {
      if (!this.newStage.competition_id) return;
      try {
        await fetch(`/api/schedule-plans/${this.plan.id}/stages`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            competition_id: Number(this.newStage.competition_id),
            phase_type: this.newStage.phase_type,
            label: this.newStage.label || undefined,
            estimated_n: this.newStage.estimated_n === '' ? undefined : Number(this.newStage.estimated_n),
            pistes_assigned: Number(this.newStage.pistes_assigned) || 1,
          }),
        }).then(r => { if (!r.ok) return r.json().then(b => { throw new Error(b.error); }); });
        this.newStage = { competition_id: '', phase_type: 'pool', label: '', estimated_n: '', pistes_assigned: 1 };
        await this.reload();
      } catch (e) {
        this.error = e.message;
      }
    },

    async updateStage(stage, patch) {
      try {
        await fetch(`/api/schedule-plans/stages/${stage.id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
        }).then(r => { if (!r.ok) return r.json().then(b => { throw new Error(b.error); }); });
        await this.reload();
      } catch (e) {
        this.error = e.message;
      }
    },

    async removeStage(stage) {
      await fetch(`/api/schedule-plans/stages/${stage.id}`, { method: 'DELETE' });
      await this.reload();
    },

    async refreshEstimate(stage) {
      await fetch(`/api/schedule-plans/stages/${stage.id}/refresh-estimate`, { method: 'POST' });
      await this.reload();
    },

    async syncFormat(compId) {
      try {
        await fetch(`/api/schedule-plans/${this.plan.id}/sync-format/${compId}`, { method: 'POST' })
          .then(r => { if (!r.ok) return r.json().then(b => { throw new Error(b.error); }); });
        await this.reload();
      } catch (e) {
        this.error = e.message;
      }
    },
  };
}
