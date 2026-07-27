'use strict';
const db = require('../db');
const { compareByLevel } = require('../lib/refereeLevel');

const stmtInsert   = db.prepare('INSERT OR IGNORE INTO tournament_referees (tournament_id, referee_id) VALUES (?, ?)');
const stmtDelete   = db.prepare('DELETE FROM tournament_referees WHERE tournament_id = ? AND referee_id = ?');
const stmtSetRank  = db.prepare('UPDATE tournament_referees SET rank_order = ? WHERE tournament_id = ? AND referee_id = ?');
const stmtFindAll  = db.prepare(`
  SELECT r.id AS referee_id, r.level, p.id AS person_id, p.first_name, p.last_name,
         p.nationality, p.club_id, c.name AS club_name, tr.rank_order
  FROM tournament_referees tr
  JOIN referees r ON r.id = tr.referee_id
  JOIN people   p ON p.id = r.person_id
  LEFT JOIN clubs c ON c.id = p.club_id
  WHERE tr.tournament_id = ?
  ORDER BY CASE WHEN tr.rank_order IS NULL THEN 1 ELSE 0 END, tr.rank_order, p.last_name, p.first_name
`);
const stmtFindEligible = db.prepare(`
  SELECT r.id AS referee_id, r.level, p.id AS person_id, p.first_name, p.last_name,
         p.nationality, p.club_id, c.name AS club_name,
         CASE WHEN tr.referee_id IS NOT NULL THEN 1 ELSE 0 END AS is_registered
  FROM referees r
  JOIN people p ON p.id = r.person_id
  LEFT JOIN clubs c ON c.id = p.club_id
  LEFT JOIN tournament_referees tr ON tr.referee_id = r.id AND tr.tournament_id = ?
  ORDER BY p.last_name, p.first_name
`);

const TournamentReferee = {
  findAll(tournamentId) {
    return stmtFindAll.all(Number(tournamentId));
  },

  // Every referee in the DB, flagged is_registered for this tournament.
  findEligible(tournamentId) {
    return stmtFindEligible.all(Number(tournamentId));
  },

  // Add multiple referees at once. Skips already-registered ones.
  bulkAdd(tournamentId, refereeIds) {
    const run = db.transaction(() => {
      let added = 0;
      for (const rid of refereeIds) {
        if (stmtInsert.run(Number(tournamentId), Number(rid)).changes) added++;
      }
      return added;
    });
    return run();
  },

  remove(tournamentId, refereeId) {
    return stmtDelete.run(Number(tournamentId), Number(refereeId));
  },

  // Assign sequential rank_order (1..N) by referee.level — see lib/refereeLevel.js
  // for the sort convention. Ties broken alphabetically.
  autoRankByLevel(tournamentId) {
    const list = this.findAll(tournamentId);
    const sorted = [...list].sort((a, b) =>
      compareByLevel(a.level, b.level) || (a.last_name + a.first_name).localeCompare(b.last_name + b.first_name)
    );
    const run = db.transaction(() => {
      sorted.forEach((r, i) => stmtSetRank.run(i + 1, Number(tournamentId), r.referee_id));
    });
    run();
    return sorted.length;
  },

  // Swap this referee with its neighbor in the current display order
  // ('up'/'down'). Normalizes every row in the roster to sequential
  // rank_order first (current display order — rank_order if already set,
  // else the alphabetical fallback findAll already applies), so this works
  // correctly even before any ranking has ever been assigned.
  moveRank(tournamentId, refereeId, direction) {
    const list = this.findAll(tournamentId);
    const idx = list.findIndex(r => r.referee_id === Number(refereeId));
    if (idx === -1) return false;
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= list.length) return false;

    const run = db.transaction(() => {
      list.forEach((r, i) => stmtSetRank.run(i + 1, Number(tournamentId), r.referee_id));
      stmtSetRank.run(swapIdx + 1, Number(tournamentId), list[idx].referee_id);
      stmtSetRank.run(idx + 1, Number(tournamentId), list[swapIdx].referee_id);
    });
    run();
    return true;
  },
};

module.exports = TournamentReferee;
