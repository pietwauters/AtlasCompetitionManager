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
      virtualStageKey: '',
      selectedPisteIds: [], startTime: '',
    },
    lastBulkSlotIds: [],

    get bulkReady() {
      if (this.bulkModal.type === 'pools') return !!this.bulkModal.competitionId;
      if (this.bulkModal.type === 'virtual') return !!this.bulkModal.virtualStageKey;
      return !!(this.bulkModal.dePhaseId && this.bulkModal.deStartRound);
    },

    // One entry per selected piste, all the same placeholder — a virtual
    // slot has no per-piste distinction the way pools/DE bouts do, it's
    // just "reserve this many strips for this not-yet-real stage."
    get bulkVirtualStage() {
      if (!this.bulkModal.virtualStageKey) return null;
      return this.availableVirtualStages.find(s => this.virtualStageKey(s) === this.bulkModal.virtualStageKey) || null;
    },

    get bulkVirtualPreview() {
      if (this.bulkModal.type !== 'virtual' || !this.bulkVirtualStage) return [];
      return this.bulkModal.selectedPisteIds
        .map(id => this.strips.find(s => s.id === id))
        .filter(Boolean)
        .sort((a, b) => a.strip_number - b.strip_number)
        .map(piste => ({ piste, conflict: this.pisteIsBusy(piste, this.bulkModal.startTime) }));
    },

    // Flat list: one entry per real bout in the selected round, cycling across selected pistes.
    get bulkDePreview() {
      if (this.bulkModal.type !== 'de') return [];
      const { dePhaseId, deRoundsForBulk, deStartRound, selectedPisteIds, startTime, deRoundBoutsMap } = this.bulkModal;
      if (!dePhaseId || !deStartRound || !selectedPisteIds.length) return [];
      const rd = deRoundsForBulk.find(r => r.de_round === Number(deStartRound));
      if (!rd) return [];

      const roundBouts = deRoundBoutsMap[Number(deStartRound)] || [];
      // Exclude only *confirmed* byes (status='finished' with one side
      // null — a real, already-decided outcome that never needs a strip).
      // A bout with BOTH sides null and status still 'pending' isn't a bye,
      // it's simply not seeded yet (services/dePhases.js's createSkeleton —
      // a round built ahead of time, real fencers filled in later) — that's
      // still a real, schedulable bout, not something to drop from the list.
      const schedulableBouts = roundBouts.filter(b => !(b.status === 'finished' && (!b.left_id || !b.right_id)));
      if (!schedulableBouts.length) return [];

      const pistes = selectedPisteIds.map(id => this.strips.find(s => s.id === id)).filter(Boolean);
      const tableau = rd.total_bouts * 2;
      const phase = this.availableDePhases.find(p => p.id == dePhaseId);
      const minsDE = phase ? this.effectiveMinutes(phase.weapon, phase.gender, 'de') : null;
      const P = pistes.length;

      // Round 1 of a still-unseeded skeleton: predict which specific bout
      // positions will turn out to be byes, from the same estimated headcount
      // createSkeleton's own prefill used (services/formats.js's
      // _estimateAdvancedCount) — see opp2-core.js's predictedByePositions
      // (mirrors lib/deFormation.js). A prediction, not a resolution: shown
      // as a per-row flag so the director can see roughly which pistes will
      // end up idle, but every bout stays schedulable exactly as-is, since
      // the real seeding (once the prior stage closes) could still shift it.
      const predictedByeSet = (phase?.status === 'skeleton' && Number(deStartRound) === 1
          && phase.estimated_advanced_count != null)
        ? this.predictedByePositions(tableau, phase.estimated_advanced_count)
        : null;

      // Piste assignment: FIE Organisation Rules o.87.1 (and o.93.2 for
      // Formula B) are explicit that a DE tableau is "fenced on four pistes,
      // one quarter of the table per piste" (or eight pistes, two per
      // quarter) — a contiguous block of the bracket per piste, run straight
      // through every round, not bouts round-robined one-by-one across
      // pistes. Plain round-robin (pistes[i % P]) was tried here first and
      // got it wrong twice: it aliases with the FIE seed-doubling recursion's
      // own power-of-2 periodicity whenever P is also a power of 2 (2, 4, 8
      // pistes — the common case), dumping almost every bye onto one or two
      // pistes (found in real use: 11 byes across 4 pistes landed 6/0/0/5).
      // Contiguous chunking fixes that not as an invented balancing
      // heuristic but as a side effect of matching real FIE practice: the
      // same seeding that produces byes already spreads top seeds evenly
      // across the tableau's quarters (verified against the same real
      // numbers: chunks of 8 give byes [3,2,3,3]).
      const boutCount = schedulableBouts.length;
      const baseChunk = Math.floor(boutCount / P), remainder = boutCount % P;
      const pisteForIndex = [];
      for (let p = 0, idx = 0; p < P; p++) {
        const chunkSize = baseChunk + (p < remainder ? 1 : 0);
        for (let k = 0; k < chunkSize; k++) pisteForIndex[idx++] = p;
      }
      const pisteBoutCounts = new Array(P).fill(0); // per-piste running total, for wave/start-time

      return schedulableBouts.map((bout, i) => {
        const isPredictedBye = predictedByeSet ? predictedByeSet.has(bout._roundIndex) : false;
        const pisteIdx = pisteForIndex[i];
        const piste = pistes[pisteIdx];
        const wave = pisteBoutCounts[pisteIdx]++;

        const partition = this.partitionForBoutIndex(bout._roundIndex, rd.total_bouts);
        const slotStart = startTime ? this.addMinutes(startTime, wave * (minsDE || 0)) : null;
        const ln = bout.left_last  ? bout.left_last  + (bout.left_first  ? ' ' + bout.left_first[0]  + '.' : '') : 'TBD';
        const rn = bout.right_last ? bout.right_last + (bout.right_first ? ' ' + bout.right_first[0] + '.' : '') : 'TBD';
        return {
          piste, partition, tableau, wave,
          bout_start: bout._roundIndex, bout_end: bout._roundIndex, boutsInSlot: 1,
          conflict: this.pisteIsBusy(piste, slotStart),
          de_round: Number(deStartRound),
          matchLabel: ln + ' v ' + rn,
          predictedBye: isPredictedBye,
          slotStart,
        };
      });
    },

    // Round 1 of a skeleton DE phase (services/dePhases.js's createSkeleton)
    // has no real bye yet — bye positions only exist once seedSkeleton fills
    // in real competitors, so bulkDePreview above correctly offers every
    // round-1 bout as schedulable. This just tells the director roughly how
    // many of those bouts will turn out to be byes, from the same
    // estimatedAdvancedCount projection createSkeleton's own prefill uses
    // (services/formats.js's _estimateAdvancedCount) — an estimate, not a
    // guarantee: the real count depends on the still-open prior stage.
    get bulkDeEstimatedByeNote() {
      if (this.bulkModal.type !== 'de' || Number(this.bulkModal.deStartRound) !== 1) return null;
      const phase = this.availableDePhases.find(p => p.id == this.bulkModal.dePhaseId);
      if (!phase || phase.status !== 'skeleton' || phase.estimated_advanced_count == null) return null;
      const rd = this.bulkModal.deRoundsForBulk.find(r => r.de_round === 1);
      if (!rd) return null;
      const tableau = rd.total_bouts * 2;
      const estimatedByes = Math.max(0, tableau - phase.estimated_advanced_count);
      if (!estimatedByes) return null;
      return `Estimate: ${estimatedByes} of these ${rd.total_bouts} bouts (flagged below) are predicted byes ` +
        `— projected ${phase.estimated_advanced_count} advancing into a T${tableau} bracket. This is a ` +
        `prediction, not a confirmation: the real count can still shift once the prior stage actually closes ` +
        `and this bracket is seeded, which could move the exact positions. Schedule as shown either way.`;
    },

    // How many waves the current preview needs — more pools/bouts than
    // selected pistes means some pistes get a second (or third...) round of
    // assignments, sequenced by wave rather than silently dropped. 1 when
    // everything fits in a single pass (the ordinary case).
    get bulkWaveCount() {
      const preview = this.bulkModal.type === 'pools' ? this.bulkPreview
                     : this.bulkModal.type === 'de'    ? this.bulkDePreview
                     : [];
      if (!preview.length) return 1;
      return Math.max(...preview.map(r => r.wave)) + 1;
    },

    get bulkDeInvalidReason() {
      const { deRoundsForBulk, deStartRound, selectedPisteIds, deRoundBoutsMap } = this.bulkModal;
      if (!deStartRound || !selectedPisteIds.length) return '';
      const rd = deRoundsForBulk.find(r => r.de_round === Number(deStartRound));
      if (!rd) return '';
      const bouts = deRoundBoutsMap[Number(deStartRound)] || [];
      const schedulable = bouts.filter(b => !(b.status === 'finished' && (!b.left_id || !b.right_id)));
      if (!schedulable.length) return 'Every bout in this round is already a bye';
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
      if (this.bulkModal.type === 'pools') return this.bulkPreview.length > 0;
      if (this.bulkModal.type === 'virtual') return this.bulkVirtualPreview.length > 0;
      return this.bulkDePreview.length > 0;
    },

    get bulkSubmitLabel() {
      if (this.bulkModal.loading) return 'Assigning…';
      if (this.bulkModal.type === 'pools') {
        const n = this.bulkPreview.length;
        return `Assign ${n} pool${n !== 1 ? 's' : ''}`;
      }
      if (this.bulkModal.type === 'virtual') {
        const n = this.bulkVirtualPreview.length;
        return `Assign ${n} placeholder${n !== 1 ? 's' : ''}`;
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

    // One entry per pool, round-robinned across the selected pistes — when
    // there are more pools than pistes, extra pools queue onto the same
    // pistes in a later wave rather than being silently dropped (the old
    // behavior: `pistes[i] || null`, filtered out at submit time with no
    // warning at all). Each piste tracks its own cumulative offset rather
    // than a flat "wave number * one duration" (fine for DE, where every
    // bout in a round takes the same time) — pools in the same competition
    // share a weapon/gender (so minutes-per-bout is uniform) but can still
    // have different bouts_total, so a piste's second-wave pool has to start
    // after ITS first pool actually finishes, not after some average wave length.
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

      const P = pistes.length;
      if (!P) return [];

      const pisteOffsetMin = new Array(P).fill(0);

      return pools.map((pool, i) => {
        const pisteIdx = i % P;
        const piste    = pistes[pisteIdx];
        const wave     = Math.floor(i / P);
        const mins     = this.effectiveMinutes(pool.weapon, pool.gender, 'pool') || 0;
        const offset   = pisteOffsetMin[pisteIdx];
        const slotStart = this.bulkModal.startTime
          ? this.addMinutes(this.bulkModal.startTime, offset)
          : null;
        pisteOffsetMin[pisteIdx] += (pool.bouts_total || 0) * mins;
        return { pool, piste, wave, slotStart, conflict: this.pisteIsBusy(piste, slotStart) };
      });
    },

    pisteIsBusy(strip, startTime) {
      const nonDone = strip.slots.filter(s => s.status !== 'done');
      if (!nonDone.length) return false;
      if (!startTime) return true;
      // Busy if any non-done slot has no predicted end or its predicted end
      // (opp2-core.js's predictedAdjustedEnd — discounts a still-unseeded
      // skeleton's estimated byes on top of the server's own resolved-bye
      // discount) is after startTime.
      return nonDone.some(s => !s.predicted_end || this.predictedAdjustedEnd(s) > startTime);
    },

    openBulkModal() {
      Object.assign(this.bulkModal, {
        type: 'pools', loading: false,
        competitionId: '', conflictAction: 'append',
        dePhaseId: '', deRoundsForBulk: [], deStartRound: '', deRoundBoutsMap: {},
        virtualStageKey: '',
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
        for (const { pool, piste, slotStart } of this.bulkPreview) {
          const r = await fetch(`/api/opp2/pipeline/strip/${piste.id}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: 'pool', pool_id: pool.id,
              scheduled_start: slotStart || null,
              minutes_per_bout: this.effectiveMinutes(pool.weapon, pool.gender, 'pool'),
            }),
          });
          if (!r.ok) { const d = await r.json().catch(()=>({})); errors.push(d.error || 'failed'); }
          else { const s = await r.json(); if (s?.id) createdIds.push(s.id); }
        }
      } else if (this.bulkModal.type === 'virtual') {
        const stage = this.bulkVirtualStage;
        for (const { piste } of this.bulkVirtualPreview) {
          const r = await fetch(`/api/opp2/pipeline/strip/${piste.id}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: 'virtual',
              virtual_competition_id: stage.competition_id,
              virtual_format_stage_id: stage.format_stage_id,
              virtual_phase_type: stage.phase_type,
              virtual_label: stage.label,
              scheduled_start: this.bulkModal.startTime || null,
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
              de_round: pa.de_round,
              bracket: 'main',
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
