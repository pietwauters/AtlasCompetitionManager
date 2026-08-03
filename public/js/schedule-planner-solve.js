'use strict';
// schedule-planner.html Alpine mixin: plan-level settings (day start,
// assumed abstract piste/referee counts) and the two solve directions —
// "given piste count, when do we finish" and "given a deadline, how many
// pistes are needed" — both non-persisting previews, plus the persisting
// "resolve" action that writes the plan's actual schedule_plan_slots (the
// "auto-solve first, then adjustable" starting layout).

function schedulePlannerSolve() {
  return {
    solveBusy: false,
    previewPistesInput: '',
    previewDeadlineInput: '',
    previewPistesResult: null,
    previewDeadlineResult: null,

    async updatePlanSettings() {
      try {
        this.plan = await fetch(`/api/schedule-plans/${this.plan.id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            day_start: this.plan.day_start,
            abstract_piste_count: Number(this.plan.abstract_piste_count) || 0,
            abstract_referee_count: Number(this.plan.abstract_referee_count) || 0,
          }),
        }).then(r => { if (!r.ok) return r.json().then(b => { throw new Error(b.error); }); return r.json(); });
      } catch (e) {
        this.error = e.message;
      }
    },

    async resolvePlan() {
      this.solveBusy = true;
      try {
        const view = await fetch(`/api/schedule-plans/${this.plan.id}/resolve`, { method: 'POST' })
          .then(r => { if (!r.ok) return r.json().then(b => { throw new Error(b.error); }); return r.json(); });
        this.plan = view.plan;
        this.stages = view.stages;
        this.slots = view.slots;
        this.notice = 'Schedule re-solved.';
      } catch (e) {
        this.error = e.message;
      } finally {
        this.solveBusy = false;
      }
    },

    async runPreviewPistes() {
      const n = Number(this.previewPistesInput);
      if (!n || n < 1) return;
      try {
        this.previewPistesResult = await fetch(`/api/schedule-plans/${this.plan.id}/preview-pistes`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ totalPistes: n }),
        }).then(r => { if (!r.ok) return r.json().then(b => { throw new Error(b.error); }); return r.json(); });
      } catch (e) {
        this.error = e.message;
      }
    },

    async runPreviewDeadline() {
      if (!this.previewDeadlineInput) return;
      try {
        this.previewDeadlineResult = await fetch(`/api/schedule-plans/${this.plan.id}/preview-deadline`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deadline: this.previewDeadlineInput }),
        }).then(r => { if (!r.ok) return r.json().then(b => { throw new Error(b.error); }); return r.json(); });
      } catch (e) {
        this.error = e.message;
      }
    },
  };
}
