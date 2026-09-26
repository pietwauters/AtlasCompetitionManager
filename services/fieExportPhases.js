'use strict';
// Stage writers for the FIE XML results export (services/fieExport.js):
// TourDePoules and PhaseDeTableaux, plus the chain/exemption/seeding helpers
// both share. `ctx` is the export context built by fieExport.js's buildContext.
const db       = require('../db');
const Bout     = require('./bouts');
const DeLayout = require('./deLayout');
const Results  = require('./results');
const { buildSeedPositions } = require('../lib/deFormation');
const { deSlotParams }       = require('../lib/deSlotMath');
const { heure, stripLabel, powerOfTwoAtLeast } = require('../lib/fieXml');

const stmtPools = db.prepare(`
  SELECT p.*, s.name AS strip_name, s.strip_number
  FROM pools p LEFT JOIN strips s ON s.id = p.strip_id
  WHERE p.phase_id = ? ORDER BY p.pool_number
`);
const stmtPoolMembers = db.prepare(
  'SELECT competitor_id, pool_slot FROM pool_competitors WHERE pool_id = ? ORDER BY pool_slot, competitor_id'
);
const stmtRankings = db.prepare('SELECT * FROM rankings WHERE phase_id = ?');
const stmtPoolSlot = db.prepare(`
  SELECT ps.*, s.name AS strip_name, s.strip_number
  FROM pipeline_slots ps LEFT JOIN strips s ON s.id = ps.strip_id
  WHERE ps.pool_id = ? ORDER BY ps.id LIMIT 1
`);
const stmtDeSlots = db.prepare(`
  SELECT ps.*, s.name AS strip_name, s.strip_number
  FROM pipeline_slots ps LEFT JOIN strips s ON s.id = ps.strip_id
  WHERE ps.phase_id = ? AND ps.type = 'de'
`);
const stmtSlotOfficials = db.prepare('SELECT role, referee_id FROM pipeline_slot_officials WHERE slot_id = ?');

// pipeline_slot_officials.role → FIE Arbitre Role (assessors are not match referees)
const OFFICIAL_ROLE = { referee2: 'A', video_assistant: 'V' };

// Competitors taking part in a phase: pool members, or anyone in a DE bout.
function participantsOf(ph) {
  const ids = new Set();
  if (ph.type === 'pool') {
    for (const pool of stmtPools.all(ph.id)) {
      for (const m of stmtPoolMembers.all(pool.id)) ids.add(m.competitor_id);
    }
  } else {
    for (const b of Bout.findByPhase(ph.id)) {
      if (b.left_id) ids.add(b.left_id);
      if (b.right_id) ids.add(b.right_id);
    }
  }
  return ids;
}

function phaseLabel(ctx, ph) {
  if (!ctx.phaseIdOf.has(ph.id)) {
    const sameType = ctx.phases.filter(p => p.type === ph.type);
    const n = sameType.indexOf(ph) + 1;
    ctx.phaseIdOf.set(ph.id, (ph.type === 'pool' ? 'TourPoules' : 'PhaseTableaux') + n);
  }
  return ctx.phaseIdOf.get(ph.id);
}

function nextPhase(ctx, ph) {
  if (ctx.parallel || ctx.isTerminal(ph)) return null;
  return ctx.phases.find(p => p.phase_order > ph.phase_order) || null;
}

// §7.2.16: a stage lists everyone not yet eliminated, "noting as exempted
// those who don't participate". In a single chain that is every exported
// competitor absent from this phase who wasn't knocked out in an earlier one —
// which also covers exempts whose own later phase doesn't exist yet (e.g. a
// Grand Prix's top 16 during the pool round).
function exemptIds(ctx, ph) {
  const here = ctx.participantsByPhase.get(ph.id);
  // An unseeded DE skeleton has no participants yet, so nobody is exempt from it.
  if (ctx.parallel || here.size === 0) return [];
  const orderOf = new Map(ctx.phases.map(p => [p.id, p.phase_order]));
  return ctx.competitors
    .filter(c => !here.has(c.id) && c.status !== 'withdrawn')
    .filter(c => c.eliminated_after == null || (orderOf.get(c.eliminated_after) ?? 0) > ph.phase_order)
    .map(c => c.id);
}

// Overall rank at the end of a pool round. Exempted fencers are by definition
// the top seeds, so everyone who fenced ranks after them (FIE reference files:
// a Grand Prix's pool fencers are ranked from 17 behind the 16 exempts).
function poolRankMap(ctx, poolPh) {
  const offset = exemptIds(ctx, poolPh).length;
  return new Map(stmtRankings.all(poolPh.id).map(r => [r.competitor_id, r.position + offset]));
}

// Seeding entering a phase: the previous pool round's ranking if the fencer
// was in it (mirrors poolPhases.create), otherwise the initial seed.
function seedMapBefore(ctx, ph) {
  const prevPool = [...ctx.phases].reverse()
    .find(p => p.type === 'pool' && p.phase_order < ph.phase_order);
  const prev = prevPool ? poolRankMap(ctx, prevPool) : new Map();
  return id => prev.get(id) ?? ctx.byId.get(id)?.initial_seed ?? null;
}

function officialsFor(ctx, primaryRefId, slot) {
  const out = [];
  const add = (id, role) => {
    if (!id || out.some(o => o.id === id)) return;
    out.push({ id, role });
  };
  add(primaryRefId || slot?.referee_id, 'P');
  if (slot) for (const o of stmtSlotOfficials.all(slot.id)) if (OFFICIAL_ROLE[o.role]) add(o.referee_id, OFFICIAL_ROLE[o.role]);
  return out;
}

function writeMatch(w, ctx, b, matchId, slot) {
  const hasLeft = !!b.left_id, hasRight = !!b.right_id;
  const isBye = b.status === 'finished' && (hasLeft !== hasRight);
  // §7.2.11: a bye carries neither score nor status, whatever Atlas stored on it.
  const scored = !isBye && b.status === 'finished' && b.left_score != null && b.right_score != null;
  const strip = ctx.strips.get(b.strip_id) || slot;
  const time = heure(slot?.scheduled_start);

  let statut = null;
  if (!isBye && hasLeft && hasRight) statut = b.status === 'finished' ? 'O' : 'P';

  w.open('Match', {
    ID: matchId,
    Piste: stripLabel(strip),
    Date: time ? ctx.date : null,
    Heure: time,
    Statut: statut,
  });
  for (const o of officialsFor(ctx, b.referee_id, slot)) {
    w.empty('Arbitre', { REF: ctx.refId(o.id), Role: o.role });
  }
  for (const [side, id, score, cote] of [['left', b.left_id, b.left_score, 'G'], ['right', b.right_id, b.right_score, 'D']]) {
    if (!id) { w.empty('Tireur'); continue; }
    const c = ctx.byId.get(id);
    const card = ctx.cards.get(`${b.id}:${side}`);
    w.empty('Tireur', {
      REF: ctx.fencerId(c),
      Score: scored ? score : null,
      Statut: scored && b.winner_id ? (b.winner_id === id ? 'V' : 'D') : null,
      Cote: isBye ? null : cote,
      CartonJaune: card?.yellow || null,
      CartonRouge: card?.red || null,
    });
  }
  w.close('Match');
}

// ---------------------------------------------------------------------------
// TourDePoules
// ---------------------------------------------------------------------------
function poolStats(members, bouts) {
  const s = new Map(members.map(m => [m.competitor_id, { v: 0, m: 0, td: 0, tr: 0 }]));
  for (const b of bouts) {
    if (b.status !== 'finished' || b.left_score == null || b.right_score == null) continue;
    for (const [id, own, opp] of [[b.left_id, b.left_score, b.right_score], [b.right_id, b.right_score, b.left_score]]) {
      const e = s.get(id);
      if (!e) continue;
      e.m++; e.td += own; e.tr += opp;
      if (b.winner_id === id) e.v++;
    }
  }
  // RangPoule: 1 + number of pool members strictly better (ties share a rank).
  const key = e => [e.m ? e.v / e.m : 0, e.td - e.tr, e.td, -e.tr];
  const better = (a, b) => {
    const ka = key(a), kb = key(b);
    for (let i = 0; i < ka.length; i++) if (Math.abs(ka[i] - kb[i]) > 1e-9) return ka[i] > kb[i];
    return false;
  };
  for (const e of s.values()) {
    e.rank = e.m ? 1 + [...s.values()].filter(o => o.m && better(o, e)).length : null;
  }
  return s;
}

function writeTourDePoules(w, ctx, ph, seq) {
  const pools = stmtPools.all(ph.id);
  const rankings = new Map(stmtRankings.all(ph.id).map(r => [r.competitor_id, r]));
  const overall = poolRankMap(ctx, ph);
  const finished = ph.status === 'finished';
  const next = nextPhase(ctx, ph);
  const seedOf = seedMapBefore(ctx, ph);
  const exempt = exemptIds(ctx, ph);
  const advanced = [...rankings.values()].filter(r => r.advanced === 1).length;
  const next_ = next ? phaseLabel(ctx, next) : null;

  w.open('TourDePoules', {
    PhaseID: phaseLabel(ctx, ph),
    ID: seq,
    PhaseSuivanteDesQualifies: next_,
    NbDePoules: pools.length,
    NbQualifiesParPoule: 0,
    NbQualifiesParIndice: next && finished ? advanced : 0,
    NbExemptes: exempt.length || null,
  });

  const rows = [...ctx.participantsByPhase.get(ph.id)].map(id => {
    const r = rankings.get(id);
    return {
      id, RangInitial: seedOf(id), RangFinal: finished ? overall.get(id) : null,
      Statut: finished && next && r ? (r.advanced === 1 ? 'Q' : 'N') : null,
    };
  });
  for (const id of exempt) {
    const seed = seedOf(id);
    rows.push({ id, RangInitial: seed, RangFinal: seed, Statut: 'X' });
  }
  rows.sort((a, b) => (a.RangFinal ?? a.RangInitial ?? 1e9) - (b.RangFinal ?? b.RangInitial ?? 1e9));
  for (const r of rows) {
    w.empty('Tireur', { REF: ctx.fencerId(ctx.byId.get(r.id)), RangInitial: r.RangInitial, RangFinal: r.RangFinal, Statut: r.Statut });
  }

  const bouts = Bout.findByPhase(ph.id);
  for (const pool of pools) {
    const members = stmtPoolMembers.all(pool.id);
    const poolBouts = bouts.filter(b => b.pool_id === pool.id).sort((a, b) => a.bout_order - b.bout_order);
    const stats = poolStats(members, poolBouts);
    const slot = stmtPoolSlot.get(pool.id);
    const time = heure(slot?.scheduled_start);
    const anyDone = poolBouts.some(b => b.status === 'finished');

    w.open('Poule', {
      ID: pool.pool_number,
      Piste: stripLabel(pool) || stripLabel(slot),
      Date: time ? ctx.date : null,
      Heure: time,
      Statut: pool.status === 'finished' ? 'O' : anyDone ? 'L' : 'P',
    });
    members.forEach((m, i) => {
      const s = stats.get(m.competitor_id);
      w.empty('Tireur', {
        REF: ctx.fencerId(ctx.byId.get(m.competitor_id)),
        NoDansLaPoule: m.pool_slot ?? i + 1,
        NbVictoires: s.v, NbMatches: s.m, TD: s.td, TR: s.tr,
        RangPoule: s.rank,
      });
    });
    const poolRef = pool.referee_id || slot?.referee_id;
    if (poolRef) w.empty('Arbitre', { REF: ctx.refId(poolRef) });
    for (const b of poolBouts) {
      writeMatch(w, ctx, { ...b, strip_id: b.strip_id || pool.strip_id }, b.bout_order, slot);
    }
    w.close('Poule');
  }
  w.close('TourDePoules');
}

// ---------------------------------------------------------------------------
// PhaseDeTableaux
// ---------------------------------------------------------------------------

// Map each DE bout id → the pipeline slot that scheduled it (piste, time, officials).
function deSlotByBout(ph, bouts) {
  const out = new Map();
  const byRound = new Map();
  for (const b of bouts) {
    const k = `${b.bracket || 'main'}:${b.de_round}`;
    if (!byRound.has(k)) byRound.set(k, []);
    byRound.get(k).push(b);
  }
  for (const list of byRound.values()) list.sort((a, b) => a.tableau_position - b.tableau_position);

  for (const slot of stmtDeSlots.all(ph.id)) {
    if (slot.bracket === 'placement') {
      for (const id of DeLayout.placementGroupBoutIds(ph.id, slot.tableau, Number(slot.partition))) out.set(id, slot);
      continue;
    }
    const { deRound, lo, hi, bracket } = deSlotParams(slot);
    const list = byRound.get(`${bracket}:${deRound}`) || [];
    list.forEach((b, i) => { if (i + 1 >= lo && i + 1 <= hi) out.set(b.id, slot); });
  }
  return out;
}

function deSeedMap(bouts) {
  const r1 = bouts.filter(b => (b.bracket === 'main' || !b.bracket) && b.de_round === 1);
  if (!r1.length) return new Map();
  const slots = buildSeedPositions(r1.length * 2);
  const out = new Map();
  for (const b of r1) {
    const p = b.tableau_position;
    if (b.left_id) out.set(b.left_id, slots[2 * (p - 1)]);
    if (b.right_id) out.set(b.right_id, slots[2 * (p - 1) + 1]);
  }
  return out;
}

function writePhaseDeTableaux(w, ctx, ph, seq, finalPlaces) {
  const bouts = Bout.findByPhase(ph.id);
  const layout = DeLayout.buildSections(ph.id) || { sections: [] };
  const slotOf = deSlotByBout(ph, bouts);
  const next = nextPhase(ctx, ph);
  const terminal = ctx.isTerminal(ph);
  const finished = ph.status === 'finished';
  const deSeed = deSeedMap(bouts);
  const seedOf = seedMapBefore(ctx, ph);
  const exempt = exemptIds(ctx, ph);

  // Ranking inside this stage: the terminal tableau's own places; for an
  // intermediate tableau (e.g. GP preliminary) only the eliminated get a
  // final rank (their competition place) — survivors are ranked by the next stage.
  const phasePlace = terminal
    ? new Map(Results.rankDePhase(ph.id).map(e => [e.competitor_id, e.place]))
    : null;

  w.open('PhaseDeTableaux', {
    PhaseID: phaseLabel(ctx, ph),
    ID: seq,
    PhaseSuivanteDesQualifies: next ? phaseLabel(ctx, next) : null,
    NbExemptes: exempt.length || null,
  });

  const rows = [...ctx.participantsByPhase.get(ph.id)].map(id => {
    const c = ctx.byId.get(id);
    const out = c?.eliminated_after === ph.id;
    return {
      id,
      // §7.2.4/§7.2.22: an intermediate tableau carries the ranking fencers
      // bring in (pool rank); the final tableau the seeding it was drawn from.
      RangInitial: (terminal ? deSeed.get(id) : null) ?? seedOf(id),
      RangFinal: terminal ? phasePlace.get(id) : (out ? finalPlaces.get(id) : null),
      Statut: !terminal && finished && next ? (out ? 'N' : 'Q') : null,
    };
  });
  for (const id of exempt) {
    const seed = seedOf(id);
    rows.push({ id, RangInitial: seed, RangFinal: seed, Statut: 'X' });
  }
  rows.sort((a, b) => (a.RangFinal ?? a.RangInitial ?? 1e9) - (b.RangFinal ?? b.RangInitial ?? 1e9));
  for (const r of rows) {
    w.empty('Tireur', { REF: ctx.fencerId(ctx.byId.get(r.id)), RangInitial: r.RangInitial, RangFinal: r.RangFinal, Statut: r.Statut });
  }

  // Each deLayout section (main / repechage / finals / placement groups) is
  // one SuiteDeTableaux; each of its rounds one Tableau.
  const suites = layout.sections.filter(s => s.rounds.some(r => r.bouts.length));
  const plan = suites.map((section, si) => {
    const letter = String.fromCharCode(65 + si);
    const used = new Set();
    const tableaux = section.rounds.filter(r => r.bouts.length).map(round => {
      const taille = round.stripSlot?.tableau && section.id !== 'repechage' && !section.id.startsWith('placement')
        ? round.stripSlot.tableau
        : powerOfTwoAtLeast(round.bouts.length * 2);
      let id = letter + taille;
      for (let k = 2; used.has(id); k++) id = `${letter}${taille}_${k}`;
      used.add(id);
      const titre = section.id.startsWith('placement') ? `${section.label} — ${round.label}` : round.label;
      return { id, taille, titre, round };
    });
    return { section, letter, tableaux };
  });

  const tableauOfBout = new Map();
  for (const s of plan) for (const t of s.tableaux) for (const b of t.round.bouts) tableauOfBout.set(b.id, t.id);

  plan.forEach(({ section, letter, tableaux }) => {
    const title = section.note ? `${section.label} (${section.note})` : section.label;
    w.open('SuiteDeTableaux', { ID: `SuiteTab_${letter}`, Lettre: letter, NbDeTableaux: tableaux.length, Titre: title });
    for (const t of tableaux) {
      const bs = t.round.bouts;
      const dest = new Set(bs.map(b => b.loser_next_bout_id && tableauOfBout.get(b.loser_next_bout_id)).filter(Boolean));
      const real = bs.filter(b => b.left_id && b.right_id);
      const statut = real.length && real.every(b => b.status === 'finished') ? 'O'
        : bs.some(b => b.status === 'finished' && b.left_id && b.right_id) ? 'L' : 'P';
      w.open('Tableau', {
        ID: t.id, Titre: t.titre, Taille: t.taille,
        DestinationDesElimines: dest.size === 1 ? [...dest][0] : null,
        Statut: statut,
      });
      bs.forEach((b, i) => {
        const matchId = section.id === 'main' || section.id === 'finals' ? (b.tableau_position ?? i + 1) : i + 1;
        writeMatch(w, ctx, b, matchId, slotOf.get(b.id));
      });
      w.close('Tableau');
    }
    w.close('SuiteDeTableaux');
  });
  w.close('PhaseDeTableaux');
}


module.exports = { participantsOf, officialsFor, writeTourDePoules, writePhaseDeTableaux };
