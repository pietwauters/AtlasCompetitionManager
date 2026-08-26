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
      const sourceSegments = sourceStrip ? this._stripSegments(sourceStrip) : null;
      const r = await fetch(`/api/opp2/pipeline/slots/${id}/move-strip`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ strip_id: Number(newStripId) }),
      });
      if (!r.ok) { const d = await r.json().catch(() => ({})); this.showNotice(d.error || 'Move failed', true); return; }
      await this.loadStrips();
      if (sourceStrip) {
        const updated = this.strips.find(s => s.id === sourceStrip.id);
        if (updated) await this._recascadeStrip(updated, sourceSegments);
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

    // Splits a strip's current pending slots (in slot_order) into maximal
    // contiguous runs — each run is a set of slot ids that are genuinely
    // back-to-back (slot[i+1]'s scheduled_start exactly equals slot[i]'s
    // *raw* — not bye-discounted, see opp2-core.js's _rawSlotEnd — end),
    // tagged with the run's own anchor (its first member's scheduled_start).
    // A run boundary marks a *deliberate* gap — most commonly a pool block
    // finishing well before a DE block starts on the same physical piste,
    // which are two completely independent schedules that happen to share a
    // strip, not one continuous queue. Raw, not bye-discounted, duration is
    // required here specifically: a bulk-assigned DE round lays every bout
    // out at fixed per-bout spacing regardless of which turn out to be byes,
    // so a bye's shrunk (possibly zero) duration must never be read as a gap
    // splitting what was actually one deliberately contiguous block.
    //
    // Must be called BEFORE a delete/move that's about to happen: it's the
    // only reliable way to know where the real gaps were. Once a run's first
    // slot is gone, there's no way to recover which run it belonged to (or
    // that run's anchor) from the remaining data alone — the whole reason
    // this exists is to capture that up front and carry it through.
    _stripSegments(strip) {
      const pending = strip.slots
        .filter(s => s.status !== 'done' && s.scheduled_start)
        .slice().sort((a, b) => a.slot_order - b.slot_order);
      const segments = [];
      let expectedNext = null;
      for (const slot of pending) {
        if (!segments.length || slot.scheduled_start !== expectedNext) {
          segments.push({ anchor: slot.scheduled_start, slotIds: [slot.id] });
        } else {
          segments[segments.length - 1].slotIds.push(slot.id);
        }
        expectedNext = this._rawSlotEnd(slot, slot.scheduled_start);
      }
      return segments;
    },

    // Recascades a strip's slots run-by-run, each run starting at its own
    // preserved anchor and never bridging into the next — see
    // _stripSegments above for why a run boundary must never move.
    //
    // segments: captured by _stripSegments *before* whatever just happened
    // to this strip (a delete, a move-away). Without a pre-captured set, a
    // single global "earliest remaining scheduled_start" anchor is wrong in
    // two ways found in real use: (1) if the slot holding a run's anchor is
    // the one removed, recomputing fresh drifts that run to start at its
    // next slot's own original time instead of staying put; (2) if a strip
    // has more than one run at all (e.g. a pool block, then a deliberate
    // gap, then a DE block), a single global anchor collapses that gap
    // entirely — a bye removed from the DE block would recascade the whole
    // strip from the *pool* block's start, pulling DE forward to butt
    // directly against pool with no buffer, discarding a start time the
    // director explicitly chose when bulk-assigning. Falls back to a fresh
    // _stripSegments(strip) when omitted (safe for callers — moveSlot,
    // onDropSlot — that only reorder, never remove anything).
    async _recascadeStrip(strip, segments) {
      const segs = segments || this._stripSegments(strip);
      if (!segs.length) return;
      const pending = strip.slots.filter(s => s.status !== 'done');
      const byId = new Map(pending.map(s => [s.id, s]));

      const patches = [];
      for (const seg of segs) {
        let runningTime = seg.anchor;
        for (const slotId of seg.slotIds) {
          const slot = byId.get(slotId);
          if (!slot) continue; // this member was deleted — keep chaining the rest of the run
          if (slot.scheduled_start !== runningTime) patches.push({ id: slot.id, scheduled_start: runningTime });
          const end = this._computeSlotEnd(slot, runningTime);
          if (!end) break; // no duration info — can't continue this run
          runningTime = end;
        }
      }

      for (const p of patches) await this._patchSlot(p.id, { scheduled_start: p.scheduled_start });
      if (patches.length) await this.loadStrips();
    },

    async deleteSlot(id) {
      if (!confirm('Remove this slot from the pipeline?')) return;
      const sourceStrip = this.strips.find(s => s.slots.some(sl => sl.id === id));
      const sourceSegments = sourceStrip ? this._stripSegments(sourceStrip) : null;
      const r = await fetch(`/api/opp2/pipeline/slots/${id}`, { method: 'DELETE' });
      if (!r.ok) { const d = await r.json().catch(() => ({})); this.showNotice(d.error || 'Delete failed', true); return; }
      await this.loadStrips();
      if (sourceStrip) {
        const updated = this.strips.find(s => s.id === sourceStrip.id);
        if (updated) await this._recascadeStrip(updated, sourceSegments);
      }
    },

    // Bulk equivalent of deleteSlot, scoped to every slot that's *wholly* a
    // confirmed bye (de_bye_count === de_bout_total, both > 0 — set once a
    // DE skeleton is seeded, lib/deSlotMath.js's fillDeByeInfo) — a real,
    // resolved walkover that will never need real fencing time, across every
    // strip at once. Deletes each match slot-by-slot with the existing
    // single-slot endpoint (no new backend needed), then recascades every
    // affected strip exactly once at the end rather than after each
    // individual delete, so the remaining schedule shifts up cleanly in one
    // pass instead of one small step per removed bye.
    async removeConfirmedByes() {
      const byeSlots = this.strips.flatMap(strip =>
        strip.slots
          .filter(s => s.type === 'de' && s.de_bye_count > 0 && s.de_bye_count === s.de_bout_total)
          .map(s => ({ stripId: strip.id, slotId: s.id }))
      );
      if (!byeSlots.length) { this.showNotice('No confirmed byes to remove'); return; }
      if (!confirm(
        `Remove ${byeSlots.length} confirmed-bye slot${byeSlots.length !== 1 ? 's' : ''} from the schedule ` +
        `and shift up everything scheduled after them on their strip? This cannot be undone.`
      )) return;

      // Capture every affected strip's run structure before deleting
      // anything — see _stripSegments/_recascadeStrip's comments for why: a
      // strip can hold more than one independent block (e.g. a pool block,
      // then a deliberate gap, then this DE block), and byes are only ever
      // removed from within the DE block — recascading from a freshly
      // recomputed single anchor would pull the whole strip's earliest
      // block's start time in and collapse that gap.
      const affectedStripIds = [...new Set(byeSlots.map(x => x.stripId))];
      const stripSegments = new Map(affectedStripIds.map(id => {
        const strip = this.strips.find(s => s.id === id);
        return [id, strip ? this._stripSegments(strip) : null];
      }));

      let removed = 0;
      let failed = 0;
      for (const { slotId } of byeSlots) {
        const r = await fetch(`/api/opp2/pipeline/slots/${slotId}`, { method: 'DELETE' });
        if (r.ok) removed++; else failed++;
      }
      await this.loadStrips();

      for (const stripId of affectedStripIds) {
        const updated = this.strips.find(s => s.id === stripId);
        if (updated) await this._recascadeStrip(updated, stripSegments.get(stripId));
      }

      this.showNotice(
        failed
          ? `Removed ${removed} bye slot(s), ${failed} failed — schedule shifted up.`
          : `Removed ${removed} bye slot${removed !== 1 ? 's' : ''} — schedule shifted up on ` +
            `${affectedStripIds.length} strip${affectedStripIds.length !== 1 ? 's' : ''}.`,
        failed > 0
      );
    },
  };
}
