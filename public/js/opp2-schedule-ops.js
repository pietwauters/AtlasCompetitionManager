// opp2.html Alpine mixin — moving/reordering/deleting pipeline slots
// (move between strips, drag-and-drop within a strip, delete) and the
// schedule-recascade logic that follows any of them. Split out of
// opp2.html's single ~1200-line app() (2026-07-29 architecture-review
// god-file split) — see opp2-core.js for the merge-mixins explanation.
function opp2ScheduleOps() {
  return {
    drag: { id: null, overSlotId: null },

    async moveSlot(id, direction) {
      const strip = this.strips.find(s => s.slots.some(sl => sl.id === id));
      const r = await fetch(`/api/opp2/pipeline/slots/${id}/reorder`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ direction }),
      });
      if (!r.ok) { const d = await r.json().catch(() => ({})); this.showNotice(d.error || 'Move failed', true); return; }
      await this.loadStrips();
      if (strip) {
        const updated = this.strips.find(s => s.id === strip.id);
        if (updated) await this._recascadeStrip(updated);
      }
    },

    async moveSlotToStrip(id, newStripId) {
      if (!newStripId) return;
      const sourceStrip = this.strips.find(s => s.slots.some(sl => sl.id === id));
      const r = await fetch(`/api/opp2/pipeline/slots/${id}/move-strip`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ strip_id: Number(newStripId) }),
      });
      if (!r.ok) { const d = await r.json().catch(() => ({})); this.showNotice(d.error || 'Move failed', true); return; }
      await this.loadStrips();
      if (sourceStrip) {
        const updated = this.strips.find(s => s.id === sourceStrip.id);
        if (updated) await this._recascadeStrip(updated);
      }
    },

    // ── Drag-and-drop ─────────────────────────────────────────────────────────

    dragStart(slotId) {
      this.drag.id = slotId;
    },

    dragOver(slotId) {
      this.drag.overSlotId = slotId;
    },

    dragEnd() {
      this.drag = { id: null, overSlotId: null };
    },

    async onDropSlot() {
      const fromId = this.drag.id;
      const toId   = this.drag.overSlotId;
      this.drag = { id: null, overSlotId: null };
      if (!fromId || !toId || fromId === toId) return;
      const strip = this.strips.find(s => s.slots.some(sl => sl.id === fromId));
      if (!strip) return;
      await this._reorderWithinStrip(strip, fromId, toId);
    },

    async _reorderWithinStrip(strip, draggedId, beforeId) {
      const pending = strip.slots
        .filter(s => s.status !== 'done')
        .slice().sort((a, b) => a.slot_order - b.slot_order);
      const withoutDragged = pending.filter(s => s.id !== draggedId);
      const insertIdx = withoutDragged.findIndex(s => s.id === beforeId);
      if (insertIdx === -1) return;
      const dragged = pending.find(s => s.id === draggedId);
      const newOrder = [
        ...withoutDragged.slice(0, insertIdx),
        dragged,
        ...withoutDragged.slice(insertIdx),
      ];
      const r = await fetch(`/api/opp2/pipeline/strip/${strip.id}/reorder`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ordered_ids: newOrder.map(s => s.id) }),
      });
      if (!r.ok) { const d = await r.json().catch(() => ({})); this.showNotice(d.error || 'Reorder failed', true); return; }
      await this.loadStrips();
      const updated = this.strips.find(s => s.id === strip.id);
      if (updated) await this._recascadeStrip(updated);
    },

    // Recascade all scheduled pending slots from the minimum scheduled time.
    // Stops at any slot with no scheduled_start (treats it as a deliberate break).
    async _recascadeStrip(strip) {
      const pending = strip.slots
        .filter(s => s.status !== 'done')
        .slice().sort((a, b) => a.slot_order - b.slot_order);
      const timed = pending.filter(s => s.scheduled_start);
      if (!timed.length) return;
      // Use the minimum scheduled_start as anchor so the block starts at the same wall-clock time.
      const anchor = timed.reduce((mn, s) => s.scheduled_start < mn ? s.scheduled_start : mn, timed[0].scheduled_start);
      const firstTimedIdx = pending.findIndex(s => s.scheduled_start);

      const patches = [];
      let runningTime = anchor;
      for (let i = firstTimedIdx; i < pending.length; i++) {
        const slot = pending[i];
        if (!slot.scheduled_start) break; // unscheduled slot stops the chain
        if (slot.scheduled_start !== runningTime) patches.push({ id: slot.id, scheduled_start: runningTime });
        const end = this._computeSlotEnd(slot, runningTime);
        if (!end) break; // no duration info — can't continue
        runningTime = end;
      }

      for (const p of patches) await this._patchSlot(p.id, { scheduled_start: p.scheduled_start });
      if (patches.length) await this.loadStrips();
    },

    async deleteSlot(id) {
      if (!confirm('Remove this slot from the pipeline?')) return;
      const sourceStrip = this.strips.find(s => s.slots.some(sl => sl.id === id));
      const r = await fetch(`/api/opp2/pipeline/slots/${id}`, { method: 'DELETE' });
      if (!r.ok) { const d = await r.json().catch(() => ({})); this.showNotice(d.error || 'Delete failed', true); return; }
      await this.loadStrips();
      if (sourceStrip) {
        const updated = this.strips.find(s => s.id === sourceStrip.id);
        if (updated) await this._recascadeStrip(updated);
      }
    },
  };
}
