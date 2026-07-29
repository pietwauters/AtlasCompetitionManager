// opp2.html Alpine mixin — the single-slot "add to pipeline" form (pool/DE/
// team_match) including the multi-strip pool distribution option. Split out
// of opp2.html's single ~1200-line app() (2026-07-29 architecture-review
// god-file split) — see opp2-core.js for the merge-mixins explanation.
function opp2AddSlot() {
  return {
    deRounds: [],
    addForm: {},
    wantMulti: false,
    multiStrips: [],
    multiDynamic: false,

    get multiPool() {
      if (!this.addForm.pool_id) return null;
      return this.availablePools.find(p => p.id == this.addForm.pool_id) || null;
    },

    resetAddForm() {
      const strip = this.selectedStrip;
      const latest = strip ? strip.slots
        .filter(s => s.predicted_end)
        .reduce((best, s) => (!best || s.predicted_end > best) ? s.predicted_end : best, null) : null;
      let suggested = '';
      if (latest) {
        const [h, m] = latest.split(':').map(Number);
        const t = h * 60 + m + 5;
        suggested = this.round5(`${String(Math.floor(t/60)%24).padStart(2,'0')}:${String(t%60).padStart(2,'0')}`);
      }
      this.addForm = { type: 'pool', pool_id: '', phase_id: '', team_match_id: '',
                       de_round: '', tableau: null, bout_start: '', bout_end: '',
                       scheduled_start: suggested, minutes_per_bout: '', standardMinutes: null };
      this.wantMulti = false;
      this.multiStrips = [];
      this.multiDynamic = false;
      this.deRounds = [];
    },

    onTypeChange() {
      this.addForm.pool_id = '';
      this.addForm.phase_id = '';
      this.addForm.team_match_id = '';
      this.addForm.de_round = '';
      this.addForm.tableau = null;
      this.addForm.bout_start = '';
      this.addForm.bout_end = '';
      this.addForm.standardMinutes = null;
      this.addForm.minutes_per_bout = '';
      this.deRounds = [];
      this.wantMulti = false;
      this.multiStrips = [];
    },

    effectiveMinutes(weapon, gender, phaseType) {
      const w = weapon === 'foil' ? 'F' : weapon === 'epee' ? 'E' : weapon === 'sabre' ? 'S' : weapon;
      const std = this.boutStandards.find(s =>
        s.weapon === w && s.gender === gender && s.phase_type === phaseType);
      if (!std) return null;
      if (std.sample_count >= 4 && std.observed_average != null)
        return Math.round(std.observed_average * 10) / 10;
      return std.minutes_per_bout;
    },

    onPoolSelected(poolId) {
      const pool = this.availablePools.find(p => p.id == poolId);
      if (!pool) { this.addForm.standardMinutes = null; return; }
      const mins = this.effectiveMinutes(pool.weapon, pool.gender, 'pool');
      this.addForm.standardMinutes = mins;
      if (!this.addForm.minutes_per_bout) this.addForm.minutes_per_bout = '';
    },

    toggleMultiStrip(stripId) {
      const idx = this.multiStrips.indexOf(stripId);
      if (idx === -1) this.multiStrips.push(stripId);
      else this.multiStrips.splice(idx, 1);
    },

    async submitAddSlot() {
      const strip = this.selectedStrip;
      if (!strip) return;
      if (this.addForm.type === 'pool' && !this.addForm.pool_id) {
        this.showNotice('Select a pool first', true); return;
      }
      if (this.addForm.type === 'team_match' && !this.addForm.team_match_id) {
        this.showNotice('Select a team match first', true); return;
      }
      if (this.addForm.type === 'de') {
        if (!this.addForm.tableau) { this.showNotice('Select a DE phase and round first', true); return; }
        const n = this.addForm.tableau / 2;
        const lo = Number(this.addForm.bout_start) || 1;
        const hi = Number(this.addForm.bout_end)   || n;
        const partition = this.rangeToPartition(lo, hi, n);
        if (partition === null) {
          this.showNotice(`Bout range ${lo}–${hi} cannot be assigned as one slot — use single bouts or the bulk assign.`, true);
          return;
        }
        this.addForm._partition = partition;
      }

      const body = {
        type:             this.addForm.type,
        pool_id:          this.addForm.type === 'pool'       ? (this.addForm.pool_id       || null) : null,
        phase_id:         this.addForm.type === 'de'   ? (this.addForm.phase_id      || null) : null,
        tableau:          this.addForm.type === 'de'   ? (this.addForm.tableau        || null) : null,
        partition:        this.addForm.type === 'de'   ? (this.addForm._partition     ?? null) : null,
        team_match_id:    this.addForm.type === 'team_match' ? (this.addForm.team_match_id || null) : null,
        scheduled_start:  this.addForm.scheduled_start  || null,
        minutes_per_bout: this.addForm.minutes_per_bout || null,
      };

      // Primary strip
      const r = await fetch(`/api/opp2/pipeline/strip/${strip.id}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) { const d = await r.json(); this.showNotice(d.error || 'Add failed', true); return; }

      // Multi-strip pool split
      let extraNotice = null;
      if (this.addForm.type === 'pool' && this.addForm.pool_id && this.wantMulti && this.multiStrips.length > 0) {
        const dr = await fetch(`/api/pools/${this.addForm.pool_id}/distribute`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ strip_ids: [strip.id, ...this.multiStrips], dynamic_reorder: this.multiDynamic }),
        });
        if (!dr.ok) {
          const d = await dr.json().catch(() => ({}));
          extraNotice = { text: d.error || 'Multi-strip distribution failed', error: true };
        } else {
          const result = await dr.json();
          const n = result.flags ? result.flags.length : 0;
          if (n > 0) extraNotice = { text: `Distributed across ${this.multiStrips.length + 1} strips — ${n} zero-rest case${n > 1 ? 's' : ''} flagged`, error: false };
        }
      }

      await this.loadStrips();
      this.resetAddForm();

      if (extraNotice) this.showNotice(extraNotice.text, extraNotice.error);
      else this.showNotice('Slot added');
    },

    async loadDeRounds(phaseId) {
      this.deRounds = [];
      this.addForm.de_round = '';
      this.addForm.tableau  = null;
      this.addForm.bout_start = '';
      this.addForm.bout_end   = '';
      if (!phaseId) return;
      const bouts = await fetch('/api/bouts?phase_id=' + phaseId).then(r => r.json()).catch(() => []);
      const map = {};
      for (const b of bouts) {
        if (b.de_round == null) continue;
        map[b.de_round] = (map[b.de_round] || 0) + 1;
      }
      this.deRounds = Object.entries(map)
        .map(([r, n]) => ({ de_round: Number(r), total_bouts: n }))
        .sort((a, b) => a.de_round - b.de_round);
    },

    selectDeRound(val) {
      const deRound = Number(val);
      this.addForm.de_round = deRound;
      const rd = this.deRounds.find(r => r.de_round === deRound);
      if (rd) {
        this.addForm.tableau   = rd.total_bouts * 2;
        this.addForm.bout_start = 1;
        this.addForm.bout_end   = rd.total_bouts;
      } else {
        this.addForm.tableau = null;
        this.addForm.bout_start = '';
        this.addForm.bout_end   = '';
      }
    },
  };
}
