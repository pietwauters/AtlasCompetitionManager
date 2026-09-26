'use strict';
// Team-competition writers for the FIE XML results export (services/fieExport.js):
// the Equipes list and one PhaseDeTableaux per team_de phase, with each match's
// relays as <Assaut> elements (§7.2.13). `ctx` is fieExport.js's export context.
const db        = require('../db');
const TeamMatch = require('./teamMatches');
const { officialsFor } = require('./fieExportPhases');
const { heure, stripLabel, makeIdFn } = require('../lib/fieXml');

const stmtTeams = db.prepare(`
  SELECT t.*, cl.name AS club_name
  FROM teams t LEFT JOIN clubs cl ON cl.id = t.club_id
  WHERE t.competition_id = ?
  ORDER BY t.final_rank IS NULL, t.final_rank, t.seed IS NULL, t.seed, t.name
`);
const stmtMembers = db.prepare(`
  SELECT comp.*, cl.name AS club_name, tm.role
  FROM team_members tm
  JOIN competitors comp ON comp.id = tm.competitor_id
  LEFT JOIN people p  ON p.id  = comp.person_id
  LEFT JOIN clubs  cl ON cl.id = p.club_id
  WHERE tm.team_id = ?
  ORDER BY tm.role = 'reserve', tm.id
`);
const stmtMatches = db.prepare(`
  SELECT * FROM team_matches WHERE phase_id = ?
  ORDER BY de_round IS NULL, de_round, tableau_position, match_order
`);
const stmtMatchSlot = db.prepare(`
  SELECT ps.*, s.name AS strip_name, s.strip_number
  FROM pipeline_slots ps LEFT JOIN strips s ON s.id = ps.strip_id
  WHERE ps.team_match_id = ? ORDER BY ps.id LIMIT 1
`);

function extendContext(ctx) {
  const teams = stmtTeams.all(ctx.comp.id);
  const membersOf = new Map(teams.map(t => [t.id, stmtMembers.all(t.id)]));
  const competitors = [...membersOf.values()].flat();
  return {
    ...ctx, teams, membersOf,
    byId: new Map(competitors.map(c => [c.id, c])),
    fencerId: makeIdFn(competitors, 'C'),
    teamId: t => String(t.id),
  };
}

// §7.2.6: a team's Nation is a nation code; only set when every member shares one.
function teamNation(members) {
  const nations = new Set(members.map(m => m.nationality).filter(Boolean));
  return nations.size === 1 ? [...nations][0] : null;
}

function writeEquipes(w, ctx, fencerAttrs, isFie) {
  w.open('Equipes');
  for (const t of ctx.teams) {
    const members = ctx.membersOf.get(t.id);
    w.open('Equipe', {
      ID: ctx.teamId(t),
      Nom: t.name,
      Nation: teamNation(members),
      Club: isFie ? null : t.club_name,
      RangInitial: t.seed,
      Classement: t.final_rank,
    });
    for (const m of members) w.empty('Tireur', fencerAttrs(m));
    w.close('Equipe');
  }
  w.close('Equipes');
}

function roundTitle(taille) {
  return taille === 2 ? 'Final' : taille === 4 ? 'Semi-finals' : taille === 8 ? 'Quarter-finals' : `Tableau of ${taille}`;
}

function writeTeamMatch(w, ctx, m, matchId) {
  const teamById = id => ctx.teams.find(t => t.id === id);
  const hasLeft = !!m.left_team_id, hasRight = !!m.right_team_id;
  const isBye = m.status === 'finished' && hasLeft !== hasRight;
  const scored = !isBye && m.status === 'finished' && m.left_score != null && m.right_score != null;
  const slot = stmtMatchSlot.get(m.id);
  const time = heure(slot?.scheduled_start);

  w.open('Match', {
    ID: matchId,
    Piste: stripLabel(slot),
    Date: time ? ctx.date : null,
    Heure: time,
    Statut: !isBye && hasLeft && hasRight ? (m.status === 'finished' ? 'O' : 'P') : null,
  });
  for (const o of officialsFor(ctx, slot?.referee_id, slot)) w.empty('Arbitre', { REF: ctx.refId(o.id), Role: o.role });
  for (const [id, score] of [[m.left_team_id, m.left_score], [m.right_team_id, m.right_score]]) {
    if (!id) { w.empty('Equipe'); continue; }
    w.empty('Equipe', {
      REF: ctx.teamId(teamById(id)),
      Score: scored ? score : null,
      Statut: scored && m.winner_team_id ? (m.winner_team_id === id ? 'V' : 'D') : null,
    });
  }
  if (!isBye && hasLeft && hasRight) {
    for (const r of TeamMatch.getRelays(m.id)) {
      const started = r.status === 'finished' || r.left_touches != null || r.right_touches != null;
      if (!started) continue;
      w.open('Assaut', { ID: r.relay_number, Statut: r.status === 'finished' ? 'O' : 'L' });
      for (const [cid, touches] of [[r.left_competitor_id, r.left_touches], [r.right_competitor_id, r.right_touches]]) {
        const c = cid && ctx.byId.get(cid);
        w.empty('Tireur', { REF: c ? ctx.fencerId(c) : null, Score: touches ?? null });
      }
      w.close('Assaut');
    }
  }
  w.close('Match');
}

// One team_de phase: suite A = the main tableau, suite B = the bronze match.
function writeTeamPhase(w, ctx, ph, seq) {
  const matches = stmtMatches.all(ph.id);
  const main = matches.filter(m => m.de_round != null);
  const bronze = matches.filter(m => m.de_round == null && m.place_rank === 3);
  const T = main.filter(m => m.de_round === 1).length * 2;
  const rounds = [...new Set(main.map(m => m.de_round))].sort((a, b) => a - b);
  const finished = ph.status === 'finished';

  w.open('PhaseDeTableaux', { PhaseID: `PhaseTableaux${seq}`, ID: seq });
  const inPhase = new Set(matches.flatMap(m => [m.left_team_id, m.right_team_id]).filter(Boolean));
  for (const t of ctx.teams.filter(x => inPhase.has(x.id))) {
    w.empty('Equipe', { REF: ctx.teamId(t), RangInitial: t.seed, RangFinal: finished ? t.final_rank : null });
  }

  const tableauStatut = ms => {
    const real = ms.filter(m => m.left_team_id && m.right_team_id);
    return real.length && real.every(m => m.status === 'finished') ? 'O'
      : real.some(m => m.status === 'finished') ? 'L' : 'P';
  };

  w.open('SuiteDeTableaux', { ID: 'SuiteTab_A', Lettre: 'A', NbDeTableaux: rounds.length, Titre: 'Main tableau' });
  for (const r of rounds) {
    const taille = T >> (r - 1);
    const ms = main.filter(m => m.de_round === r);
    const feedsBronze = bronze.length && ms.some(m => m.loser_next_match_id === bronze[0].id);
    w.open('Tableau', {
      ID: `A${taille}`, Titre: roundTitle(taille), Taille: taille,
      DestinationDesElimines: feedsBronze ? 'B2' : null,
      Statut: tableauStatut(ms),
    });
    for (const m of ms) writeTeamMatch(w, ctx, m, m.tableau_position);
    w.close('Tableau');
  }
  w.close('SuiteDeTableaux');

  if (bronze.length) {
    w.open('SuiteDeTableaux', { ID: 'SuiteTab_B', Lettre: 'B', NbDeTableaux: 1, Titre: 'Places 3-4' });
    w.open('Tableau', { ID: 'B2', Titre: 'Bronze match', Taille: 2, Statut: tableauStatut(bronze) });
    bronze.forEach((m, i) => writeTeamMatch(w, ctx, m, i + 1));
    w.close('Tableau');
    w.close('SuiteDeTableaux');
  }
  w.close('PhaseDeTableaux');
}

module.exports = { extendContext, writeEquipes, writeTeamPhase };
