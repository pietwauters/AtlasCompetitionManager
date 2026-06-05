'use strict';
const db = require('../db');

// Bouts in a DE round ordered by tableau position.
// round_index is 1-based within the round, matching partition ranges.
const DE_BOUT_ORDER = `
  SELECT b.id, b.tableau_position, b.status, b.left_id, b.right_id,
         b.left_score, b.right_score, b.winner_id, b.de_round,
         ROW_NUMBER() OVER (PARTITION BY b.phase_id, b.de_round
                            ORDER BY b.tableau_position) AS round_index
  FROM bouts b
  WHERE b.de_round IS NOT NULL
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

const Pipeline = {

  // ── Queries ───────────────────────────────────────────────────────────────

  findById(id) {
    return db.prepare('SELECT * FROM pipeline_slots WHERE id = ?').get(id);
  },

  findByPool(poolId) {
    return db.prepare('SELECT * FROM pipeline_slots WHERE pool_id = ?').get(poolId) || null;
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
        po.pool_number,
        rp.first_name AS ref_first, rp.last_name AS ref_last,
        CASE WHEN ps.type = 'pool'
          THEN (SELECT COUNT(*) FROM bouts b WHERE b.pool_id = ps.pool_id)
          ELSE NULL  -- computed in JS for DE slots (depends on partition)
        END AS bout_count,
        COALESCE(ps.minutes_per_bout,
          (SELECT ds.minutes_per_bout FROM bout_duration_standards ds
           WHERE ds.weapon = co.weapon
             AND ds.phase_type = CASE WHEN ps.type='pool' THEN 'pool' ELSE 'de' END)
        ) AS effective_minutes_per_bout
      FROM pipeline_slots ps
      LEFT JOIN pools        po ON po.id  = ps.pool_id
      LEFT JOIN phases       ph ON ph.id  = COALESCE(ps.phase_id, po.phase_id)
      LEFT JOIN competitions co ON co.id  = ph.competition_id
      LEFT JOIN referees     r  ON r.id   = ps.referee_id
      LEFT JOIN people       rp ON rp.id  = r.person_id
      WHERE ps.strip_id = ?
      ORDER BY ps.slot_order
    `).all(stripId);

    return slots.map(s => this._withPredictedEnd(this._fillDeBoutCount(s)));
  },

  findAllForReferee(refereeId) {
    const slots = db.prepare(`
      SELECT ps.*, st.name AS strip_name, st.strip_number,
        po.pool_number,
        ph.type AS phase_type, ph.phase_order,
        co.name AS competition_name, co.weapon,
        CASE WHEN ps.type = 'pool'
          THEN (SELECT COUNT(*) FROM bouts b WHERE b.pool_id = ps.pool_id)
          ELSE NULL
        END AS bout_count,
        COALESCE(ps.minutes_per_bout,
          (SELECT ds.minutes_per_bout FROM bout_duration_standards ds
           WHERE ds.weapon = co.weapon
             AND ds.phase_type = CASE WHEN ps.type='pool' THEN 'pool' ELSE 'de' END)
        ) AS effective_minutes_per_bout
      FROM pipeline_slots ps
      JOIN strips        st ON st.id = ps.strip_id
      LEFT JOIN pools    po ON po.id = ps.pool_id
      LEFT JOIN phases   ph ON ph.id = COALESCE(ps.phase_id, po.phase_id)
      LEFT JOIN competitions co ON co.id = ph.competition_id
      WHERE ps.referee_id = ?
      ORDER BY ps.strip_id, ps.slot_order
    `).all(refereeId);

    return slots.map(s => this._withPredictedEnd(this._fillDeBoutCount(s)));
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
    return db.transaction(() => {
      // A pool may only live in one pipeline slot.
      if (data.pool_id) {
        const existing = db.prepare('SELECT * FROM pipeline_slots WHERE pool_id = ?').get(data.pool_id);
        if (existing) {
          if (existing.strip_id !== Number(stripId)) {
            db.prepare('DELETE FROM pipeline_slots WHERE id = ?').run(existing.id);
            const oldHasMore = db.prepare(
              'SELECT COUNT(*) AS n FROM pipeline_slots WHERE strip_id = ? AND pool_id IS NOT NULL'
            ).get(existing.strip_id).n;
            if (oldHasMore === 0) db.prepare("UPDATE strips SET status='idle' WHERE id=?").run(existing.strip_id);
          } else {
            db.prepare("UPDATE pipeline_slots SET status='pending' WHERE id=?").run(existing.id);
            db.prepare("UPDATE strips SET status='assigned' WHERE id=?").run(Number(stripId));
            db.prepare('UPDATE pools SET strip_id = ? WHERE id = ?').run(Number(stripId), data.pool_id);
            return this.findById(existing.id);
          }
        }
      }

      const maxOrder = db.prepare(
        'SELECT COALESCE(MAX(slot_order), 0) AS m FROM pipeline_slots WHERE strip_id = ?'
      ).get(stripId).m;

      const { lastInsertRowid } = db.prepare(`
        INSERT INTO pipeline_slots
          (strip_id, slot_order, type, pool_id, phase_id,
           bracket, tableau, partition,
           scheduled_start, minutes_per_bout, referee_id)
        VALUES
          (@strip_id, @slot_order, @type, @pool_id, @phase_id,
           @bracket, @tableau, @partition,
           @scheduled_start, @minutes_per_bout, @referee_id)
      `).run({
        strip_id:         Number(stripId),
        slot_order:       maxOrder + 1,
        type:             data.type,
        pool_id:          data.pool_id          ?? null,
        phase_id:         data.phase_id         ?? null,
        bracket:          data.bracket          ?? null,
        tableau:          data.tableau          ?? null,
        partition:        data.partition        ?? 'full',
        scheduled_start:  data.scheduled_start  ?? null,
        minutes_per_bout: data.minutes_per_bout ?? null,
        referee_id:       data.referee_id       ?? null,
      });

      if (data.pool_id) {
        db.prepare('UPDATE pools SET strip_id = ? WHERE id = ?').run(Number(stripId), data.pool_id);
        db.prepare("UPDATE strips SET status='assigned' WHERE id=?").run(Number(stripId));
      }

      return this.findById(lastInsertRowid);
    })();
  },

  updateSlot(id, data) {
    const current = this.findById(id);
    if (!current) return null;
    const m = { ...current, ...data };
    db.prepare(`
      UPDATE pipeline_slots
      SET scheduled_start  = @scheduled_start,
          minutes_per_bout = @minutes_per_bout,
          referee_id       = @referee_id,
          status           = @status
      WHERE id = @id
    `).run({
      id: Number(id),
      scheduled_start:  m.scheduled_start  ?? null,
      minutes_per_bout: m.minutes_per_bout ?? null,
      referee_id:       m.referee_id       ?? null,
      status:           m.status,
    });
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
      db.prepare('UPDATE pipeline_slots SET slot_order = ? WHERE id = ?')
        .run(sibling.slot_order, slot.id);
      db.prepare('UPDATE pipeline_slots SET slot_order = ? WHERE id = ?')
        .run(slot.slot_order, sibling.id);
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

  // ── Pipeline navigation (used by OPP2 client) ────────────────────────────

  activeSlot(stripId) {
    return db.prepare(`
      SELECT * FROM pipeline_slots
      WHERE strip_id = ?
        AND status IN ('active', 'pending')
      ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, slot_order
      LIMIT 1
    `).get(stripId) || null;
  },

  markActive(slotId) {
    db.prepare("UPDATE pipeline_slots SET status='active' WHERE id=?").run(slotId);
  },

  markDone(slotId) {
    db.prepare("UPDATE pipeline_slots SET status='done' WHERE id=?").run(slotId);
    const slot = db.prepare('SELECT strip_id FROM pipeline_slots WHERE id=?').get(slotId);
    if (slot) {
      const active = db.prepare(
        "SELECT COUNT(*) AS n FROM pipeline_slots WHERE strip_id=? AND status IN ('pending','active')"
      ).get(slot.strip_id).n;
      if (active === 0) db.prepare("UPDATE strips SET status='idle' WHERE id=?").run(slot.strip_id);
    }
  },

  recoverStaleSlot(stripId) {
    const slots = db.prepare(
      "SELECT * FROM pipeline_slots WHERE strip_id = ? AND status = 'done' ORDER BY slot_order"
    ).all(stripId);
    for (const slot of slots) {
      if (this.pendingBoutCount(slot) > 0) {
        db.prepare("UPDATE pipeline_slots SET status='pending' WHERE id=?").run(slot.id);
        return this.findById(slot.id);
      }
    }
    return null;
  },

  pendingBoutCount(slot) {
    if (slot.type === 'pool') {
      return db.prepare(
        "SELECT COUNT(*) AS n FROM bouts WHERE pool_id=? AND status!='finished'"
      ).get(slot.pool_id).n;
    }
    const { deRound, lo, hi } = this._deSlotParams(slot);
    if (!deRound) return 0;
    return db.prepare(`
      WITH ordered AS (${DE_BOUT_ORDER})
      SELECT COUNT(*) AS n FROM bouts b
      JOIN ordered o ON o.id = b.id
      WHERE b.phase_id=? AND b.de_round=?
        AND o.round_index BETWEEN ? AND ?
        AND b.status != 'finished'
    `).get(slot.phase_id, deRound, lo, hi).n;
  },

  nextBout(slot, afterBoutId = null) {
    if (slot.type === 'pool') {
      const POOL_JOIN = `
        SELECT b.*, b.id AS bout_id,
          lp.first_name AS left_first,  lp.last_name  AS left_last,
          lp.nationality AS left_nation, lcl.name AS left_club, lcl.short_name AS left_club_abbr,
          rp.first_name AS right_first, rp.last_name  AS right_last,
          rp.nationality AS right_nation, rcl.name AS right_club, rcl.short_name AS right_club_abbr,
          ref_p.first_name AS ref_first, ref_p.last_name AS ref_last, ref_p.nationality AS ref_nation,
          po.pool_number,
          ph.phase_order,
          co.name AS competition_name, co.weapon
        FROM bouts b
        JOIN pools      po  ON po.id  = b.pool_id
        JOIN phases     ph  ON ph.id  = po.phase_id
        JOIN competitions co ON co.id = ph.competition_id
        LEFT JOIN competitors lc  ON lc.id  = b.left_id
        LEFT JOIN fencers     lf  ON lf.id  = lc.fencer_id
        LEFT JOIN people      lp  ON lp.id  = lf.person_id
        LEFT JOIN clubs       lcl ON lcl.id = lp.club_id
        LEFT JOIN competitors rc  ON rc.id  = b.right_id
        LEFT JOIN fencers     rf  ON rf.id  = rc.fencer_id
        LEFT JOIN people      rp  ON rp.id  = rf.person_id
        LEFT JOIN clubs       rcl ON rcl.id = rp.club_id
        LEFT JOIN pools       po2 ON po2.id = b.pool_id
        LEFT JOIN referees    ref ON ref.id  = po2.referee_id
        LEFT JOIN people      ref_p ON ref_p.id = ref.person_id
      `;

      const forward = db.prepare(`${POOL_JOIN}
        WHERE b.pool_id = ?
          AND b.status != 'finished'
          AND (? IS NULL OR b.bout_order > (SELECT bout_order FROM bouts WHERE id = ?))
        ORDER BY b.bout_order LIMIT 1
      `).get(slot.pool_id, afterBoutId, afterBoutId);
      if (forward) return forward;

      if (!afterBoutId) return null;
      return db.prepare(`${POOL_JOIN}
        WHERE b.pool_id = ? AND b.status != 'finished' AND b.id != ?
        ORDER BY b.bout_order LIMIT 1
      `).get(slot.pool_id, afterBoutId) || null;
    }

    const { deRound, lo, hi } = this._deSlotParams(slot);
    if (!deRound) return null;

    return db.prepare(`
      WITH ordered AS (${DE_BOUT_ORDER})
      SELECT b.*, b.id AS bout_id, o.round_index,
        lp.first_name AS left_first,  lp.last_name  AS left_last,
        lp.nationality AS left_nation, lcl.name AS left_club, lcl.short_name AS left_club_abbr,
        rp.first_name AS right_first, rp.last_name  AS right_last,
        rp.nationality AS right_nation, rcl.name AS right_club, rcl.short_name AS right_club_abbr,
        ref_p.first_name AS ref_first, ref_p.last_name AS ref_last, ref_p.nationality AS ref_nation,
        ph.phase_order,
        co.name AS competition_name, co.weapon
      FROM bouts b
      JOIN ordered o ON o.id = b.id
      JOIN phases     ph  ON ph.id  = b.phase_id
      JOIN competitions co ON co.id = ph.competition_id
      LEFT JOIN competitors lc  ON lc.id  = b.left_id
      LEFT JOIN fencers     lf  ON lf.id  = lc.fencer_id
      LEFT JOIN people      lp  ON lp.id  = lf.person_id
      LEFT JOIN clubs       lcl ON lcl.id = lp.club_id
      LEFT JOIN competitors rc  ON rc.id  = b.right_id
      LEFT JOIN fencers     rf  ON rf.id  = rc.fencer_id
      LEFT JOIN people      rp  ON rp.id  = rf.person_id
      LEFT JOIN clubs       rcl ON rcl.id = rp.club_id
      LEFT JOIN phases      ph2 ON ph2.id = b.phase_id
      LEFT JOIN referees    ref ON ref.id  = ph2.competition_id  -- placeholder; DE ref TBD
      LEFT JOIN people      ref_p ON ref_p.id = ref.person_id
      WHERE b.phase_id = ? AND b.de_round = ?
        AND o.round_index BETWEEN ? AND ?
        AND b.status != 'finished'
        AND (? IS NULL OR o.round_index > (
              SELECT o2.round_index FROM ordered o2 WHERE o2.id = ?
            ))
      ORDER BY o.round_index
      LIMIT 1
    `).get(slot.phase_id, deRound, lo, hi, afterBoutId, afterBoutId);
  },

  prevBout(slot, beforeBoutId) {
    if (!beforeBoutId) return null;
    if (slot.type === 'pool') {
      const POOL_JOIN = `
        SELECT b.*, b.id AS bout_id,
          lp.first_name AS left_first,  lp.last_name  AS left_last,
          lp.nationality AS left_nation, lcl.name AS left_club, lcl.short_name AS left_club_abbr,
          rp.first_name AS right_first, rp.last_name  AS right_last,
          rp.nationality AS right_nation, rcl.name AS right_club, rcl.short_name AS right_club_abbr,
          ref_p.first_name AS ref_first, ref_p.last_name AS ref_last, ref_p.nationality AS ref_nation,
          po.pool_number, ph.phase_order,
          co.name AS competition_name, co.weapon
        FROM bouts b
        JOIN pools      po  ON po.id  = b.pool_id
        JOIN phases     ph  ON ph.id  = po.phase_id
        JOIN competitions co ON co.id = ph.competition_id
        LEFT JOIN competitors lc  ON lc.id  = b.left_id
        LEFT JOIN fencers     lf  ON lf.id  = lc.fencer_id
        LEFT JOIN people      lp  ON lp.id  = lf.person_id
        LEFT JOIN clubs       lcl ON lcl.id = lp.club_id
        LEFT JOIN competitors rc  ON rc.id  = b.right_id
        LEFT JOIN fencers     rf  ON rf.id  = rc.fencer_id
        LEFT JOIN people      rp  ON rp.id  = rf.person_id
        LEFT JOIN clubs       rcl ON rcl.id = rp.club_id
        LEFT JOIN pools       po2 ON po2.id = b.pool_id
        LEFT JOIN referees    ref ON ref.id  = po2.referee_id
        LEFT JOIN people      ref_p ON ref_p.id = ref.person_id
      `;

      return db.prepare(`${POOL_JOIN}
        WHERE b.pool_id = ?
          AND b.bout_order < (SELECT bout_order FROM bouts WHERE id = ?)
        ORDER BY b.bout_order DESC LIMIT 1
      `).get(slot.pool_id, beforeBoutId) || null;
    }

    const { deRound, lo, hi } = this._deSlotParams(slot);
    if (!deRound) return null;

    return db.prepare(`
      WITH ordered AS (${DE_BOUT_ORDER})
      SELECT b.*, b.id AS bout_id, o.round_index,
        lp.first_name AS left_first,  lp.last_name  AS left_last,
        lp.nationality AS left_nation, lcl.name AS left_club, lcl.short_name AS left_club_abbr,
        rp.first_name AS right_first, rp.last_name  AS right_last,
        rp.nationality AS right_nation, rcl.name AS right_club, rcl.short_name AS right_club_abbr,
        ph.phase_order, co.name AS competition_name, co.weapon
      FROM bouts b
      JOIN ordered o ON o.id = b.id
      JOIN phases ph ON ph.id = b.phase_id
      JOIN competitions co ON co.id = ph.competition_id
      LEFT JOIN competitors lc  ON lc.id  = b.left_id
      LEFT JOIN fencers     lf  ON lf.id  = lc.fencer_id
      LEFT JOIN people      lp  ON lp.id  = lf.person_id
      LEFT JOIN clubs       lcl ON lcl.id = lp.club_id
      LEFT JOIN competitors rc  ON rc.id  = b.right_id
      LEFT JOIN fencers     rf  ON rf.id  = rc.fencer_id
      LEFT JOIN people      rp  ON rp.id  = rf.person_id
      LEFT JOIN clubs       rcl ON rcl.id = rp.club_id
      WHERE b.phase_id = ? AND b.de_round = ?
        AND o.round_index BETWEEN ? AND ?
        AND o.round_index < (SELECT o2.round_index FROM ordered o2 WHERE o2.id = ?)
      ORDER BY o.round_index DESC
      LIMIT 1
    `).get(slot.phase_id, deRound, lo, hi, beforeBoutId);
  },

  // ── Internal helpers ─────────────────────────────────────────────────────

  // Resolve a DE slot's bracket parameters into the values the SQL queries need.
  _deSlotParams(slot) {
    const deRound = tableauToDeRound(slot.phase_id, slot.tableau);
    const [lo, hi] = partitionToRange(slot.partition, slot.tableau);
    return { deRound, lo, hi };
  },

  // Fill in bout_count for DE slots (needed for predicted-end computation).
  _fillDeBoutCount(slot) {
    if (slot.type !== 'de' || slot.bout_count != null || !slot.tableau) return slot;
    const [lo, hi] = partitionToRange(slot.partition, slot.tableau);
    return { ...slot, bout_count: hi - lo + 1 };
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
