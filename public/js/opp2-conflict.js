// opp2.html Alpine mixin — referee/official assignment, double-booking
// conflict detection + resolution modal, and the conflict-push undo/restore
// flow. Split out of opp2.html's single ~1200-line app() (2026-07-29
// architecture-review god-file split) — see opp2-core.js for the
// merge-mixins explanation.
function opp2Conflict() {
  return {
    conflictModal: {
      open: false, step: 1,
      field: null, refereeId: null, refereeName: '',
      currentSlot: null, otherSlot: null, otherRole: '',
      order: null, cascade: true,
    },
    restoreModal: { open: false, slot: null, pairedSlot: null, originalStart: null, stripName: '' },

    async updateSlot(id, fields) {
      const r = await fetch(`/api/opp2/pipeline/slots/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
      });
      if (!r.ok) { const d = await r.json().catch(() => ({})); this.showNotice(d.error || 'Update failed', true); return; }
      await this.loadStrips();
    },

    // Assign a referee/referee2/video_assistant/assessor1/assessor2 to a slot.
    // Checks whether that person already has an overlapping assignment (in any
    // of the 5 roles, on any strip) before committing — clearing an assignment
    // (value null) can never create a conflict, so it always goes straight
    // through updateSlot. Without a scheduled_start on this slot there's no
    // time window to check overlap against at all, so availability can't be
    // determined — warn before assigning rather than silently letting a real
    // double-booking through undetected.
    async assignOfficial(slot, field, rawValue) {
      const value = rawValue || null;
      if (value && !slot.scheduled_start) {
        this.noStartTimeModal = {
          open: true,
          onContinue: () => this._assignOfficialConfirmed(slot, field, value),
        };
        return;
      }
      await this._assignOfficialConfirmed(slot, field, value);
    },

    async _assignOfficialConfirmed(slot, field, value) {
      if (!value) {
        await this.updateSlot(slot.id, { [field]: value });
        await this._checkConflictResolutions(slot.id);
        return;
      }

      const conflict = this._findRefereeConflict(slot, value);
      if (!conflict) {
        await this.updateSlot(slot.id, { [field]: value });
        await this._checkConflictResolutions(slot.id);
        return;
      }

      this.conflictModal = {
        open: true, step: 1,
        field, refereeId: value, refereeName: this._refereeName(value),
        currentSlot: slot, otherSlot: conflict.slot, otherRole: conflict.role,
        order: null, cascade: true,
      };
    },

    // Options for an official <select>, sorted available-first then
    // busy-last (overlapping-assignment busy, per _findRefereeConflict) —
    // busy ones stay selectable, just visually deprioritized/greyed. When
    // the slot has no scheduled_start, availability can't be determined at
    // all (see assignOfficial above), so nobody is flagged busy here either.
    officialOptionsFor(slot) {
      return this.referees
        .map(r => ({ ...r, busy: !!this._findRefereeConflict(slot, r.referee_id) }))
        .sort((a, b) => {
          if (a.busy !== b.busy) return a.busy ? 1 : -1;
          return (a.last_name + a.first_name).localeCompare(b.last_name + b.first_name);
        });
    },

    async cancelConflict() {
      this.conflictModal = {
        open: false, step: 1, field: null, refereeId: null, refereeName: '',
        currentSlot: null, otherSlot: null, otherRole: '', order: null, cascade: true,
      };
      // The referee/official <select>s use :selected bindings, not x-model —
      // the browser already shows whatever option the operator just clicked
      // regardless of Alpine state. Since we never actually committed that
      // change, force a full reload so the dropdowns visually snap back to
      // the real (unchanged) assignment instead of showing a phantom pick.
      await this.loadStrips();
    },

    async applyConflictResolution() {
      const m = this.conflictModal;
      if (!m.order) return;

      const firstSlot  = m.order === 'current-first' ? m.currentSlot : m.otherSlot;
      const secondSlot = m.order === 'current-first' ? m.otherSlot   : m.currentSlot;
      const firstWin = this._slotWindow(firstSlot);
      if (firstWin) {
        // Push the later slot's start time BEFORE assigning the referee
        // below — the server now enforces double-booking itself
        // (services/pipeline.js's updateSlot, 2026-07-28 architecture
        // review), so assigning the referee while the two slots still
        // genuinely overlap would be rejected. Pushing first eliminates the
        // overlap so the assignment that follows is always clean.
        // Also remembers what this slot's start time was before the push,
        // and which referee/slot the conflict was against, so a later
        // change that removes the conflict can offer to restore it (see
        // _checkConflictResolutions).
        await this._patchSlot(secondSlot.id, {
          scheduled_start:         firstWin.end,
          conflict_referee_id:     m.refereeId,
          conflict_original_start: secondSlot.scheduled_start,
          conflict_paired_slot_id: firstSlot.id,
        });
      }

      await this.updateSlot(m.currentSlot.id, { [m.field]: m.refereeId });
      await this.loadStrips();

      if (m.cascade) {
        const stripOfSecond = this.strips.find(s => s.slots.some(sl => sl.id === secondSlot.id));
        if (stripOfSecond) await this._recascadeStrip(stripOfSecond);
      }

      this.showNotice('Referee assigned — schedule updated to resolve the conflict');
      await this.cancelConflict();
    },

    // ── Conflict-push undo ──────────────────────────────────────────────────

    // Refereed slots remember (conflict_referee_id/conflict_original_start/
    // conflict_paired_slot_id) that they were pushed to a later start time to
    // resolve a double-booking. Call this after any successful official
    // assignment change on `touchedSlotId` — if that slot (or a slot paired
    // with it) has such a marker and the underlying double-booking no longer
    // holds, prompt the operator to restore the original time.
    async _checkConflictResolutions(touchedSlotId) {
      for (const strip of this.strips) {
        for (const p of strip.slots) {
          if (!p.conflict_referee_id || !p.conflict_paired_slot_id) continue;
          if (p.id !== touchedSlotId && p.conflict_paired_slot_id !== touchedSlotId) continue;
          const q = this._findSlotById(p.conflict_paired_slot_id);
          if (!q) continue;
          if (!this._conflictPairStillHolds(p, q)) {
            this.restoreModal = {
              open: true, slot: p, pairedSlot: q,
              originalStart: p.conflict_original_start,
              stripName: strip.name || ('Piste ' + strip.strip_number),
            };
            return;
          }
        }
      }
    },

    _findSlotById(id) {
      for (const strip of this.strips) {
        const s = strip.slots.find(sl => sl.id === id);
        if (s) return s;
      }
      return null;
    },

    // Whether the original double-booking that caused p's push still holds:
    // both p and q still have conflict_referee_id in any of their 5 official
    // roles, AND p's ORIGINAL window still overlaps q's current window.
    _conflictPairStillHolds(p, q) {
      const refId = p.conflict_referee_id;
      const ROLE_FIELDS = ['referee_id', 'referee2_id', 'video_assistant_id', 'assessor1_id', 'assessor2_id'];
      const pHasRef = ROLE_FIELDS.some(f => p[f] != null && String(p[f]) === String(refId));
      const qHasRef = ROLE_FIELDS.some(f => q[f] != null && String(q[f]) === String(refId));
      if (!pHasRef || !qHasRef) return false;
      const pOrigEnd = this._computeSlotEnd(p, p.conflict_original_start) || this.addMinutes(p.conflict_original_start, 30);
      const qWin = this._slotWindow(q);
      if (!qWin) return false;
      return this._windowsOverlap({ start: p.conflict_original_start, end: pOrigEnd }, qWin);
    },

    async dismissRestore() {
      const m = this.restoreModal;
      // Acknowledge and stop tracking — leave the current (pushed) time as
      // is, but don't keep re-prompting for the same resolved conflict.
      await this._patchSlot(m.slot.id, {
        conflict_referee_id: null, conflict_original_start: null, conflict_paired_slot_id: null,
      });
      await this.loadStrips();
      this.restoreModal = { open: false, slot: null, pairedSlot: null, originalStart: null, stripName: '' };
    },

    async applyRestore() {
      const m = this.restoreModal;
      await this._patchSlot(m.slot.id, {
        scheduled_start: m.originalStart,
        conflict_referee_id: null, conflict_original_start: null, conflict_paired_slot_id: null,
      });
      await this.loadStrips();
      const strip = this.strips.find(s => s.slots.some(sl => sl.id === m.slot.id));
      if (strip) await this._recascadeStrip(strip);
      this.showNotice('Original start time restored');
      this.restoreModal = { open: false, slot: null, pairedSlot: null, originalStart: null, stripName: '' };
    },

    _refereeName(id) {
      const r = this.referees.find(x => String(x.referee_id) === String(id));
      return r ? `${r.last_name}, ${r.first_name}` : ('Referee ' + id);
    },

    // A slot's [start, end) window for overlap purposes, or null if it has no
    // scheduled_start at all (nothing to double-book against).
    _slotWindow(slot) {
      if (!slot.scheduled_start) return null;
      const end = slot.predicted_end
        || this._computeSlotEnd(slot, slot.scheduled_start)
        || this.addMinutes(slot.scheduled_start, 30);
      return { start: slot.scheduled_start, end };
    },

    _windowsOverlap(a, b) {
      return a.start < b.end && b.start < a.end;
    },

    // Find another slot (any strip) where refereeId is already assigned in
    // any of the 5 official roles, with a time window overlapping slot's own.
    _findRefereeConflict(slot, refereeId) {
      const win = this._slotWindow(slot);
      if (!win) return null;
      const ROLE_FIELDS = { referee_id: 'Referee', referee2_id: 'Referee 2', video_assistant_id: 'Video Assistant', assessor1_id: 'Assessor 1', assessor2_id: 'Assessor 2' };
      for (const strip of this.strips) {
        for (const other of strip.slots) {
          if (other.id === slot.id) continue;
          const otherWin = this._slotWindow(other);
          if (!otherWin || !this._windowsOverlap(win, otherWin)) continue;
          for (const [field, label] of Object.entries(ROLE_FIELDS)) {
            if (other[field] != null && String(other[field]) === String(refereeId)) {
              return {
                slot: { ...other, __stripName: strip.name || ('Piste ' + strip.strip_number) },
                role: label,
              };
            }
          }
        }
      }
      return null;
    },
  };
}
