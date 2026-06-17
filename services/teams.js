'use strict';

const db = require('../db');

function membersOf(teamId) {
  return db.prepare(`
    SELECT tm.id, tm.competitor_id, tm.role,
           co.first_name, co.last_name, co.initial_seed AS ranking,
           co.initial_seed, co.checked_in, co.status AS competitor_status
    FROM team_members tm
    JOIN competitors co ON co.id = tm.competitor_id
    WHERE tm.team_id = ?
    ORDER BY tm.role ASC, co.last_name, co.first_name
  `).all(teamId);
}

const Team = {
  findAll(competitionId) {
    const teams = db.prepare(`
      SELECT t.id, t.competition_id, t.name, t.club_id, t.seed, t.status, t.final_rank,
             cl.name AS club_name
      FROM teams t
      LEFT JOIN clubs cl ON cl.id = t.club_id
      WHERE t.competition_id = ?
      ORDER BY t.seed, t.name
    `).all(competitionId);

    for (const t of teams) t.members = membersOf(t.id);
    return teams;
  },

  findById(teamId) {
    const team = db.prepare(`
      SELECT t.id, t.competition_id, t.name, t.club_id, t.seed, t.status, t.final_rank,
             cl.name AS club_name
      FROM teams t
      LEFT JOIN clubs cl ON cl.id = t.club_id
      WHERE t.id = ?
    `).get(teamId);
    if (!team) return null;
    team.members = membersOf(teamId);
    return team;
  },

  create(competitionId, { name, clubId = null }) {
    if (!name?.trim()) throw Object.assign(new Error('Team name is required.'), { status: 400 });
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO teams (competition_id, name, club_id) VALUES (?, ?, ?)
    `).run(competitionId, name.trim(), clubId);
    return this.findById(lastInsertRowid);
  },

  update(teamId, fields) {
    const team = db.prepare('SELECT id FROM teams WHERE id = ?').get(teamId);
    if (!team) throw Object.assign(new Error('Team not found.'), { status: 404 });

    const allowed = ['name', 'club_id', 'seed', 'status', 'final_rank'];
    const sets = [];
    const vals = [];
    for (const k of allowed) {
      if (fields[k] !== undefined) { sets.push(`${k} = ?`); vals.push(fields[k]); }
    }
    if (!sets.length) return this.findById(teamId);
    vals.push(teamId);
    db.prepare(`UPDATE teams SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return this.findById(teamId);
  },

  delete(teamId) {
    db.prepare('DELETE FROM teams WHERE id = ?').run(teamId);
  },

  // Auto-seed all teams in a competition: lower sum of member rankings = better seed.
  // Teams with no ranked members are placed last, then by name.
  autoSeed(competitionId) {
    const teams = db.prepare(`
      SELECT t.id,
             COALESCE(SUM(co.seeding_position), 999999) AS rank_sum,
             t.name
      FROM teams t
      LEFT JOIN team_members tm ON tm.team_id = t.id AND tm.role = 'regular'
      LEFT JOIN competitors co  ON co.id = tm.competitor_id AND co.seeding_position IS NOT NULL
      WHERE t.competition_id = ? AND t.status = 'active'
      GROUP BY t.id
      ORDER BY rank_sum ASC, t.name ASC
    `).all(competitionId);

    const update = db.prepare('UPDATE teams SET seed = ? WHERE id = ?');
    db.transaction(() => {
      teams.forEach((t, i) => update.run(i + 1, t.id));
    })();
  },

  addMember(teamId, competitorId, role = 'regular') {
    if (!['regular', 'reserve'].includes(role)) {
      throw Object.assign(new Error('Role must be regular or reserve.'), { status: 400 });
    }
    const team = db.prepare('SELECT competition_id FROM teams WHERE id = ?').get(teamId);
    if (!team) throw Object.assign(new Error('Team not found.'), { status: 404 });

    const comp = db.prepare(
      'SELECT id FROM competitors WHERE id = ? AND competition_id = ?'
    ).get(competitorId, team.competition_id);
    if (!comp) throw Object.assign(
      new Error('Competitor not found in this competition.'), { status: 400 }
    );

    // Enforce team size limits
    const counts = db.prepare(`
      SELECT role, COUNT(*) AS cnt FROM team_members WHERE team_id = ? GROUP BY role
    `).all(teamId).reduce((acc, r) => { acc[r.role] = r.cnt; return acc; }, {});
    const rule = require('../lib/rules').loadRule('team-fie-standard.json');
    if (role === 'regular' && (counts.regular ?? 0) >= rule.team.size) {
      throw Object.assign(new Error(`A team can have at most ${rule.team.size} regular members.`), { status: 400 });
    }
    if (role === 'reserve' && (counts.reserve ?? 0) >= rule.team.reserveCount) {
      throw Object.assign(new Error(`A team can have at most ${rule.team.reserveCount} reserve.`), { status: 400 });
    }

    db.prepare(`
      INSERT INTO team_members (team_id, competitor_id, role) VALUES (?, ?, ?)
    `).run(teamId, competitorId, role);

    return this.findById(teamId);
  },

  removeMember(teamId, competitorId) {
    db.prepare(
      'DELETE FROM team_members WHERE team_id = ? AND competitor_id = ?'
    ).run(teamId, competitorId);
    return this.findById(teamId);
  },
};

module.exports = Team;
