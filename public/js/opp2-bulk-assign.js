// opp2.html Alpine mixin — the bulk-assign modal (pools or DE-round bouts
// across several pistes at once) + its undo. Split out of opp2.html's
// single ~1200-line app() (2026-07-29 architecture-review god-file split)
// — see opp2-core.js for the merge-mixins explanation.
//
// Note: this file previously had its own verbatim-duplicate `pendingSlotCount`
// (confirmed by the 2026-07-28 architecture review, found by
// scripts/check-architecture.sh's duplicate-function-name check) — dropped
// here since opp2-core.js already defines it and every mixin shares one
// merged `this`.
function opp2BulkAssign() {
  return {
    bulkModal: {
      open: false, type: 'pools', loading: false,
      competitionId: '', conflictAction: 'append',
      dePhaseId: '', deRoundsForBulk: [], deStartRound: '', deRoundBoutsMap: {},
      selectedPisteIds: [], startTime: '',
    },
    lastBulkSlotIds: [],

    get bulkReady() {
      if (this.bulkModal.type === 'pools') return !!this.bulkModal.competitionId;
      return !!(this.bulkModal.dePhaseId && this.bulkModal.deStartRound);
    },

    // Flat list: one entry per real bout in the selected round, cycling across selected pistes.
    get bulkDePreview() {
      if (this.bulkModal.type !== 'de') return [];
      const { dePhaseId, deRoundsForBulk, deStartRound, selectedPisteIds, startTime, deRoundBoutsMap } = this.bulkModal;
      if (!dePhaseId || !deStartRound || !selectedPisteIds.length) return [];
      const rd = deRoundsForBulk.find(r => r.de_round === Number(deStartRound));
      if (!rd) return [];

      const roundBouts = deRoundBoutsMap[Number(deStartRound)] || [];
      const realBouts = roundBouts.filter(b => b.left_id && b.right_id);
      if (!realBouts.length) return [];

      const pistes = selectedPisteIds.map(id => this.strips.find(s => s.id === id)).filter(Boolean);
      const tableau = rd.total_bouts * 2;
      const phase = this.availableDePhases.find(p => p.id == dePhaseId);
      const minsDE = phase ? this.effectiveMinutes(phase.weapon, phase.gender, 'de') : null;
      const P = pistes.length;

      return realBouts.map((bout, i) => {
        const piste = pistes[i % P];
        const partition = this.partitionForBoutIndex(bout._roundIndex, rd.total_bouts);
        const wave = Math.floor(i / P);
        const slotStart = startTime ? this.addMinutes(startTime, wave * (minsDE || 0)) : null;
        const ln = bout.left_last  ? bout.left_last  + (bout.left_first  ? ' ' + bout.left_first[0]  + '.' : '') : '?';
        const rn = bout.right_last ? bout.right_last + (bout.right_first ? ' ' + bout.right_first[0] + '.' : '') : '?';
        return {
          piste, partition, tableau,
          bout_start: bout._roundIndex, bout_end: bout._roundIndex, boutsInSlot: 1,
          conflict: this.pisteIsBusy(piste, slotStart),
          de_round: Number(deStartRound),
          matchLabel: ln + ' v ' + rn,
          slotStart,
        };
      });
    },

    get bulkDeInvalidReason() {
      const { deRoundsForBulk, deStartRound, selectedPisteIds, deRoundBoutsMap } = this.bulkModal;
      if (!deStartRound || !selectedPisteIds.length) return '';
      const rd = deRoundsForBulk.find(r => r.de_round === Number(deStartRound));
      if (!rd) return '';
      const bouts = deRoundBoutsMap[Number(deStartRound)] || [];
      if (!bouts.filter(b => b.left_id && b.right_id).length) return 'No real bouts in this round yet';
      return '';
    },

    // Unique piste IDs used in the previous round — for the "same pistes" button.
    get bulkDePrevPisteIds() {
      const { dePhaseId, deRoundsForBulk, deStartRound } = this.bulkModal;
      if (!dePhaseId || !deStartRound) return null;
      const prevRd = deRoundsForBulk.find(r => r.de_round === Number(deStartRound) - 1);
      if (!prevRd) return null;
      const prevTableau = prevRd.total_bouts * 2;
      const seen = new Set();
      const ids = [];
      for (const s of this.strips) {
        for (const sl of s.slots) {
          if (sl.type === 'de' && sl.phase_id == dePhaseId && sl.tableau == prevTableau && !seen.has(s.id)) {
            seen.add(s.id);
            ids.push(s.id);
          }
        }
      }
      return ids.length ? ids : null;
    },

    get bulkReadyToSubmit() {
      if (this.bulkModal.type === 'pools') return this.bulkPreview.some(r => r.piste);
      return this.bulkDePreview.length > 0;
    },

    get bulkSubmitLabel() {
      if (this.bulkModal.loading) return 'Assigning…';
      if (this.bulkModal.type === 'pools') {
        const n = this.bulkPreview.filter(r => r.piste).length;
        return `Assign ${n} pool${n !== 1 ? 's' : ''}`;
      }
      const n = this.bulkDePreview.length;
      return `Assign ${n} slot${n !== 1 ? 's' : ''}`;
    },

    async loadBulkDeRounds(phaseId) {
      this.bulkModal.deStartRound = '';
      this.bulkModal.deRoundsForBulk = [];
      this.bulkModal.deRoundBoutsMap = {};
      this.bulkModal.selectedPisteIds = [];
      if (!phaseId) return;
      const bouts = await fetch('/api/bouts?phase_id=' + phaseId).then(r => r.json()).catch(() => []);

      const byRound = {};
      for (const b of bouts) {
        if (b.de_round == null) continue;
        if (!byRound[b.de_round]) byRound[b.de_round] = [];
        byRound[b.de_round].push(b);
      }

      const boutsMap = {};
      const totalMap = {};
      const byeMap = {};
      for (const [r, roundBouts] of Object.entries(byRound)) {
        const dr = Number(r);
        roundBouts.sort((a, b) => (a.tableau_position || 0) - (b.tableau_position || 0));
        roundBouts.forEach((b, i) => { b._roundIndex = i + 1; });
        boutsMap[dr] = roundBouts;
        totalMap[dr] = roundBouts.length;
        byeMap[dr] = roundBouts.filter(b => b.status === 'finished' && (!b.left_id || !b.right_id)).length;
      }

      this.bulkModal.deRoundsForBulk = Object.entries(totalMap)
        .map(([r, n]) => ({ de_round: Number(r), total_bouts: n, bye_count: byeMap[r] || 0 }))
        .sort((a, b) => a.de_round - b.de_round);
      this.bulkModal.deRoundBoutsMap = boutsMap;
    },

    get bulkCompetitions() {
      const seen = new Set();
      const comps = [];
      for (const p of this.availablePools) {
        const key = String(p.competition_id);
        if (!seen.has(key)) {
          seen.add(key);
          comps.push({ id: p.competition_id, name: p.competition_name });
        }
      }
      return comps;
    },

    get bulkPreview() {
      if (!this.bulkModal.competitionId) return [];
      const pools = this.availablePools
        .filter(p => p.competition_id == this.bulkModal.competitionId)
        .slice()
        .sort((a, b) => (b.bouts_total || 0) - (a.bouts_total || 0));

      let pistes = this.bulkModal.selectedPisteIds
        .map(id => this.strips.find(s => s.id === id))
        .filter(Boolean)
        .sort((a, b) => a.strip_number - b.strip_number);

      if (this.bulkModal.conflictAction === 'skip')
        pistes = pistes.filter(s => !this.pisteIsBusy(s, this.bulkModal.startTime));

      return pools.map((pool, i) => {
        const piste = pistes[i] || null;
        return { pool, piste, conflict: piste ? this.pisteIsBusy(piste, this.bulkModal.startTime) : false };
      });
    },

    pisteIsBusy(strip, startTime) {
      const nonDone = strip.slots.filter(s => s.status !== 'done');
      if (!nonDone.length) return false;
      if (!startTime) return true;
      // Busy if any non-done slot has no predicted end or its predicted end is after startTime
      return nonDone.some(s => !s.predicted_end || s.predicted_end > startTime);
    },

    openBulkModal() {
      Object.assign(this.bulkModal, {
        type: 'pools', loading: false,
        competitionId: '', conflictAction: 'append',
        dePhaseId: '', deRoundsForBulk: [], deStartRound: '', deRoundBoutsMap: {},
        selectedPisteIds: [], startTime: '',
      });
      this.bulkModal.open = true;
    },

    bulkSelectAllIdle() {
      this.bulkModal.selectedPisteIds = this.strips
        .filter(s => !this.pisteIsBusy(s, this.bulkModal.startTime))
        .map(s => s.id);
    },

    toggleBulkPiste(id, checked) {
      if (checked && !this.bulkModal.selectedPisteIds.includes(id))
        this.bulkModal.selectedPisteIds = [...this.bulkModal.selectedPisteIds, id];
      else if (!checked)
        this.bulkModal.selectedPisteIds = this.bulkModal.selectedPisteIds.filter(x => x !== id);
    },

    confirmSubmitBulkAssign() {
      if (!this.bulkReadyToSubmit) return;
      if (!this.bulkModal.startTime) {
        this.noStartTimeModal = { open: true, onContinue: () => this.submitBulkAssign() };
        return;
      }
      this.submitBulkAssign();
    },

    async submitBulkAssign() {
      if (!this.bulkReadyToSubmit) return;
      this.bulkModal.loading = true;
      const errors = [];
      const createdIds = [];

      if (this.bulkModal.type === 'pools') {
        for (const { pool, piste } of this.bulkPreview.filter(r => r.piste)) {
          const r = await fetch(`/api/opp2/pipeline/strip/${piste.id}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: 'pool', pool_id: pool.id,
              scheduled_start: this.bulkModal.startTime || null,
              minutes_per_bout: this.effectiveMinutes(pool.weapon, pool.gender, 'pool'),
            }),
          });
          if (!r.ok) { const d = await r.json().catch(()=>({})); errors.push(d.error || 'failed'); }
          else { const s = await r.json(); if (s?.id) createdIds.push(s.id); }
        }
      } else {
        const phase = this.availableDePhases.find(p => p.id == this.bulkModal.dePhaseId);
        const minsDE = phase ? this.effectiveMinutes(phase.weapon, phase.gender, 'de') : null;
        for (const pa of this.bulkDePreview) {
          const r = await fetch(`/api/opp2/pipeline/strip/${pa.piste.id}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: 'de',
              phase_id: Number(this.bulkModal.dePhaseId),
              tableau: pa.tableau,
              partition: pa.partition,
              scheduled_start: pa.slotStart || null,
              minutes_per_bout: minsDE || null,
            }),
          });
          if (!r.ok) { const d = await r.json().catch(()=>({})); errors.push(d.error || 'failed'); }
          else { const s = await r.json(); if (s?.id) createdIds.push(s.id); }
        }
      }

      this.lastBulkSlotIds = createdIds;
      await this.loadStrips();
      this.bulkModal.loading = false;
      this.bulkModal.open = false;
      if (errors.length)
        this.showNotice('Some assignments failed: ' + errors.join('; '), true);
      else
        this.showNotice(`${createdIds.length} slot${createdIds.length !== 1 ? 's' : ''} assigned. Use ↩ Undo to reverse.`);
    },

    async undoBulkAssign() {
      if (!this.lastBulkSlotIds.length) return;
      if (!confirm(`Remove ${this.lastBulkSlotIds.length} slot${this.lastBulkSlotIds.length !== 1 ? 's' : ''} from the last bulk assign?`)) return;
      for (const id of this.lastBulkSlotIds) {
        await fetch(`/api/opp2/pipeline/slots/${id}`, { method: 'DELETE' });
      }
      this.lastBulkSlotIds = [];
      await this.loadStrips();
      this.showNotice('Bulk assignment undone.');
    },
  };
}
