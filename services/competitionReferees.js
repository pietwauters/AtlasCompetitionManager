'use strict';
const db          = require('../db');
const Competition = require('./competitions');
const { compareByLevel } = require('../lib/refereeLevel');

const stmtInsert  = db.prepare('INSERT OR IGNORE INTO competition_referees (competition_id, referee_id) VALUES (?, ?)');
const stmtDelete  = db.prepare('DELETE FROM competition_referees WHERE competition_id = ? AND referee_id = ?');
const stmtSetRank = db.prepare('UPDATE competition_referees SET rank_order = ? WHERE competition_id = ? AND referee_id = ?');

const stmtCheckIn     = db.prepare('INSERT OR IGNORE INTO referee_checkins (competition_id, referee_id) VALUES (?, ?)');
const stmtCheckOut    = db.prepare('DELETE FROM referee_checkins WHERE competition_id = ? AND referee_id = ?');
const stmtCheckOutAll = db.prepare('DELETE FROM referee_checkins WHERE competition_id = ?');

// Effective roster for a competition: referees added directly to it, UNION
// referees on its tournament's roster (if it belongs to one — tr.tournament_id
// = NULL never matches, so this degrades correctly for a tournament-less
// competition without needing a sentinel value). rank_order prefers the
// competition-level value when set, else falls back to the tournament-level
// one — a referee ranked only at the tournament level still shows an
// effective position on the competition page.
const stmtFindEffective = db.prepare(`
  SELECT r.id AS referee_id, r.level, p.id AS person_id, p.first_name, p.last_name,
         p.nationality, p.club_id, c.name AS club_name,
         MAX(CASE WHEN cr.referee_id IS NOT NULL THEN 1 ELSE 0 END) AS via_competition,
         MAX(CASE WHEN tr.referee_id IS NOT NULL THEN 1 ELSE 0 END) AS via_tournament,
         COALESCE(MAX(cr.rank_order), MAX(tr.rank_order)) AS rank_order,
         MAX(CASE WHEN rc.referee_id IS NOT NULL THEN 1 ELSE 0 END) AS checked_in
  FROM referees r
  JOIN people p ON p.id = r.person_id
  LEFT JOIN clubs c ON c.id = p.club_id
  LEFT JOIN competition_referees cr ON cr.referee_id = r.id AND cr.competition_id = @competition_id
  LEFT JOIN tournament_referees  tr ON tr.referee_id = r.id AND tr.tournament_id = @tournament_id
  LEFT JOIN referee_checkins     rc ON rc.referee_id = r.id AND rc.competition_id = @competition_id
  WHERE cr.referee_id IS NOT NULL OR tr.referee_id IS NOT NULL
  GROUP BY r.id
  ORDER BY CASE WHEN COALESCE(MAX(cr.rank_order), MAX(tr.rank_order)) IS NULL THEN 1 ELSE 0 END,
           COALESCE(MAX(cr.rank_order), MAX(tr.rank_order)), p.last_name, p.first_name
`);
const stmtFindEligible = db.prepare(`
  SELECT r.id AS referee_id, r.level, p.id AS person_id, p.first_name, p.last_name,
         p.nationality, p.club_id, c.name AS club_name,
         CASE WHEN cr.referee_id IS NOT NULL OR tr.referee_id IS NOT NULL THEN 1 ELSE 0 END AS is_registered
  FROM referees r
  JOIN people p ON p.id = r.person_id
  LEFT JOIN clubs c ON c.id = p.club_id
  LEFT JOIN competition_referees cr ON cr.referee_id = r.id AND cr.competition_id = @competition_id
  LEFT JOIN tournament_referees  tr ON tr.referee_id = r.id AND tr.tournament_id = @tournament_id
  ORDER BY p.last_name, p.first_name
`);

const CompetitionReferee = {
  // Effective roster: this competition's own referees plus its tournament's
  // roster (if any), each tagged `via`: 'competition' | 'tournament' | 'both'.
  // Only 'competition'/'both' rows are removable from this competition's own
  // list — a 'tournament'-only row can only be removed from the tournament
  // roster page.
  findAll(competitionId) {
    const comp = Competition.findById(competitionId);
    if (!comp) return [];
    return stmtFindEffective
      .all({ competition_id: Number(competitionId), tournament_id: comp.tournament_id ?? null })
      .map(r => ({
        ...r,
        via: r.via_competition && r.via_tournament ? 'both' : (r.via_competition ? 'competition' : 'tournament'),
      }));
  },

  // Every referee in the DB, flagged is_registered against the effective roster.
  findEligible(competitionId) {
    const comp = Competition.findById(competitionId);
    if (!comp) return [];
    return stmtFindEligible.all({ competition_id: Number(competitionId), tournament_id: comp.tournament_id ?? null });
  },

  bulkAdd(competitionId, refereeIds) {
    const run = db.transaction(() => {
      let added = 0;
      for (const rid of refereeIds) {
        if (stmtInsert.run(Number(competitionId), Number(rid)).changes) added++;
      }
      return added;
    });
    return run();
  },

  // Only removes the competition-level entry — a referee also present via
  // the tournament roster stays in the effective roster (remove there too
  // via the tournament page if the intent is to drop them entirely).
  remove(competitionId, refereeId) {
    return stmtDelete.run(Number(competitionId), Number(refereeId));
  },

  // Assign sequential rank_order (1..N) by referee.level — see lib/refereeLevel.js
  // for the sort convention. Ranking always writes to this competition's own
  // competition_referees row, INSERT-OR-IGNORE-ing one first for any
  // tournament-only referee so the rank has somewhere to live (this also
  // promotes that referee to via:'both', which is the correct/expected
  // side effect of giving them a competition-specific rank).
  autoRankByLevel(competitionId) {
    const list = this.findAll(competitionId);
    const sorted = [...list].sort((a, b) =>
      compareByLevel(a.level, b.level) || (a.last_name + a.first_name).localeCompare(b.last_name + b.first_name)
    );
    const run = db.transaction(() => {
      sorted.forEach((r, i) => {
        stmtInsert.run(Number(competitionId), r.referee_id);
        stmtSetRank.run(i + 1, Number(competitionId), r.referee_id);
      });
    });
    run();
    return sorted.length;
  },

  // Swap this referee with its neighbor in the current effective display
  // order ('up'/'down'). See autoRankByLevel above re: why every row gets an
  // INSERT-OR-IGNORE competition_referees row first.
  moveRank(competitionId, refereeId, direction) {
    const list = this.findAll(competitionId);
    const idx = list.findIndex(r => r.referee_id === Number(refereeId));
    if (idx === -1) return false;
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= list.length) return false;

    const run = db.transaction(() => {
      list.forEach((r, i) => {
        stmtInsert.run(Number(competitionId), r.referee_id);
        stmtSetRank.run(i + 1, Number(competitionId), r.referee_id);
      });
      stmtInsert.run(Number(competitionId), list[idx].referee_id);
      stmtInsert.run(Number(competitionId), list[swapIdx].referee_id);
      stmtSetRank.run(swapIdx + 1, Number(competitionId), list[idx].referee_id);
      stmtSetRank.run(idx + 1, Number(competitionId), list[swapIdx].referee_id);
    });
    run();
    return true;
  },

  checkIn(competitionId, refereeId) {
    return stmtCheckIn.run(Number(competitionId), Number(refereeId));
  },

  checkOut(competitionId, refereeId) {
    return stmtCheckOut.run(Number(competitionId), Number(refereeId));
  },

  checkInAll(competitionId) {
    const list = this.findAll(competitionId);
    const run = db.transaction(() => {
      for (const r of list) stmtCheckIn.run(Number(competitionId), r.referee_id);
    });
    run();
    return list.length;
  },

  checkOutAll(competitionId) {
    return stmtCheckOutAll.run(Number(competitionId));
  },
};

module.exports = CompetitionReferee;
