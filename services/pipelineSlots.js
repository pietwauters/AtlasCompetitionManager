'use strict';
// Pipeline slot CRUD + officiating roster + referee/official double-booking
// enforcement. Split out of the former services/pipeline.js god-file
// (2026-07-29) — see services/pipeline.js for the orchestrator that
// recombines this with pipelineNav.js/pipelineRosters.js into the same
// public `Pipeline` API every existing caller already uses.
const db = require('../db');
const { isValidPartition, fillDeBoutCount } = require('../lib/deSlotMath');

const stmtSlotById    = db.prepare('SELECT * FROM pipeline_slots WHERE id = ?');
const stmtRefereeName = db.prepare(`
  SELECT p.first_name AS ref_first, p.last_name AS ref_last, p.nationality AS ref_nation
  FROM referees r JOIN people p ON p.id = r.person_id WHERE r.id = ?
`);
const stmtSetOfficial = db.prepare(`
  INSERT INTO pipeline_slot_officials (slot_id, role, referee_id)
  VALUES (@slot_id, @role, @referee_id)
  ON CONFLICT (slot_id, role) DO UPDATE SET referee_id = excluded.referee_id
`);
const stmtClearOfficial  = db.prepare('DELETE FROM pipeline_slot_officials WHERE slot_id = ? AND role = ?');
const stmtOfficialsForSlot = db.prepare(`
  SELECT so.role, so.referee_id, p.first_name, p.last_name, p.nationality
  FROM pipeline_slot_officials so
  JOIN referees r ON r.id = so.referee_id
  JOIN people   p ON p.id = r.person_id
  WHERE so.slot_id = ?
`);
const stmtFindByPool = db.prepare('SELECT * FROM pipeline_slots WHERE pool_id = ?');
const stmtSlotForPoolOnStrip = db.prepare(
  'SELECT id FROM pipeline_slots WHERE pool_id = ? AND strip_id = ?'
);
const stmtSlotsForPoolOrdered = db.prepare(
  'SELECT id, strip_id FROM pipeline_slots WHERE pool_id = ? ORDER BY slot_order'
);
const stmtFindByPhaseQuery = db.prepare(`
  SELECT ps.*, st.name AS strip_name, st.strip_number
  FROM pipeline_slots ps
  JOIN strips st ON st.id = ps.strip_id
  WHERE ps.phase_id = ? AND ps.type = 'de'
  ORDER BY ps.tableau DESC
`);
const stmtFindByStripQuery = db.prepare(`
  SELECT ps.*,
    po.phase_id   AS pool_phase_id,
    ph.competition_id,
    ph.type       AS phase_type,
    ph.phase_order,
    co.name       AS competition_name,
    co.weapon,
    po.pool_number, po.strip_count, po.dynamic_reorder,
    tm_slot.left_team_id, tm_left.name AS left_team_name,
    tm_slot.right_team_id, tm_right.name AS right_team_name,
    rp.first_name AS ref_first, rp.last_name AS ref_last,
    so_ref2.referee_id AS referee2_id,         rp_ref2.first_name AS referee2_first,         rp_ref2.last_name AS referee2_last,
    so_va.referee_id   AS video_assistant_id,  rp_va.first_name   AS video_assistant_first,  rp_va.last_name   AS video_assistant_last,
    so_a1.referee_id   AS assessor1_id,        rp_a1.first_name   AS assessor1_first,        rp_a1.last_name   AS assessor1_last,
    so_a2.referee_id   AS assessor2_id,        rp_a2.first_name   AS assessor2_first,        rp_a2.last_name   AS assessor2_last,
    CASE WHEN ps.type = 'pool'
      THEN (SELECT COUNT(*) FROM bouts b WHERE b.pool_id = ps.pool_id
              AND (po.strip_count <= 1 OR b.strip_id = ps.strip_id))
      WHEN ps.type = 'team_match'
      THEN (SELECT COUNT(*) FROM relays r WHERE r.team_match_id = ps.team_match_id)
      ELSE NULL  -- computed in JS for DE slots (depends on partition)
    END AS bout_count,
    COALESCE(ps.minutes_per_bout,
      (SELECT CASE WHEN ds.sample_count >= 4 AND ds.observed_average IS NOT NULL
                   THEN ds.observed_average
                   ELSE ds.minutes_per_bout END
       FROM bout_duration_standards ds
       WHERE ds.weapon = CASE co.weapon WHEN 'foil' THEN 'F' WHEN 'epee' THEN 'E' WHEN 'sabre' THEN 'S' ELSE co.weapon END
         AND ds.gender = co.gender
         AND ds.phase_type = CASE WHEN ps.type='pool' THEN 'pool' ELSE 'de' END)
    ) AS effective_minutes_per_bout
  FROM pipeline_slots ps
  LEFT JOIN pools        po       ON po.id       = ps.pool_id
  LEFT JOIN team_matches tm_slot  ON tm_slot.id  = ps.team_match_id
  LEFT JOIN teams        tm_left  ON tm_left.id  = tm_slot.left_team_id
  LEFT JOIN teams        tm_right ON tm_right.id = tm_slot.right_team_id
  LEFT JOIN phases       ph ON ph.id  = COALESCE(ps.phase_id, po.phase_id, tm_slot.phase_id)
  LEFT JOIN competitions co ON co.id  = ph.competition_id
  LEFT JOIN referees     r  ON r.id   = ps.referee_id
  LEFT JOIN people       rp ON rp.id  = r.person_id
  LEFT JOIN pipeline_slot_officials so_ref2 ON so_ref2.slot_id = ps.id AND so_ref2.role = 'referee2'
  LEFT JOIN referees     ref2 ON ref2.id = so_ref2.referee_id
  LEFT JOIN people       rp_ref2 ON rp_ref2.id = ref2.person_id
  LEFT JOIN pipeline_slot_officials so_va ON so_va.slot_id = ps.id AND so_va.role = 'video_assistant'
  LEFT JOIN referees     refva ON refva.id = so_va.referee_id
  LEFT JOIN people       rp_va ON rp_va.id = refva.person_id
  LEFT JOIN pipeline_slot_officials so_a1 ON so_a1.slot_id = ps.id AND so_a1.role = 'assessor1'
  LEFT JOIN referees     refa1 ON refa1.id = so_a1.referee_id
  LEFT JOIN people       rp_a1 ON rp_a1.id = refa1.person_id
  LEFT JOIN pipeline_slot_officials so_a2 ON so_a2.slot_id = ps.id AND so_a2.role = 'assessor2'
  LEFT JOIN referees     refa2 ON refa2.id = so_a2.referee_id
  LEFT JOIN people       rp_a2 ON rp_a2.id = refa2.person_id
  WHERE ps.strip_id = ?
  ORDER BY ps.slot_order
`);
const stmtFindAllForRefereeQuery = db.prepare(`
  SELECT ps.*, st.name AS strip_name, st.strip_number,
    po.pool_number,
    ph.type AS phase_type, ph.phase_order,
    co.name AS competition_name, co.weapon,
    tm_slot.left_team_id, tm_left.name AS left_team_name,
    tm_slot.right_team_id, tm_right.name AS right_team_name,
    GROUP_CONCAT(so.role) AS other_roles,
    CASE WHEN ps.type = 'pool'
      THEN (SELECT COUNT(*) FROM bouts b WHERE b.pool_id = ps.pool_id
              AND (po.strip_count <= 1 OR b.strip_id = ps.strip_id))
      WHEN ps.type = 'team_match'
      THEN (SELECT COUNT(*) FROM relays r WHERE r.team_match_id = ps.team_match_id)
      ELSE NULL
    END AS bout_count,
    COALESCE(ps.minutes_per_bout,
      (SELECT CASE WHEN ds.sample_count >= 4 AND ds.observed_average IS NOT NULL
                   THEN ds.observed_average
                   ELSE ds.minutes_per_bout END
       FROM bout_duration_standards ds
       WHERE ds.weapon = CASE co.weapon WHEN 'foil' THEN 'F' WHEN 'epee' THEN 'E' WHEN 'sabre' THEN 'S' ELSE co.weapon END
         AND ds.gender = co.gender
         AND ds.phase_type = CASE WHEN ps.type='pool' THEN 'pool' ELSE 'de' END)
    ) AS effective_minutes_per_bout
  FROM pipeline_slots ps
  JOIN strips          st       ON st.id       = ps.strip_id
  LEFT JOIN pools      po       ON po.id       = ps.pool_id
  LEFT JOIN team_matches tm_slot  ON tm_slot.id  = ps.team_match_id
  LEFT JOIN teams        tm_left  ON tm_left.id  = tm_slot.left_team_id
  LEFT JOIN teams        tm_right ON tm_right.id = tm_slot.right_team_id
  LEFT JOIN phases       ph ON ph.id  = COALESCE(ps.phase_id, po.phase_id, tm_slot.phase_id)
  LEFT JOIN competitions co ON co.id  = ph.competition_id
  LEFT JOIN pipeline_slot_officials so ON so.slot_id = ps.id AND so.referee_id = @refId
  WHERE ps.referee_id = @refId OR so.referee_id IS NOT NULL
  GROUP BY ps.id
  ORDER BY ps.strip_id, ps.slot_order
`);
const stmtFindAllStripsQuery = db.prepare(`
  SELECT s.*, COUNT(ps.id) AS slot_count
  FROM strips s
  LEFT JOIN pipeline_slots ps ON ps.strip_id = s.id
  GROUP BY s.id
  ORDER BY s.strip_number
`);
const stmtExistingDeSlot = db.prepare(`
  SELECT * FROM pipeline_slots
  WHERE phase_id = ? AND type = 'de'
    AND COALESCE(bracket, 'main') = ?
    AND COALESCE(tableau, 0) = ?
    AND COALESCE(partition, 'full') = ?
    AND COALESCE(de_round, -1) = COALESCE(?, -1)
`);
const stmtDeletePipelineSlot = db.prepare('DELETE FROM pipeline_slots WHERE id = ?');
const stmtExistingSlotForPoolOnStrip = db.prepare(
  'SELECT * FROM pipeline_slots WHERE pool_id = ? AND strip_id = ?'
);
const stmtSetSlotPending = db.prepare("UPDATE pipeline_slots SET status='pending' WHERE id=?");
const stmtSetStripAssigned = db.prepare("UPDATE strips SET status='assigned' WHERE id=?");
const stmtOtherSlotsForPool = db.prepare(
  'SELECT * FROM pipeline_slots WHERE pool_id = ? AND strip_id != ?'
);
const stmtCountSlotsWithPoolOnStrip = db.prepare(
  'SELECT COUNT(*) AS n FROM pipeline_slots WHERE strip_id = ? AND pool_id IS NOT NULL'
);
const stmtExistingSlotForTeamMatchOnStrip = db.prepare(
  'SELECT * FROM pipeline_slots WHERE team_match_id = ? AND strip_id = ?'
);
const stmtOtherSlotsForTeamMatch = db.prepare(
  'SELECT * FROM pipeline_slots WHERE team_match_id = ? AND strip_id != ?'
);
const stmtCountSlotsWithTeamMatchOnStrip = db.prepare(
  'SELECT COUNT(*) AS n FROM pipeline_slots WHERE strip_id = ? AND team_match_id IS NOT NULL'
);
const stmtSetStripIdle = db.prepare("UPDATE strips SET status='idle' WHERE id=?");
const stmtMaxSlotOrderForStrip = db.prepare(
  'SELECT COALESCE(MAX(slot_order), 0) AS m FROM pipeline_slots WHERE strip_id = ?'
);
const stmtInsertPipelineSlot = db.prepare(`
  INSERT INTO pipeline_slots
    (strip_id, slot_order, type, pool_id, phase_id, team_match_id,
     bracket, tableau, partition, de_round,
     scheduled_start, minutes_per_bout, referee_id)
  VALUES
    (@strip_id, @slot_order, @type, @pool_id, @phase_id, @team_match_id,
     @bracket, @tableau, @partition, @de_round,
     @scheduled_start, @minutes_per_bout, @referee_id)
`);
const stmtSetPoolStripId = db.prepare('UPDATE pools SET strip_id = ? WHERE id = ?');
const stmtUpdateSlotFields = db.prepare(`
  UPDATE pipeline_slots
  SET scheduled_start         = @scheduled_start,
      minutes_per_bout        = @minutes_per_bout,
      referee_id              = @referee_id,
      status                  = @status,
      conflict_referee_id     = @conflict_referee_id,
      conflict_original_start = @conflict_original_start,
      conflict_paired_slot_id = @conflict_paired_slot_id
  WHERE id = @id
`);
const stmtPoolStripIdLookup = db.prepare('SELECT strip_id FROM pools WHERE id = ?');
const stmtSetPoolRefereeId = db.prepare('UPDATE pools SET referee_id = ? WHERE id = ?');
const stmtSiblingUp = db.prepare(`
  SELECT * FROM pipeline_slots
  WHERE strip_id = ? AND slot_order < ?
  ORDER BY slot_order DESC
  LIMIT 1
`);
const stmtSiblingDown = db.prepare(`
  SELECT * FROM pipeline_slots
  WHERE strip_id = ? AND slot_order > ?
  ORDER BY slot_order ASC
  LIMIT 1
`);
const stmtSetSlotOrderNeg1 = db.prepare('UPDATE pipeline_slots SET slot_order = -1 WHERE id = ?');
const stmtSetSlotOrder = db.prepare('UPDATE pipeline_slots SET slot_order = ? WHERE id = ?');
const stmtClearPoolStripId = db.prepare('UPDATE pools SET strip_id = NULL WHERE id = ?');
const stmtMaxDoneSlotOrder = db.prepare(
  "SELECT COALESCE(MAX(slot_order), 0) AS m FROM pipeline_slots WHERE strip_id = ? AND status = 'done'"
);
const stmtBatchReorderUpdate = db.prepare(
  'UPDATE pipeline_slots SET slot_order = ? WHERE id = ? AND strip_id = ?'
);
const stmtMoveSlotToStrip = db.prepare(
  'UPDATE pipeline_slots SET strip_id = ?, slot_order = ? WHERE id = ?'
);

// ── Referee/official double-booking enforcement ────────────────────────────
// public/opp2.html's conflict-detection modal mirrors this (same window/
// overlap math) but is client-side only — added here 2026-07-28 (architecture
// review) because updateSlot previously persisted whatever referee/official
// fields a client sent with zero verification, making the modal real UX but
// not an actual constraint. Any other caller of the PATCH route could
// double-book a referee with no pushback at all.
const ROLE_FIELDS = {
  referee_id:         'Referee',
  referee2_id:        'Referee 2',
  video_assistant_id: 'Video Assistant',
  assessor1_id:        'Assessor 1',
  assessor2_id:        'Assessor 2',
};

function addMinutes(hhmm, mins) {
  const [h, m] = hhmm.split(':').map(Number);
  const total = (((h * 60 + m + Math.round(mins)) % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

// A slot's [start, end) window for overlap purposes, or null if it has no
// scheduled_start at all — nothing to double-book against (mirrors
// opp2.html's _slotWindow; the +30min fallback matches its final fallback
// for a slot with no computable predicted_end).
function slotWindow(slot) {
  if (!slot.scheduled_start) return null;
  return { start: slot.scheduled_start, end: slot.predicted_end || addMinutes(slot.scheduled_start, 30) };
}

function windowsOverlap(a, b) {
  return a.start < b.end && b.start < a.end;
}

// Build slot.officials from the findByStrip join columns: one entry per
// assigned role, including the primary referee, for a single flat list
// frontends can iterate instead of five separate fields.
function attachOfficials(slot) {
  const officials = [];
  if (slot.referee_id)
    officials.push({ role: 'referee', referee_id: slot.referee_id, first_name: slot.ref_first || '', last_name: slot.ref_last || '' });
  if (slot.referee2_id)
    officials.push({ role: 'referee2', referee_id: slot.referee2_id, first_name: slot.referee2_first || '', last_name: slot.referee2_last || '' });
  if (slot.video_assistant_id)
    officials.push({ role: 'video_assistant', referee_id: slot.video_assistant_id, first_name: slot.video_assistant_first || '', last_name: slot.video_assistant_last || '' });
  if (slot.assessor1_id)
    officials.push({ role: 'assessor1', referee_id: slot.assessor1_id, first_name: slot.assessor1_first || '', last_name: slot.assessor1_last || '' });
  if (slot.assessor2_id)
    officials.push({ role: 'assessor2', referee_id: slot.assessor2_id, first_name: slot.assessor2_first || '', last_name: slot.assessor2_last || '' });
  return { ...slot, officials };
}

// Shared with pipelineNav.js's own copy of this same math (each file's
// findByStrip/findAllForReferee vs. nextBout/prevBout use it independently —
// duplicating one small pure helper per file, rather than adding a
// dependency just for this, matches the precedent set by
// services/poolPhases.js/dePhases.js each keeping their own stmtPhaseById).
function withPredictedEnd(slot) {
  if (!slot.scheduled_start || !slot.effective_minutes_per_bout || !slot.bout_count) {
    return { ...slot, predicted_end: null };
  }
  const [h, m] = slot.scheduled_start.split(':').map(Number);
  const totalMin = h * 60 + m + slot.bout_count * slot.effective_minutes_per_bout;
  const ph = Math.floor(totalMin / 60) % 24;
  const pm = totalMin % 60;
  return { ...slot, predicted_end: `${String(ph).padStart(2,'0')}:${String(pm).padStart(2,'0')}` };
}

const PipelineSlots = {

  // ── Queries ───────────────────────────────────────────────────────────────

  findById(id) {
    return stmtSlotById.get(id);
  },

  refereeName(refereeId) {
    if (!refereeId) return null;
    const ref = stmtRefereeName.get(refereeId);
    return ref
      ? { referee_id: Number(refereeId), first_name: ref.ref_first || '', last_name: ref.ref_last || '', nation: ref.ref_nation || '' }
      : null;
  },

  // { referee2, video_assistant, assessor1, assessor2 }, each null or
  // {referee_id, first_name, last_name, nation}.
  getOfficials(slotId) {
    const rows = stmtOfficialsForSlot.all(slotId);
    const result = { referee2: null, video_assistant: null, assessor1: null, assessor2: null };
    for (const r of rows) {
      result[r.role] = { referee_id: r.referee_id, first_name: r.first_name || '', last_name: r.last_name || '', nation: r.nationality || '' };
    }
    return result;
  },

  // role must be one of 'referee2' | 'video_assistant' | 'assessor1' | 'assessor2'.
  setOfficial(slotId, role, refereeId) {
    if (!refereeId) { stmtClearOfficial.run(Number(slotId), role); return; }
    stmtSetOfficial.run({ slot_id: Number(slotId), role, referee_id: Number(refereeId) });
  },

  findByPool(poolId) {
    return stmtFindByPool.get(poolId) || null;
  },

  // Whether a pipeline slot already exists for this (pool, strip) pair —
  // used when distributing a pool's bouts across multiple strips to decide
  // whether a secondary slot still needs creating.
  slotForPoolOnStrip(poolId, stripId) {
    return stmtSlotForPoolOnStrip.get(poolId, stripId) || null;
  },

  // Every pipeline slot for a pool, in slot_order (primary first) — used to
  // reconcile a pool's multi-strip distribution against a new strip list.
  slotsForPool(poolId) {
    return stmtSlotsForPoolOrdered.all(poolId);
  },

  // All DE pipeline slots for a phase, with strip names. Used by de.html.
  findByPhase(phaseId) {
    return stmtFindByPhaseQuery.all(phaseId);
  },

  findByStrip(stripId) {
    const slots = stmtFindByStripQuery.all(stripId);

    return slots.map(s => attachOfficials(withPredictedEnd(fillDeBoutCount(s))));
  },

  findAllForReferee(refereeId) {
    const slots = stmtFindAllForRefereeQuery.all({ refId: Number(refereeId) });

    return slots.map(s => {
      const roles = [];
      if (s.referee_id == refereeId) roles.push('referee');
      if (s.other_roles) roles.push(...s.other_roles.split(','));
      return { ...withPredictedEnd(fillDeBoutCount(s)), roles };
    });
  },

  // All strips with their pipelines, used by the admin page.
  findAllStrips() {
    const strips = stmtFindAllStripsQuery.all();

    return strips.map(s => ({
      ...s,
      slots: PipelineSlots.findByStrip(s.id),
    }));
  },

  // ── CRUD ─────────────────────────────────────────────────────────────────

  addSlot(stripId, data) {
    // Defense in depth against a client submitting a slot type with nothing
    // real behind it (e.g. "pool" selected but no pool actually chosen) —
    // such a slot has no bouts/roster, yet still counts toward slot_count
    // and still shows up on the Gantt, reading as a phantom assignment.
    if (data.type === 'pool' && !data.pool_id) {
      throw new Error('pool_id is required for a pool slot');
    }
    if (data.type === 'team_match' && !data.team_match_id) {
      throw new Error('team_match_id is required for a team_match slot');
    }
    if (data.type === 'de' && (!data.phase_id || !data.tableau)) {
      throw new Error('phase_id and tableau are required for a DE slot');
    }
    if (data.type === 'de' && data.partition && !isValidPartition(data.partition, data.tableau)) {
      throw new Error(`Invalid partition "${data.partition}" for tableau ${data.tableau}`);
    }

    return db.transaction(() => {
      // A DE round (phase_id + bracket + de_round/tableau + partition) can only live
      // on one strip. de_round must be part of this key: a repechage phase's last
      // main-bracket round and first Finals round share the same bracket ('main')
      // and tableau by construction, and would otherwise look like the same round.
      if (data.type === 'de' && data.phase_id && data.tableau) {
        const existing = stmtExistingDeSlot.get(data.phase_id, data.bracket ?? 'main', data.tableau, data.partition ?? 'full', data.de_round ?? null);
        if (existing) {
          if (existing.strip_id === Number(stripId)) return PipelineSlots.findById(existing.id);
          stmtDeletePipelineSlot.run(existing.id);
        }
      }

      // A pool may live in multiple pipeline slots (one per strip for multi-strip).
      // data.secondary = true: adding an extra strip — don't remove existing slots.
      if (data.pool_id) {
        const existingOnThisStrip = stmtExistingSlotForPoolOnStrip.get(data.pool_id, Number(stripId));
        if (existingOnThisStrip) {
          stmtSetSlotPending.run(existingOnThisStrip.id);
          stmtSetStripAssigned.run(Number(stripId));
          return PipelineSlots.findById(existingOnThisStrip.id);
        }
        if (!data.secondary) {
          // Single-strip assignment: remove any existing slots for this pool on other strips.
          const others = stmtOtherSlotsForPool.all(data.pool_id, Number(stripId));
          for (const s of others) {
            stmtDeletePipelineSlot.run(s.id);
            const rem = stmtCountSlotsWithPoolOnStrip.get(s.strip_id).n;
            if (rem === 0) stmtSetStripIdle.run(s.strip_id);
          }
        }
      }

      // A team match happens on one strip at a time (relays have no per-relay
      // strip column to partition across multiple strips the way pool bouts
      // do), so — unlike pools — it can never legitimately live on more than
      // one strip at once. Reassigning it must remove the old slot, or both
      // strips would offer the same next relay simultaneously.
      if (data.team_match_id) {
        const existingOnThisStrip = stmtExistingSlotForTeamMatchOnStrip.get(data.team_match_id, Number(stripId));
        if (existingOnThisStrip) {
          stmtSetSlotPending.run(existingOnThisStrip.id);
          stmtSetStripAssigned.run(Number(stripId));
          return PipelineSlots.findById(existingOnThisStrip.id);
        }
        const others = stmtOtherSlotsForTeamMatch.all(data.team_match_id, Number(stripId));
        for (const s of others) {
          stmtDeletePipelineSlot.run(s.id);
          const rem = stmtCountSlotsWithTeamMatchOnStrip.get(s.strip_id).n;
          if (rem === 0) stmtSetStripIdle.run(s.strip_id);
        }
      }

      const maxOrder = stmtMaxSlotOrderForStrip.get(stripId).m;

      const { lastInsertRowid } = stmtInsertPipelineSlot.run({
        strip_id:         Number(stripId),
        slot_order:       maxOrder + 1,
        type:             data.type,
        pool_id:          data.pool_id          ?? null,
        phase_id:         data.phase_id         ?? null,
        team_match_id:    data.team_match_id    ?? null,
        bracket:          data.bracket          ?? null,
        tableau:          data.tableau          ?? null,
        partition:        data.partition        ?? 'full',
        de_round:         data.de_round         ?? null,
        scheduled_start:  data.scheduled_start  ?? null,
        minutes_per_bout: data.minutes_per_bout ?? null,
        referee_id:       data.referee_id       ?? null,
      });

      if (data.pool_id) {
        // Secondary slots (extra strips for a distributed pool) must not
        // overwrite pools.strip_id — that stays the primary/home strip.
        if (!data.secondary) {
          stmtSetPoolStripId.run(Number(stripId), data.pool_id);
        }
        stmtSetStripAssigned.run(Number(stripId));
      }

      return PipelineSlots.findById(lastInsertRowid);
    })();
  },

  updateSlot(id, data) {
    const current = PipelineSlots.findById(id);
    if (!current) return null;
    const m = { ...current, ...data };

    // Server-side enforcement of referee/official double-booking (see
    // ROLE_FIELDS comment above) — only when a role field is actually being
    // assigned a non-null value, and only when this slot has a
    // scheduled_start (no window, nothing to conflict-check — same "can't
    // verify without a start time" gate opp2.html's own warning modal uses).
    const roleFieldsBeingSet = Object.keys(ROLE_FIELDS).filter(f => f in data && data[f] != null);
    if (roleFieldsBeingSet.length) {
      const allStrips = PipelineSlots.findAllStrips();
      let targetSlot = null;
      outer: for (const strip of allStrips) {
        for (const s of strip.slots) { if (s.id === Number(id)) { targetSlot = s; break outer; } }
      }
      const window = targetSlot ? slotWindow(targetSlot) : null;
      if (window) {
        for (const field of roleFieldsBeingSet) {
          const refereeId = data[field];
          for (const strip of allStrips) {
            for (const other of strip.slots) {
              if (other.id === Number(id)) continue;
              const otherWindow = slotWindow(other);
              if (!otherWindow || !windowsOverlap(window, otherWindow)) continue;
              for (const otherField of Object.keys(ROLE_FIELDS)) {
                if (other[otherField] != null && String(other[otherField]) === String(refereeId)) {
                  throw Object.assign(new Error(
                    `${ROLE_FIELDS[field]} assignment conflicts: this referee is already assigned as ` +
                    `${ROLE_FIELDS[otherField]} on ${strip.name || ('Piste ' + strip.strip_number)} ` +
                    `(${other.scheduled_start}–${other.predicted_end || '?'}), which overlaps this slot's schedule.`
                  ), { status: 409 });
                }
              }
            }
          }
        }
      }
    }

    const OFFICIAL_ROLES = {
      referee2_id:         'referee2',
      video_assistant_id:  'video_assistant',
      assessor1_id:        'assessor1',
      assessor2_id:        'assessor2',
    };

    db.transaction(() => {
      stmtUpdateSlotFields.run({
        id: Number(id),
        scheduled_start:         m.scheduled_start         ?? null,
        minutes_per_bout:        m.minutes_per_bout        ?? null,
        referee_id:              m.referee_id              ?? null,
        status:                  m.status,
        conflict_referee_id:     m.conflict_referee_id     ?? null,
        conflict_original_start: m.conflict_original_start ?? null,
        conflict_paired_slot_id: m.conflict_paired_slot_id ?? null,
      });

      for (const [field, role] of Object.entries(OFFICIAL_ROLES)) {
        if (field in data) PipelineSlots.setOfficial(id, role, data[field]);
      }

      // Mirror back onto pools.referee_id (the phase.html/pool.html display
      // badge) — symmetric with how strip_id is already mirrored in
      // addSlot/deleteSlot/moveToStrip below. Only for the slot that IS the
      // pool's primary/home strip (matches pools.strip_id itself only ever
      // reflecting the primary strip); a distributed pool's secondary-strip
      // slots keep their own referee independently.
      if ('referee_id' in data && current.type === 'pool' && current.pool_id) {
        const pool = stmtPoolStripIdLookup.get(current.pool_id);
        if (pool && pool.strip_id === current.strip_id) {
          stmtSetPoolRefereeId.run(m.referee_id ?? null, current.pool_id);
        }
      }
    })();

    return PipelineSlots.findById(id);
  },

  reorder(id, direction) {
    const slot = PipelineSlots.findById(id);
    if (!slot) return false;
    const sibling = (direction === 'up' ? stmtSiblingUp : stmtSiblingDown).get(slot.strip_id, slot.slot_order);
    if (!sibling) return false;

    db.transaction(() => {
      stmtSetSlotOrderNeg1.run(slot.id);
      stmtSetSlotOrder.run(slot.slot_order, sibling.id);
      stmtSetSlotOrder.run(sibling.slot_order, slot.id);
    })();
    return true;
  },

  deleteSlot(id) {
    return db.transaction(() => {
      const slot = PipelineSlots.findById(id);
      if (!slot) return false;
      const changed = stmtDeletePipelineSlot.run(id).changes > 0;
      if (changed && slot.pool_id) {
        stmtClearPoolStripId.run(slot.pool_id);
        const remaining = stmtCountSlotsWithPoolOnStrip.get(slot.strip_id).n;
        if (remaining === 0) stmtSetStripIdle.run(slot.strip_id);
      }
      return changed;
    })();
  },

  batchReorder(stripId, pendingOrderedIds) {
    db.transaction(() => {
      const maxDone = stmtMaxDoneSlotOrder.get(Number(stripId)).m;
      const base = maxDone + 1;
      pendingOrderedIds.forEach((id, i) => {
        stmtBatchReorderUpdate.run(base + i, id, Number(stripId));
      });
    })();
  },

  moveToStrip(slotId, newStripId) {
    return db.transaction(() => {
      const slot = PipelineSlots.findById(slotId);
      if (!slot) return null;
      const newId = Number(newStripId);
      if (slot.strip_id === newId) return slot;

      const maxOrder = stmtMaxSlotOrderForStrip.get(newId).m;

      stmtMoveSlotToStrip.run(newId, maxOrder + 1, slotId);

      if (slot.pool_id) {
        stmtSetPoolStripId.run(newId, slot.pool_id);
        const remaining = stmtCountSlotsWithPoolOnStrip.get(slot.strip_id).n;
        if (remaining === 0) stmtSetStripIdle.run(slot.strip_id);
        stmtSetStripAssigned.run(newId);
      }

      return PipelineSlots.findById(slotId);
    })();
  },
};

module.exports = PipelineSlots;
