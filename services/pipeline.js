'use strict';
const db = require('../db');
const DeLayout = require('./deLayout');

// Hot-path statements compiled once at module load.
const stmtSlotById    = db.prepare('SELECT * FROM pipeline_slots WHERE id = ?');
const stmtActiveSlot  = db.prepare(`
  SELECT * FROM pipeline_slots
  WHERE strip_id = ? AND status IN ('active', 'pending')
  ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, slot_order
  LIMIT 1
`);
const stmtMarkActive     = db.prepare("UPDATE pipeline_slots SET status='active'  WHERE id=?");
const stmtMarkDone       = db.prepare("UPDATE pipeline_slots SET status='done'    WHERE id=?");
const stmtSlotStripId    = db.prepare('SELECT strip_id FROM pipeline_slots WHERE id=?');
const stmtActiveCount    = db.prepare("SELECT COUNT(*) AS n FROM pipeline_slots WHERE strip_id=? AND status IN ('pending','active')");
const stmtSetStripIdle   = db.prepare("UPDATE strips SET status='idle' WHERE id=?");
const stmtPendingPool    = db.prepare(`
  SELECT COUNT(*) AS n FROM bouts b
  JOIN pools po ON po.id = b.pool_id
  WHERE b.pool_id = @pool_id AND b.status != 'finished'
    AND (po.strip_count <= 1 OR b.strip_id = @strip_id)
`);
const stmtPendingTeam    = db.prepare("SELECT COUNT(*) AS n FROM relays WHERE team_match_id=?  AND status!='finished'");
const stmtStaleDoneSlots = db.prepare("SELECT * FROM pipeline_slots WHERE strip_id=? AND status='done' ORDER BY slot_order");
const stmtRecoverSlot    = db.prepare("UPDATE pipeline_slots SET status='pending' WHERE id=?");
const stmtRefereeName    = db.prepare(`
  SELECT p.first_name AS ref_first, p.last_name AS ref_last, p.nationality AS ref_nation
  FROM referees r JOIN people p ON p.id = r.person_id WHERE r.id = ?
`);
const stmtSetOfficial    = db.prepare(`
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

// Bouts in a DE round ordered by tableau position.
// round_index is 1-based within the round, matching partition ranges.
// bracket is bound as the first parameter of the outer query (see call sites).
const DE_BOUT_ORDER = `
  SELECT b.id, b.tableau_position, b.status, b.left_id, b.right_id,
         b.left_score, b.right_score, b.winner_id, b.de_round,
         ROW_NUMBER() OVER (PARTITION BY b.phase_id, b.de_round
                            ORDER BY b.tableau_position) AS round_index
  FROM bouts b
  WHERE b.de_round IS NOT NULL AND b.bracket = ?
`;

// Convert a slot's tableau size to the de_round integer stored on bouts.
// de_round 1 = first (largest) round; each subsequent round halves the field.
// Derived from the bout count in round 1: initial_tableau = count_in_round_1 × 2.
function tableauToDeRound(phaseId, tableau) {
  if (!phaseId || !tableau) return null;
  const r = db.prepare(`
    SELECT COUNT(*) AS cnt FROM bouts WHERE phase_id = ? AND de_round = 1
  `).get(phaseId);
  if (!r || !r.cnt) return null;
  const initialTableau = r.cnt * 2;
  const round = Math.round(Math.log2(initialTableau / tableau)) + 1;
  return round >= 1 ? round : null;
}

// Convert a partition code to a 1-based [lo, hi] round_index range.
// Partition codes are hierarchical binary subdivisions of the round:
//   'full'      → all bouts   [1, n]
//   'A' / 'B'   → halves      [1, n/2] / [n/2+1, n]
//   'A1'/'A2'   → quarters    [1, n/4] / [n/4+1, n/2]
//   'B1'/'B2'   → right quart [n/2+1, 3n/4] / [3n/4+1, n]
//   'A1a'…      → eighths, etc.
// n = tableau / 2  (bouts in the round = fencers / 2)
// Each character halves the current range: A/1/a = lower half, B/2/b = upper half.
// Letters I and O are skipped in displayed labels to avoid confusion with 1 and 0.
function partitionToRange(partition, tableau) {
  const n = tableau / 2;
  if (!partition || partition === 'full') return [1, n];
  let lo = 1, hi = n;
  for (const ch of partition) {
    const mid = Math.floor((lo + hi) / 2);
    const isLower = (ch === 'A' || ch === '1' || ch === 'a' || ch === 'c' || ch === 'e' || ch === 'g');
    if (isLower) hi = mid; else lo = mid + 1;
  }
  return [lo, hi];
}

// Inverse of partitionToRange: encode a 1-based [lo, hi] range in [1, n] back
// to its canonical partition code, or null if [lo, hi] doesn't align with a
// binary-tree node (mirrors public/opp2.html's own rangeToPartition, used
// there to validate a bout-range selection before ever submitting it).
function rangeToPartition(lo, hi, n) {
  if (lo === 1 && hi === n) return 'full';
  const loChars = ['A', '1', 'a', 'c', 'e', 'g'];
  const hiChars = ['B', '2', 'b', 'd', 'f', 'h'];
  let lo_ = 1, hi_ = n, code = '', depth = 0;
  while (lo_ < hi_) {
    const mid = Math.floor((lo_ + hi_) / 2);
    if (lo >= lo_ && hi <= mid)          { code += loChars[depth]; hi_ = mid; }
    else if (lo >= mid + 1 && hi <= hi_) { code += hiChars[depth]; lo_ = mid + 1; }
    else break;
    depth++;
  }
  return (lo_ === lo && hi_ === hi) ? code : null;
}

// Is `partition` an actual, structurally valid subdivision code for this
// tableau — not just a string partitionToRange happens not to crash on?
// partitionToRange alone can't tell: it silently tolerates garbage (unknown
// characters are just treated as "upper half", and an over-long string can
// walk lo past hi into an empty/invalid range) rather than rejecting it.
// Added 2026-07-28 (architecture review) — previously opp2.html's own
// rangeToPartition-returning-null check was the *only* validation of this
// anywhere, and it only ever ran client-side; Pipeline.addSlot accepted any
// partition string a request happened to include.
function isValidPartition(partition, tableau) {
  if (!partition || partition === 'full') return true;
  const n = tableau / 2;
  const [lo, hi] = partitionToRange(partition, tableau);
  if (!(lo >= 1 && hi <= n && lo <= hi)) return false;
  return rangeToPartition(lo, hi, n) === partition;
}

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

const Pipeline = {

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
    return db.prepare('SELECT * FROM pipeline_slots WHERE pool_id = ?').get(poolId) || null;
  },

  // All DE pipeline slots for a phase, with strip names. Used by de.html.
  findByPhase(phaseId) {
    return db.prepare(`
      SELECT ps.*, st.name AS strip_name, st.strip_number
      FROM pipeline_slots ps
      JOIN strips st ON st.id = ps.strip_id
      WHERE ps.phase_id = ? AND ps.type = 'de'
      ORDER BY ps.tableau DESC
    `).all(phaseId);
  },

  findByStrip(stripId) {
    const slots = db.prepare(`
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
    `).all(stripId);

    return slots.map(s => this._attachOfficials(this._withPredictedEnd(this._fillDeBoutCount(s))));
  },

  findAllForReferee(refereeId) {
    const slots = db.prepare(`
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
    `).all({ refId: Number(refereeId) });

    return slots.map(s => {
      const roles = [];
      if (s.referee_id == refereeId) roles.push('referee');
      if (s.other_roles) roles.push(...s.other_roles.split(','));
      return { ...this._withPredictedEnd(this._fillDeBoutCount(s)), roles };
    });
  },

  // All strips with their pipelines, used by the admin page.
  findAllStrips() {
    const strips = db.prepare(`
      SELECT s.*, COUNT(ps.id) AS slot_count
      FROM strips s
      LEFT JOIN pipeline_slots ps ON ps.strip_id = s.id
      GROUP BY s.id
      ORDER BY s.strip_number
    `).all();

    return strips.map(s => ({
      ...s,
      slots: this.findByStrip(s.id),
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
        const existing = db.prepare(`
          SELECT * FROM pipeline_slots
          WHERE phase_id = ? AND type = 'de'
            AND COALESCE(bracket, 'main') = ?
            AND COALESCE(tableau, 0) = ?
            AND COALESCE(partition, 'full') = ?
            AND COALESCE(de_round, -1) = COALESCE(?, -1)
        `).get(data.phase_id, data.bracket ?? 'main', data.tableau, data.partition ?? 'full', data.de_round ?? null);
        if (existing) {
          if (existing.strip_id === Number(stripId)) return this.findById(existing.id);
          db.prepare('DELETE FROM pipeline_slots WHERE id = ?').run(existing.id);
        }
      }

      // A pool may live in multiple pipeline slots (one per strip for multi-strip).
      // data.secondary = true: adding an extra strip — don't remove existing slots.
      if (data.pool_id) {
        const existingOnThisStrip = db.prepare(
          'SELECT * FROM pipeline_slots WHERE pool_id = ? AND strip_id = ?'
        ).get(data.pool_id, Number(stripId));
        if (existingOnThisStrip) {
          db.prepare("UPDATE pipeline_slots SET status='pending' WHERE id=?").run(existingOnThisStrip.id);
          db.prepare("UPDATE strips SET status='assigned' WHERE id=?").run(Number(stripId));
          return this.findById(existingOnThisStrip.id);
        }
        if (!data.secondary) {
          // Single-strip assignment: remove any existing slots for this pool on other strips.
          const others = db.prepare(
            'SELECT * FROM pipeline_slots WHERE pool_id = ? AND strip_id != ?'
          ).all(data.pool_id, Number(stripId));
          for (const s of others) {
            db.prepare('DELETE FROM pipeline_slots WHERE id = ?').run(s.id);
            const rem = db.prepare(
              'SELECT COUNT(*) AS n FROM pipeline_slots WHERE strip_id = ? AND pool_id IS NOT NULL'
            ).get(s.strip_id).n;
            if (rem === 0) db.prepare("UPDATE strips SET status='idle' WHERE id=?").run(s.strip_id);
          }
        }
      }

      // A team match happens on one strip at a time (relays have no per-relay
      // strip column to partition across multiple strips the way pool bouts
      // do), so — unlike pools — it can never legitimately live on more than
      // one strip at once. Reassigning it must remove the old slot, or both
      // strips would offer the same next relay simultaneously.
      if (data.team_match_id) {
        const existingOnThisStrip = db.prepare(
          'SELECT * FROM pipeline_slots WHERE team_match_id = ? AND strip_id = ?'
        ).get(data.team_match_id, Number(stripId));
        if (existingOnThisStrip) {
          db.prepare("UPDATE pipeline_slots SET status='pending' WHERE id=?").run(existingOnThisStrip.id);
          db.prepare("UPDATE strips SET status='assigned' WHERE id=?").run(Number(stripId));
          return this.findById(existingOnThisStrip.id);
        }
        const others = db.prepare(
          'SELECT * FROM pipeline_slots WHERE team_match_id = ? AND strip_id != ?'
        ).all(data.team_match_id, Number(stripId));
        for (const s of others) {
          db.prepare('DELETE FROM pipeline_slots WHERE id = ?').run(s.id);
          const rem = db.prepare(
            'SELECT COUNT(*) AS n FROM pipeline_slots WHERE strip_id = ? AND team_match_id IS NOT NULL'
          ).get(s.strip_id).n;
          if (rem === 0) db.prepare("UPDATE strips SET status='idle' WHERE id=?").run(s.strip_id);
        }
      }

      const maxOrder = db.prepare(
        'SELECT COALESCE(MAX(slot_order), 0) AS m FROM pipeline_slots WHERE strip_id = ?'
      ).get(stripId).m;

      const { lastInsertRowid } = db.prepare(`
        INSERT INTO pipeline_slots
          (strip_id, slot_order, type, pool_id, phase_id, team_match_id,
           bracket, tableau, partition, de_round,
           scheduled_start, minutes_per_bout, referee_id)
        VALUES
          (@strip_id, @slot_order, @type, @pool_id, @phase_id, @team_match_id,
           @bracket, @tableau, @partition, @de_round,
           @scheduled_start, @minutes_per_bout, @referee_id)
      `).run({
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
          db.prepare('UPDATE pools SET strip_id = ? WHERE id = ?').run(Number(stripId), data.pool_id);
        }
        db.prepare("UPDATE strips SET status='assigned' WHERE id=?").run(Number(stripId));
      }

      return this.findById(lastInsertRowid);
    })();
  },

  updateSlot(id, data) {
    const current = this.findById(id);
    if (!current) return null;
    const m = { ...current, ...data };

    // Server-side enforcement of referee/official double-booking (see
    // ROLE_FIELDS comment above) — only when a role field is actually being
    // assigned a non-null value, and only when this slot has a
    // scheduled_start (no window, nothing to conflict-check — same "can't
    // verify without a start time" gate opp2.html's own warning modal uses).
    const roleFieldsBeingSet = Object.keys(ROLE_FIELDS).filter(f => f in data && data[f] != null);
    if (roleFieldsBeingSet.length) {
      const allStrips = this.findAllStrips();
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
      db.prepare(`
        UPDATE pipeline_slots
        SET scheduled_start         = @scheduled_start,
            minutes_per_bout        = @minutes_per_bout,
            referee_id              = @referee_id,
            status                  = @status,
            conflict_referee_id     = @conflict_referee_id,
            conflict_original_start = @conflict_original_start,
            conflict_paired_slot_id = @conflict_paired_slot_id
        WHERE id = @id
      `).run({
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
        if (field in data) this.setOfficial(id, role, data[field]);
      }

      // Mirror back onto pools.referee_id (the phase.html/pool.html display
      // badge) — symmetric with how strip_id is already mirrored in
      // addSlot/deleteSlot/moveToStrip below. Only for the slot that IS the
      // pool's primary/home strip (matches pools.strip_id itself only ever
      // reflecting the primary strip); a distributed pool's secondary-strip
      // slots keep their own referee independently.
      if ('referee_id' in data && current.type === 'pool' && current.pool_id) {
        const pool = db.prepare('SELECT strip_id FROM pools WHERE id = ?').get(current.pool_id);
        if (pool && pool.strip_id === current.strip_id) {
          db.prepare('UPDATE pools SET referee_id = ? WHERE id = ?')
            .run(m.referee_id ?? null, current.pool_id);
        }
      }
    })();

    return this.findById(id);
  },

  reorder(id, direction) {
    const slot = this.findById(id);
    if (!slot) return false;
    const sibling = db.prepare(`
      SELECT * FROM pipeline_slots
      WHERE strip_id = ? AND slot_order ${direction === 'up' ? '<' : '>'} ?
      ORDER BY slot_order ${direction === 'up' ? 'DESC' : 'ASC'}
      LIMIT 1
    `).get(slot.strip_id, slot.slot_order);
    if (!sibling) return false;

    db.transaction(() => {
      db.prepare('UPDATE pipeline_slots SET slot_order = -1 WHERE id = ?').run(slot.id);
      db.prepare('UPDATE pipeline_slots SET slot_order = ? WHERE id = ?').run(slot.slot_order, sibling.id);
      db.prepare('UPDATE pipeline_slots SET slot_order = ? WHERE id = ?').run(sibling.slot_order, slot.id);
    })();
    return true;
  },

  deleteSlot(id) {
    return db.transaction(() => {
      const slot = this.findById(id);
      if (!slot) return false;
      const changed = db.prepare('DELETE FROM pipeline_slots WHERE id = ?').run(id).changes > 0;
      if (changed && slot.pool_id) {
        db.prepare('UPDATE pools SET strip_id = NULL WHERE id = ?').run(slot.pool_id);
        const remaining = db.prepare(
          'SELECT COUNT(*) AS n FROM pipeline_slots WHERE strip_id = ? AND pool_id IS NOT NULL'
        ).get(slot.strip_id).n;
        if (remaining === 0) db.prepare("UPDATE strips SET status='idle' WHERE id=?").run(slot.strip_id);
      }
      return changed;
    })();
  },

  batchReorder(stripId, pendingOrderedIds) {
    db.transaction(() => {
      const maxDone = db.prepare(
        "SELECT COALESCE(MAX(slot_order), 0) AS m FROM pipeline_slots WHERE strip_id = ? AND status = 'done'"
      ).get(Number(stripId)).m;
      const base = maxDone + 1;
      pendingOrderedIds.forEach((id, i) => {
        db.prepare(
          'UPDATE pipeline_slots SET slot_order = ? WHERE id = ? AND strip_id = ?'
        ).run(base + i, id, Number(stripId));
      });
    })();
  },

  moveToStrip(slotId, newStripId) {
    return db.transaction(() => {
      const slot = this.findById(slotId);
      if (!slot) return null;
      const newId = Number(newStripId);
      if (slot.strip_id === newId) return slot;

      const maxOrder = db.prepare(
        'SELECT COALESCE(MAX(slot_order), 0) AS m FROM pipeline_slots WHERE strip_id = ?'
      ).get(newId).m;

      db.prepare(
        'UPDATE pipeline_slots SET strip_id = ?, slot_order = ? WHERE id = ?'
      ).run(newId, maxOrder + 1, slotId);

      if (slot.pool_id) {
        db.prepare('UPDATE pools SET strip_id = ? WHERE id = ?').run(newId, slot.pool_id);
        const remaining = db.prepare(
          'SELECT COUNT(*) AS n FROM pipeline_slots WHERE strip_id = ? AND pool_id IS NOT NULL'
        ).get(slot.strip_id).n;
        if (remaining === 0) db.prepare("UPDATE strips SET status='idle' WHERE id=?").run(slot.strip_id);
        db.prepare("UPDATE strips SET status='assigned' WHERE id=?").run(newId);
      }

      return this.findById(slotId);
    })();
  },

  // ── Pipeline navigation (used by OPP2 client) ────────────────────────────

  activeSlot(stripId) {
    return stmtActiveSlot.get(stripId) || null;
  },

  markActive(slotId) {
    stmtMarkActive.run(slotId);
  },

  markDone(slotId) {
    stmtMarkDone.run(slotId);
    const slot = stmtSlotStripId.get(slotId);
    if (slot) {
      const active = stmtActiveCount.get(slot.strip_id).n;
      if (active === 0) stmtSetStripIdle.run(slot.strip_id);
    }
  },

  recoverStaleSlot(stripId) {
    const slots = stmtStaleDoneSlots.all(stripId);
    for (const slot of slots) {
      if (this.pendingBoutCount(slot) > 0) {
        stmtRecoverSlot.run(slot.id);
        return this.findById(slot.id);
      }
    }
    return null;
  },

  pendingBoutCount(slot) {
    if (slot.type === 'pool') {
      return stmtPendingPool.get({ pool_id: slot.pool_id, strip_id: slot.strip_id }).n;
    }
    if (slot.type === 'team_match') {
      if (!slot.team_match_id) return 0;
      return stmtPendingTeam.get(slot.team_match_id).n;
    }
    if (slot.bracket === 'placement') {
      const ids = DeLayout.placementGroupBoutIds(slot.phase_id, slot.tableau, Number(slot.partition));
      if (!ids.length) return 0;
      return db.prepare(`
        SELECT COUNT(*) AS n FROM bouts
        WHERE id IN (${ids.map(() => '?').join(',')})
          AND status != 'finished' AND left_id IS NOT NULL AND right_id IS NOT NULL
      `).get(...ids).n;
    }
    const { deRound, lo, hi, bracket } = this._deSlotParams(slot);
    if (!deRound) return 0;
    return db.prepare(`
      WITH ordered AS (${DE_BOUT_ORDER})
      SELECT COUNT(*) AS n FROM bouts b
      JOIN ordered o ON o.id = b.id
      WHERE b.phase_id=? AND b.de_round=?
        AND o.round_index BETWEEN ? AND ?
        AND b.status != 'finished'
        AND b.left_id IS NOT NULL AND b.right_id IS NOT NULL
    `).get(bracket, slot.phase_id, deRound, lo, hi).n;
  },

  nextBout(slot, afterBoutId = null) {
    if (slot.type === 'team_match') {
      const relay = db.prepare(`
        SELECT id, relay_number, target, status, left_touches, right_touches,
               left_position, right_position
        FROM relays
        WHERE team_match_id = ?
          AND status != 'finished'
          AND (? IS NULL OR relay_number > (SELECT relay_number FROM relays WHERE id = ?))
        ORDER BY relay_number LIMIT 1
      `).get(slot.team_match_id, afterBoutId, afterBoutId);

      const effective = relay || (afterBoutId
        ? db.prepare(`
            SELECT id, relay_number, target, status, left_touches, right_touches,
                   left_position, right_position
            FROM relays
            WHERE team_match_id = ? AND status != 'finished' AND id != ?
            ORDER BY relay_number LIMIT 1
          `).get(slot.team_match_id, afterBoutId)
        : null);

      return effective ? this._buildRelayBout(slot.team_match_id, effective) : null;
    }

    if (slot.type === 'pool') {
      const POOL_JOIN = `
        SELECT b.*, b.id AS bout_id,
          lc.first_name AS left_first,  lc.last_name  AS left_last,
          lc.nationality AS left_nation, lcl.name AS left_club, lcl.short_name AS left_club_abbr,
          rc.first_name AS right_first, rc.last_name  AS right_last,
          rc.nationality AS right_nation, rcl.name AS right_club, rcl.short_name AS right_club_abbr,
          ref_p.first_name AS ref_first, ref_p.last_name AS ref_last,
          po.pool_number,
          ph.phase_order,
          co.name AS competition_name, co.weapon
        FROM bouts b
        JOIN pools      po  ON po.id  = b.pool_id
        JOIN phases     ph  ON ph.id  = po.phase_id
        JOIN competitions co ON co.id = ph.competition_id
        LEFT JOIN competitors lc  ON lc.id  = b.left_id
        LEFT JOIN people      lpl ON lpl.id = lc.person_id
        LEFT JOIN clubs       lcl ON lcl.id = lpl.club_id
        LEFT JOIN competitors rc  ON rc.id  = b.right_id
        LEFT JOIN people      rpl ON rpl.id = rc.person_id
        LEFT JOIN clubs       rcl ON rcl.id = rpl.club_id
        LEFT JOIN pools       po2 ON po2.id = b.pool_id
        LEFT JOIN referees    ref ON ref.id  = po2.referee_id
        LEFT JOIN people      ref_p ON ref_p.id = ref.person_id
      `;

      // For multi-strip pools, filter by strip_id so each strip sees only its bouts.
      // strip_count > 1 means the pool was distributed; bouts.strip_id is set per bout.
      const pool = db.prepare('SELECT strip_count FROM pools WHERE id = ?').get(slot.pool_id);
      const stripFilter = (pool && pool.strip_count > 1)
        ? `AND b.strip_id = ${Number(slot.strip_id)}`
        : '';

      const forward = db.prepare(`${POOL_JOIN}
        WHERE b.pool_id = ?
          ${stripFilter}
          AND b.status != 'finished'
          AND (? IS NULL OR b.bout_order > (SELECT bout_order FROM bouts WHERE id = ?))
        ORDER BY b.bout_order LIMIT 1
      `).get(slot.pool_id, afterBoutId, afterBoutId);
      if (forward) return forward;

      if (!afterBoutId) return null;
      return db.prepare(`${POOL_JOIN}
        WHERE b.pool_id = ? ${stripFilter} AND b.status != 'finished' AND b.id != ?
        ORDER BY b.bout_order LIMIT 1
      `).get(slot.pool_id, afterBoutId) || null;
    }

    if (slot.bracket === 'placement') {
      const ids = DeLayout.placementGroupBoutIds(slot.phase_id, slot.tableau, Number(slot.partition));
      if (!ids.length) return null;
      const idList = ids.map(() => '?').join(',');
      const PLACEMENT_JOIN = `
        SELECT b.*, b.id AS bout_id,
          lc.first_name AS left_first,  lc.last_name  AS left_last,
          lc.nationality AS left_nation, lcl.name AS left_club, lcl.short_name AS left_club_abbr,
          rc.first_name AS right_first, rc.last_name  AS right_last,
          rc.nationality AS right_nation, rcl.name AS right_club, rcl.short_name AS right_club_abbr,
          ph.phase_order,
          co.name AS competition_name, co.weapon
        FROM bouts b
        JOIN phases     ph  ON ph.id  = b.phase_id
        JOIN competitions co ON co.id = ph.competition_id
        LEFT JOIN competitors lc  ON lc.id  = b.left_id
        LEFT JOIN people      lpl ON lpl.id = lc.person_id
        LEFT JOIN clubs       lcl ON lcl.id = lpl.club_id
        LEFT JOIN competitors rc  ON rc.id  = b.right_id
        LEFT JOIN people      rpl ON rpl.id = rc.person_id
        LEFT JOIN clubs       rcl ON rcl.id = rpl.club_id
      `;
      const forward = db.prepare(`${PLACEMENT_JOIN}
        WHERE b.id IN (${idList})
          AND b.status != 'finished'
          AND b.left_id IS NOT NULL AND b.right_id IS NOT NULL
          AND (? IS NULL OR b.bout_order > (SELECT bout_order FROM bouts WHERE id = ?))
        ORDER BY b.bout_order LIMIT 1
      `).get(...ids, afterBoutId, afterBoutId);
      const bout = forward || (afterBoutId ? db.prepare(`${PLACEMENT_JOIN}
        WHERE b.id IN (${idList}) AND b.status != 'finished'
          AND b.left_id IS NOT NULL AND b.right_id IS NOT NULL AND b.id != ?
        ORDER BY b.bout_order LIMIT 1
      `).get(...ids, afterBoutId) : null);
      return this._attachReferee(bout, slot);
    }

    const { deRound, lo, hi, bracket } = this._deSlotParams(slot);
    if (!deRound) return null;

    const bout = db.prepare(`
      WITH ordered AS (${DE_BOUT_ORDER})
      SELECT b.*, b.id AS bout_id, o.round_index,
        lc.first_name AS left_first,  lc.last_name  AS left_last,
        lc.nationality AS left_nation, lcl.name AS left_club, lcl.short_name AS left_club_abbr,
        rc.first_name AS right_first, rc.last_name  AS right_last,
        rc.nationality AS right_nation, rcl.name AS right_club, rcl.short_name AS right_club_abbr,
        ph.phase_order,
        co.name AS competition_name, co.weapon
      FROM bouts b
      JOIN ordered o ON o.id = b.id
      JOIN phases     ph  ON ph.id  = b.phase_id
      JOIN competitions co ON co.id = ph.competition_id
      LEFT JOIN competitors lc  ON lc.id  = b.left_id
      LEFT JOIN people      lpl ON lpl.id = lc.person_id
      LEFT JOIN clubs       lcl ON lcl.id = lpl.club_id
      LEFT JOIN competitors rc  ON rc.id  = b.right_id
      LEFT JOIN people      rpl ON rpl.id = rc.person_id
      LEFT JOIN clubs       rcl ON rcl.id = rpl.club_id
      WHERE b.phase_id = ? AND b.de_round = ?
        AND o.round_index BETWEEN ? AND ?
        AND b.status != 'finished'
        AND b.left_id IS NOT NULL AND b.right_id IS NOT NULL
        AND (? IS NULL OR o.round_index > (
              SELECT o2.round_index FROM ordered o2 WHERE o2.id = ?
            ))
      ORDER BY o.round_index
      LIMIT 1
    `).get(bracket, slot.phase_id, deRound, lo, hi, afterBoutId, afterBoutId);
    return this._attachReferee(bout, slot);
  },

  // Return the next `limit` pending bouts for a pool slot (for dynamic reorder lookahead).
  nextBoutsAhead(slot, afterBoutId, limit = 4) {
    if (slot.type !== 'pool') return [];
    const pool = db.prepare('SELECT strip_count FROM pools WHERE id = ?').get(slot.pool_id);
    const stripFilter = (pool && pool.strip_count > 1)
      ? `AND b.strip_id = ${Number(slot.strip_id)}`
      : '';
    const POOL_JOIN = `
      SELECT b.id, b.bout_order, b.left_id, b.right_id, b.pool_id, b.strip_id
      FROM bouts b
    `;
    return db.prepare(`${POOL_JOIN}
      WHERE b.pool_id = ?
        ${stripFilter}
        AND b.status != 'finished'
        AND (? IS NULL OR b.bout_order > (SELECT bout_order FROM bouts WHERE id = ?))
      ORDER BY b.bout_order LIMIT ?
    `).all(slot.pool_id, afterBoutId, afterBoutId, limit);
  },

  prevBout(slot, beforeBoutId) {
    if (!beforeBoutId) return null;

    if (slot.type === 'team_match') {
      const relay = db.prepare(`
        SELECT id, relay_number, target, status, left_touches, right_touches,
               left_position, right_position
        FROM relays
        WHERE team_match_id = ?
          AND relay_number < (SELECT relay_number FROM relays WHERE id = ?)
        ORDER BY relay_number DESC LIMIT 1
      `).get(slot.team_match_id, beforeBoutId);
      return relay ? this._buildRelayBout(slot.team_match_id, relay) : null;
    }

    if (slot.type === 'pool') {
      const POOL_JOIN = `
        SELECT b.*, b.id AS bout_id,
          lc.first_name AS left_first,  lc.last_name  AS left_last,
          lc.nationality AS left_nation, lcl.name AS left_club, lcl.short_name AS left_club_abbr,
          rc.first_name AS right_first, rc.last_name  AS right_last,
          rc.nationality AS right_nation, rcl.name AS right_club, rcl.short_name AS right_club_abbr,
          ref_p.first_name AS ref_first, ref_p.last_name AS ref_last,
          po.pool_number, ph.phase_order,
          co.name AS competition_name, co.weapon
        FROM bouts b
        JOIN pools      po  ON po.id  = b.pool_id
        JOIN phases     ph  ON ph.id  = po.phase_id
        JOIN competitions co ON co.id = ph.competition_id
        LEFT JOIN competitors lc  ON lc.id  = b.left_id
        LEFT JOIN people      lpl ON lpl.id = lc.person_id
        LEFT JOIN clubs       lcl ON lcl.id = lpl.club_id
        LEFT JOIN competitors rc  ON rc.id  = b.right_id
        LEFT JOIN people      rpl ON rpl.id = rc.person_id
        LEFT JOIN clubs       rcl ON rcl.id = rpl.club_id
        LEFT JOIN pools       po2 ON po2.id = b.pool_id
        LEFT JOIN referees    ref ON ref.id  = po2.referee_id
        LEFT JOIN people      ref_p ON ref_p.id = ref.person_id
      `;

      const pool2 = db.prepare('SELECT strip_count FROM pools WHERE id = ?').get(slot.pool_id);
      const stripFilter2 = (pool2 && pool2.strip_count > 1)
        ? `AND b.strip_id = ${Number(slot.strip_id)}`
        : '';
      return db.prepare(`${POOL_JOIN}
        WHERE b.pool_id = ?
          ${stripFilter2}
          AND b.bout_order < (SELECT bout_order FROM bouts WHERE id = ?)
        ORDER BY b.bout_order DESC LIMIT 1
      `).get(slot.pool_id, beforeBoutId) || null;
    }

    if (slot.bracket === 'placement') {
      const ids = DeLayout.placementGroupBoutIds(slot.phase_id, slot.tableau, Number(slot.partition));
      if (!ids.length) return null;
      const idList = ids.map(() => '?').join(',');
      const bout = db.prepare(`
        SELECT b.*, b.id AS bout_id,
          lc.first_name AS left_first,  lc.last_name  AS left_last,
          lc.nationality AS left_nation, lcl.name AS left_club, lcl.short_name AS left_club_abbr,
          rc.first_name AS right_first, rc.last_name  AS right_last,
          rc.nationality AS right_nation, rcl.name AS right_club, rcl.short_name AS right_club_abbr,
          ph.phase_order, co.name AS competition_name, co.weapon
        FROM bouts b
        JOIN phases ph ON ph.id = b.phase_id
        JOIN competitions co ON co.id = ph.competition_id
        LEFT JOIN competitors lc  ON lc.id  = b.left_id
        LEFT JOIN people      lpl ON lpl.id = lc.person_id
        LEFT JOIN clubs       lcl ON lcl.id = lpl.club_id
        LEFT JOIN competitors rc  ON rc.id  = b.right_id
        LEFT JOIN people      rpl ON rpl.id = rc.person_id
        LEFT JOIN clubs       rcl ON rcl.id = rpl.club_id
        WHERE b.id IN (${idList})
          AND b.left_id IS NOT NULL AND b.right_id IS NOT NULL
          AND b.bout_order < (SELECT bout_order FROM bouts WHERE id = ?)
        ORDER BY b.bout_order DESC LIMIT 1
      `).get(...ids, beforeBoutId);
      return this._attachReferee(bout, slot);
    }

    const { deRound, lo, hi, bracket } = this._deSlotParams(slot);
    if (!deRound) return null;

    const bout = db.prepare(`
      WITH ordered AS (${DE_BOUT_ORDER})
      SELECT b.*, b.id AS bout_id, o.round_index,
        lc.first_name AS left_first,  lc.last_name  AS left_last,
        lc.nationality AS left_nation, lcl.name AS left_club, lcl.short_name AS left_club_abbr,
        rc.first_name AS right_first, rc.last_name  AS right_last,
        rc.nationality AS right_nation, rcl.name AS right_club, rcl.short_name AS right_club_abbr,
        ph.phase_order, co.name AS competition_name, co.weapon
      FROM bouts b
      JOIN ordered o ON o.id = b.id
      JOIN phases ph ON ph.id = b.phase_id
      JOIN competitions co ON co.id = ph.competition_id
      LEFT JOIN competitors lc  ON lc.id  = b.left_id
      LEFT JOIN people      lpl ON lpl.id = lc.person_id
      LEFT JOIN clubs       lcl ON lcl.id = lpl.club_id
      LEFT JOIN competitors rc  ON rc.id  = b.right_id
      LEFT JOIN people      rpl ON rpl.id = rc.person_id
      LEFT JOIN clubs       rcl ON rcl.id = rpl.club_id
      WHERE b.phase_id = ? AND b.de_round = ?
        AND o.round_index BETWEEN ? AND ?
        AND b.left_id IS NOT NULL AND b.right_id IS NOT NULL
        AND o.round_index < (SELECT o2.round_index FROM ordered o2 WHERE o2.id = ?)
      ORDER BY o.round_index DESC
      LIMIT 1
    `).get(bracket, slot.phase_id, deRound, lo, hi, beforeBoutId);
    return this._attachReferee(bout, slot);
  },

  // ── Internal helpers ─────────────────────────────────────────────────────

  // Public alias used by opp2Composer to build bout queries from a DE slot.
  resolveDeSlot(slot) { return this._deSlotParams(slot); },

  // Attach referee name fields to a bout result using slot.referee_id.
  _attachReferee(bout, slot) {
    if (!bout || !slot.referee_id) return bout;
    const ref = stmtRefereeName.get(slot.referee_id);
    if (ref) { bout.ref_first = ref.ref_first; bout.ref_last = ref.ref_last; bout.ref_nation = ref.ref_nation; }
    return bout;
  },

  // Resolve a DE slot's bracket parameters into the values the SQL queries need.
  // Slots created since migration 026 carry an explicit de_round (set by
  // de.html/opp2.html from deLayout's stripSlot) so no guessing is needed —
  // this is what lets repechage/Finals rounds be told apart even though a
  // repechage phase's last main round and first Finals round always share
  // the same `tableau` value. Older slots (pre-026, main bracket only) fall
  // back to the previous tableau-based inference.
  _deSlotParams(slot) {
    const bracket = slot.bracket || 'main';
    if (slot.de_round != null) {
      const [lo, hi] = partitionToRange(slot.partition, slot.tableau);
      return { deRound: slot.de_round, lo, hi, bracket };
    }
    const deRound = tableauToDeRound(slot.phase_id, slot.tableau);
    const [lo, hi] = partitionToRange(slot.partition, slot.tableau);
    return { deRound, lo, hi, bracket };
  },

  // Fill in bout_count for DE slots (needed for predicted-end computation).
  _fillDeBoutCount(slot) {
    if (slot.type !== 'de' || slot.bout_count != null) return slot;
    if (slot.bracket === 'placement') {
      const ids = DeLayout.placementGroupBoutIds(slot.phase_id, slot.tableau, Number(slot.partition));
      return { ...slot, bout_count: ids.length };
    }
    if (!slot.tableau) return slot;
    const [lo, hi] = partitionToRange(slot.partition, slot.tableau);
    return { ...slot, bout_count: hi - lo + 1 };
  },

  // Build slot.officials from the findByStrip join columns: one entry per
  // assigned role, including the primary referee, for a single flat list
  // frontends can iterate instead of five separate fields.
  _attachOfficials(slot) {
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
  },

  // ── Team match relay helpers ─────────────────────────────────────────────

  // Resolve which competitor fences at a given position for a given relay.
  _resolveRelayFencer(matchId, position, relayNumber) {
    if (!position) return null;
    const row = db.prepare(`
      SELECT COALESCE(sub.substitute_competitor_id, ord.competitor_id) AS competitor_id
      FROM team_match_orders ord
      LEFT JOIN team_match_substitutions sub
        ON sub.team_match_id = ord.team_match_id
        AND sub.team_id = ord.team_id
        AND sub.position_replaced = ord.position
        AND sub.effective_from_relay <= ?
      WHERE ord.team_match_id = ? AND ord.position = ?
    `).get(relayNumber, matchId, position);
    if (!row?.competitor_id) return null;
    return db.prepare(`
      SELECT c.id AS competitor_id, p.first_name, p.last_name, p.nationality
      FROM competitors c
      JOIN fencers f ON f.id = c.fencer_id
      JOIN people p  ON p.id = f.person_id
      WHERE c.id = ?
    `).get(row.competitor_id);
  },

  // Build the full relay bout object returned by nextBout / prevBout for team_match slots.
  _buildRelayBout(matchId, relay) {
    const match = db.prepare(`
      SELECT tm.id, tm.left_team_id, tm.right_team_id, tm.phase_id,
             tl.name AS left_team_name, tr.name AS right_team_name,
             ph.phase_order,
             co.name AS competition_name, co.weapon
      FROM team_matches tm
      LEFT JOIN teams tl ON tl.id = tm.left_team_id
      LEFT JOIN teams tr ON tr.id = tm.right_team_id
      JOIN phases ph       ON ph.id = tm.phase_id
      JOIN competitions co ON co.id = ph.competition_id
      WHERE tm.id = ?
    `).get(matchId);
    if (!match) return null;

    // left_position/right_position may be null for relays created before migration 017.
    // Fall back to the rule definition (indexed by relay_number) when not stored on the row.
    let leftPos  = relay.left_position;
    let rightPos = relay.right_position;
    if (leftPos == null || rightPos == null) {
      const phaseRow = db.prepare('SELECT rule_doc FROM phases WHERE id = ?').get(match.phase_id);
      const rule     = require('../lib/rules').loadRule(phaseRow.rule_doc);
      const def      = rule.relays?.[relay.relay_number - 1];
      if (def) { leftPos = def.left; rightPos = def.right; }
    }

    const leftFencer  = this._resolveRelayFencer(matchId, leftPos,  relay.relay_number);
    const rightFencer = this._resolveRelayFencer(matchId, rightPos, relay.relay_number);

    const cumul = db.prepare(`
      SELECT COALESCE(SUM(left_touches),  0) AS cum_left,
             COALESCE(SUM(right_touches), 0) AS cum_right
      FROM relays
      WHERE team_match_id = ? AND relay_number < ? AND status = 'finished'
    `).get(matchId, relay.relay_number);

    const relayTotal = db.prepare(
      'SELECT COUNT(*) AS n FROM relays WHERE team_match_id = ?'
    ).get(matchId).n;

    return {
      id:              relay.id,
      relay_number:    relay.relay_number,
      relay_total:     relayTotal,
      target:          relay.target,
      status:          relay.status,
      left_touches:    relay.left_touches,
      right_touches:   relay.right_touches,
      left_position:   leftPos,
      right_position:  rightPos,
      left_id:         leftFencer?.competitor_id  ?? null,
      left_first:      leftFencer?.first_name     ?? '',
      left_last:       leftFencer?.last_name      ?? '',
      left_nation:     leftFencer?.nationality    ?? '',
      right_id:        rightFencer?.competitor_id ?? null,
      right_first:     rightFencer?.first_name    ?? '',
      right_last:      rightFencer?.last_name     ?? '',
      right_nation:    rightFencer?.nationality   ?? '',
      team_match_id:   matchId,
      left_team_id:    match.left_team_id,
      left_team_name:  match.left_team_name,
      right_team_id:   match.right_team_id,
      right_team_name: match.right_team_name,
      cumul_left:      cumul.cum_left,
      cumul_right:     cumul.cum_right,
      weapon:          match.weapon,
      competition_name: match.competition_name,
      phase_order:     match.phase_order,
    };
  },

  // ── Competitor rosters per slot (kiosk displays) ─────────────────────────

  // Resolve which competitors currently belong to a pipeline slot: the whole
  // pool for a pool slot, both teams' rosters for a team_match slot, or every
  // fencer appearing in the DE bouts the slot's round-range/placement group
  // currently covers (byes and not-yet-decided pairings naturally drop out
  // since their opposing left_id/right_id is still null).
  competitorsForSlot(slot) {
    if (slot.type === 'pool') {
      return db.prepare(`
        SELECT c.id AS competitor_id, c.first_name, c.last_name, c.nationality,
               cl.name AS club_name
        FROM pool_competitors pc
        JOIN competitors c  ON c.id  = pc.competitor_id
        LEFT JOIN people p2 ON p2.id = c.person_id
        LEFT JOIN clubs  cl ON cl.id = p2.club_id
        WHERE pc.pool_id = ?
        ORDER BY c.initial_seed ASC, c.last_name
      `).all(slot.pool_id);
    }

    if (slot.type === 'team_match') {
      const teamMembers = (teamId, side) => teamId ? db.prepare(`
        SELECT c.id AS competitor_id, c.first_name, c.last_name, c.nationality,
               cl.name AS club_name, ? AS team_side
        FROM team_members tmm
        JOIN competitors c  ON c.id  = tmm.competitor_id
        LEFT JOIN people p2 ON p2.id = c.person_id
        LEFT JOIN clubs  cl ON cl.id = p2.club_id
        WHERE tmm.team_id = ?
      `).all(side, teamId) : [];
      return [...teamMembers(slot.left_team_id, 'left'), ...teamMembers(slot.right_team_id, 'right')];
    }

    // DE (main/repechage/placement)
    let boutRows;
    if (slot.bracket === 'placement') {
      const ids = DeLayout.placementGroupBoutIds(slot.phase_id, slot.tableau, Number(slot.partition));
      if (!ids.length) return [];
      boutRows = db.prepare(
        `SELECT left_id, right_id FROM bouts WHERE id IN (${ids.map(() => '?').join(',')})`
      ).all(...ids);
    } else {
      const { deRound, lo, hi, bracket } = this._deSlotParams(slot);
      if (!deRound) return [];
      boutRows = db.prepare(`
        WITH ordered AS (${DE_BOUT_ORDER})
        SELECT b.left_id, b.right_id FROM bouts b
        JOIN ordered o ON o.id = b.id
        WHERE b.phase_id = ? AND b.de_round = ? AND o.round_index BETWEEN ? AND ?
      `).all(bracket, slot.phase_id, deRound, lo, hi);
    }

    const ids = [...new Set(boutRows.flatMap(b => [b.left_id, b.right_id]).filter(Boolean))];
    if (!ids.length) return [];
    return db.prepare(`
      SELECT c.id AS competitor_id, c.first_name, c.last_name, c.nationality,
             cl.name AS club_name
      FROM competitors c
      LEFT JOIN people p2 ON p2.id = c.person_id
      LEFT JOIN clubs  cl ON cl.id = p2.club_id
      WHERE c.id IN (${ids.map(() => '?').join(',')})
    `).all(...ids);
  },

  // Every competitor in a competition, each with its currently relevant
  // pipeline assignment (or null if not currently in any non-done slot).
  // Used by the fencer kiosk display. When a competitor matches more than
  // one live slot (e.g. a pool slot and an already-built next-phase DE slot
  // both exist), the active one wins, else the one starting soonest.
  fencersForCompetition(compId) {
    compId = Number(compId);
    const roster = db.prepare(`
      SELECT c.id AS competitor_id, c.first_name, c.last_name, c.nationality,
             cl.name AS club_name
      FROM competitors c
      LEFT JOIN people p2 ON p2.id = c.person_id
      LEFT JOIN clubs  cl ON cl.id = p2.club_id
      WHERE c.competition_id = ?
      ORDER BY c.initial_seed ASC, c.last_name, c.first_name
    `).all(compId);

    const candidatesByCompetitor = new Map();
    for (const strip of this.findAllStrips()) {
      for (const slot of strip.slots) {
        if (slot.competition_id !== compId || slot.status === 'done') continue;
        const info = {
          strip_id: strip.id, strip_name: strip.name, strip_number: strip.strip_number,
          scheduled_start: slot.scheduled_start, predicted_end: slot.predicted_end,
          status: slot.status, slot_type: slot.type, pool_number: slot.pool_number,
          bracket: slot.bracket, tableau: slot.tableau, partition: slot.partition,
          left_team_name: slot.left_team_name, right_team_name: slot.right_team_name,
        };
        for (const c of this.competitorsForSlot(slot)) {
          const list = candidatesByCompetitor.get(c.competitor_id) || [];
          list.push(info);
          candidatesByCompetitor.set(c.competitor_id, list);
        }
      }
    }

    const pick = (list) => {
      if (!list || !list.length) return null;
      return list.slice().sort((a, b) => {
        const rank = s => s === 'active' ? 0 : 1;
        if (rank(a.status) !== rank(b.status)) return rank(a.status) - rank(b.status);
        return (a.scheduled_start || '99:99').localeCompare(b.scheduled_start || '99:99');
      })[0];
    };

    return roster.map(r => ({ ...r, assignment: pick(candidatesByCompetitor.get(r.competitor_id)) }));
  },

  // ── Predicted end helper ─────────────────────────────────────────────────

  _withPredictedEnd(slot) {
    if (!slot.scheduled_start || !slot.effective_minutes_per_bout || !slot.bout_count) {
      return { ...slot, predicted_end: null };
    }
    const [h, m] = slot.scheduled_start.split(':').map(Number);
    const totalMin = h * 60 + m + slot.bout_count * slot.effective_minutes_per_bout;
    const ph = Math.floor(totalMin / 60) % 24;
    const pm = totalMin % 60;
    return { ...slot, predicted_end: `${String(ph).padStart(2,'0')}:${String(pm).padStart(2,'0')}` };
  },
};

module.exports = Pipeline;
