'use strict';
// schedule-planner.html Alpine mixin: renders the referee-sufficiency
// analysis services/schedulePlanReferees.js attaches to each pool stage's
// computed_json (see services/schedulePlans.js's resolve()). Phrasing
// mirrors phase.html's/tournaments-detail.html's existing
// blockingSummary/poolBlockingDetail helpers for the live pool-referee
// auto-assigner, so the same "what kind of referee is missing" language is
// consistent across the app.

function schedulePlannerReferees() {
  return {
    poolBlockingDetail(p) {
      const parts = [];
      if (p.nationalities?.length) parts.push('nationality ' + p.nationalities.join(', '));
      if (p.clubs?.length) parts.push('club ' + p.clubs.map(c => c.club_name).join(', '));
      return parts.join(' · ') || '—';
    },

    blockingSummary(s) {
      const nats  = [...new Set((s.pools || []).flatMap(p => p.nationalities || []))];
      const clubs = [...new Set((s.pools || []).flatMap(p => (p.clubs || []).map(c => c.club_name)))];
      const parts = [];
      if (nats.length)  parts.push('nationality ' + nats.join(', '));
      if (clubs.length) parts.push('club ' + clubs.join(', '));
      return parts.join(' and ') || 'nothing in particular';
    },

    // Only pool stages ever carry a referees block (see
    // services/schedulePlanReferees.js — DE has no neutrality model here).
    get refereeSummaryStages() {
      return this.stages.filter(s => s.phase_type === 'pool' && s.computed?.referees);
    },
  };
}
