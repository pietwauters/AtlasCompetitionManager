'use strict';
function navApp() {
  return {
    activeComps: [],

    async initNav() {
      await this.loadActiveComps();
      setInterval(() => this.loadActiveComps(), 20000);
    },

    async loadActiveComps() {
      const all = await fetch('/api/competitions/active').then(r => r.json()).catch(() => []);
      // Nav shows only active phases (currently being fenced)
      this.activeComps = all.filter(c => c.phase_status === 'active');
    },

    phaseLink(comp) {
      if (comp.phase_type === 'pool') return `/phase.html?id=${comp.phase_id}`;
      if (comp.phase_type === 'de')   return `/de.html?id=${comp.phase_id}`;
      return `/competition-detail.html?id=${comp.id}`;
    },

    compLabel(comp) {
      const type = comp.phase_type === 'pool' ? 'Pool' : 'DE';
      return `${comp.name} (${type})`;
    },
  };
}
