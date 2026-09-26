'use strict';
// FIE XML results export — CompetitionIndividuelle, grammar version 3.3.
// Reference: docs/FIE_XML/XML_Specifications_FIE_2019.docx + competitionSchema-v20.xsd.
// Element/attribute order follows the XSD sequences exactly (Match: Arbitre
// before Tireur; Poule: Tireur, Arbitre, Match; root: Tireurs, Arbitres, Phases).
// Stage writers live in services/fieExportPhases.js.
const db      = require('../db');
const Format  = require('./formats');
const Results = require('./results');
const Phases  = require('./fieExportPhases');
const { XmlWriter, fieDate, fieNow, lateralite, makeIdFn } = require('../lib/fieXml');

const stmtCompetition = db.prepare(`
  SELECT c.*, t.name AS t_name, t.city AS t_city, t.date_start AS t_date_start,
         t.date_end AS t_date_end, t.organizer AS t_organizer, t.level AS t_level,
         t.fie_season AS t_fie_season, t.organizing_federation AS t_federation,
         t.championship AS t_championship
  FROM competitions c LEFT JOIN tournaments t ON t.id = c.tournament_id
  WHERE c.id = ?
`);
const stmtAgeCategoryCodes = db.prepare(`
  SELECT ac.code FROM competition_age_categories cac
  JOIN age_categories ac ON ac.id = cac.age_category_id
  WHERE cac.competition_id = ? ORDER BY ac.min_age
`);
const stmtCompetitors = db.prepare(`
  SELECT comp.*, cl.name AS club_name
  FROM competitors comp
  LEFT JOIN people p  ON p.id  = comp.person_id
  LEFT JOIN clubs  cl ON cl.id = p.club_id
  WHERE comp.competition_id = ?
  ORDER BY comp.last_name, comp.first_name
`);
const stmtPhases = db.prepare('SELECT * FROM phases WHERE competition_id = ? ORDER BY phase_order');
const stmtStrips = db.prepare('SELECT id, name, strip_number FROM strips');
const stmtCardsForCompetition = db.prepare(`
  SELECT cr.bout_id, cr.side, cr.card
  FROM card_reasons cr
  JOIN bouts b  ON b.id  = cr.bout_id
  JOIN phases ph ON ph.id = b.phase_id
  WHERE ph.competition_id = ?
`);
const stmtRosterReferees = db.prepare(`
  SELECT referee_id FROM competition_referees WHERE competition_id = @comp
  UNION
  SELECT referee_id FROM tournament_referees WHERE tournament_id = @tourn
`);
// Every referee this competition's pools/bouts/schedule slots reference.
const stmtReferencedReferees = db.prepare(`
  WITH ph AS (SELECT id FROM phases WHERE competition_id = @comp),
       pl AS (SELECT id FROM pools WHERE phase_id IN (SELECT id FROM ph)),
       sl AS (SELECT id, referee_id FROM pipeline_slots
              WHERE pool_id IN (SELECT id FROM pl) OR phase_id IN (SELECT id FROM ph))
  SELECT referee_id FROM pools WHERE id IN (SELECT id FROM pl) AND referee_id IS NOT NULL
  UNION SELECT referee_id FROM bouts WHERE phase_id IN (SELECT id FROM ph) AND referee_id IS NOT NULL
  UNION SELECT referee_id FROM sl WHERE referee_id IS NOT NULL
  UNION SELECT referee_id FROM pipeline_slot_officials
        WHERE slot_id IN (SELECT id FROM sl) AND role IN ('referee2', 'video_assistant')
`);
const stmtReferee = db.prepare(`
  SELECT r.id, r.level, p.first_name, p.last_name, p.gender, p.nationality,
         p.date_of_birth, p.fie_id, cl.name AS club_name
  FROM referees r
  JOIN people p ON p.id = r.person_id
  LEFT JOIN clubs cl ON cl.id = p.club_id
  WHERE r.id = ?
`);

const WEAPON_CODE   = { foil: 'F', epee: 'E', sabre: 'S' };
const CATEGORY_CODE = { U20: 'J', U17: 'C', Senior: 'S', Veteran: 'V' };
const DOMAIN_CODE   = [
  [/^int/i, 'I'], [/^nat/i, 'N'], [/^reg/i, 'R'], [/^(lea|lig)/i, 'L'], [/^club/i, 'C'], [/^zon/i, 'Z'],
];

// ---------------------------------------------------------------------------
// Export context: everything the phase writers share.
// ---------------------------------------------------------------------------
function buildContext(compId) {
  const comp = stmtCompetition.get(compId);
  if (!comp) throw Object.assign(new Error('Competition not found.'), { status: 404 });
  if (comp.is_team) {
    throw Object.assign(new Error('FIE XML export for team competitions (CompetitionParEquipes) is not supported yet.'), { status: 400 });
  }

  const phases = stmtPhases.all(compId).filter(p => p.type === 'pool' || p.type === 'de');
  if (!phases.length) {
    throw Object.assign(new Error('Nothing to export yet — a results file needs at least one round (the XSD requires one phase).'), { status: 400 });
  }

  let format = null;
  if (comp.format_id) {
    try { format = Format.loadFormat(comp.format_id); } catch { /* format file missing/renamed */ }
  }
  const terminalStages = format ? new Set(Format.getTerminalStages(format)) : null;
  // Independent parallel tracks (Division 1/2) have no single phase chain, so
  // "next phase" and "exempted from this phase" can't be derived from order.
  const parallel = !!terminalStages && terminalStages.size > 1;
  const lastDe = [...phases].reverse().find(p => p.type === 'de');
  const isTerminal = p => (terminalStages
    ? !!p.format_stage && terminalStages.has(p.format_stage)
    : (lastDe ? p.id === lastDe.id : p === phases[phases.length - 1]));

  const allCompetitors = stmtCompetitors.all(compId);
  const byId = new Map(allCompetitors.map(c => [c.id, c]));

  const participantsByPhase = new Map(phases.map(ph => [ph.id, Phases.participantsOf(ph)]));

  // Confirmation stage = check-in: someone who never reached a phase and was
  // never confirmed present is left out (spec §7.2.2).
  const fenced = new Set([...participantsByPhase.values()].flatMap(s => [...s]));
  const competitors = allCompetitors.filter(c =>
    fenced.has(c.id) || (c.checked_in === 1 && c.status === 'active'));

  const refereeIds = new Set([
    ...stmtRosterReferees.all({ comp: comp.id, tourn: comp.tournament_id }),
    ...stmtReferencedReferees.all({ comp: comp.id }),
  ].map(r => r.referee_id));
  const referees = [...refereeIds].map(id => stmtReferee.get(id)).filter(Boolean);
  const refIdOf = makeIdFn(referees, 'R');
  const refIds = new Map(referees.map(r => [r.id, refIdOf(r)]));
  const cards = new Map();
  for (const c of stmtCardsForCompetition.all(compId)) {
    const key = `${c.bout_id}:${c.side}`;
    const e = cards.get(key) || { yellow: 0, red: 0 };
    if (c.card === 'yellow') e.yellow++;
    if (c.card === 'red') e.red++;
    cards.set(key, e);
  }

  return {
    comp, phases, isTerminal, parallel, byId, competitors, participantsByPhase,
    fencerId: makeIdFn(competitors, 'C'),
    referees, refId: id => refIds.get(id) ?? `R${id}`, cards,
    strips: new Map(stmtStrips.all().map(s => [s.id, s])),
    date: fieDate(comp.date),
    phaseIdOf: new Map(),
  };
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------
function rootAttrs(ctx) {
  const c = ctx.comp;
  const cat = c.seeding_category || stmtAgeCategoryCodes.all(c.id).map(r => r.code)[0] || 'Senior';
  const championnat = c.seeding_issuer || c.t_championship || null;
  const levelHit = DOMAIN_CODE.find(([re]) => re.test(c.t_level || ''));
  const year = (c.date || c.t_date_start || '').slice(0, 4) || String(new Date().getFullYear());
  const multiDay = c.t_date_start && c.t_date_end && c.t_date_start !== c.t_date_end;
  return {
    Version: '3.3',
    Championnat: championnat,
    ID: c.fie_id || c.id,
    Annee: c.t_fie_season || year,
    Arme: WEAPON_CODE[c.weapon] || 'F',
    Sexe: ['M', 'F', 'X'].includes(c.gender) ? c.gender : 'X',
    Domaine: levelHit ? levelHit[1] : (c.fie_id || championnat === 'FIE' ? 'I' : 'N'),
    Federation: c.t_federation,
    Categorie: CATEGORY_CODE[cat] || cat,
    Date: ctx.date,
    DateDebut: multiDay ? fieDate(c.t_date_start) : null,
    DateFin: multiDay ? fieDate(c.t_date_end) : null,
    Lieu: c.t_city,
    Organisateur: c.t_organizer,
    IDTournoi: c.tournament_id,
    TitreLong: c.name,
    TitreCourt: c.code,
    TitreLongTournoi: c.t_name,
    DateFichierXML: fieNow(),
  };
}

const FieExport = {
  // Returns { xml, filename } for an individual competition's results file.
  exportCompetition(compId) {
    const ctx = buildContext(Number(compId));
    const results = Results.getCompetitionResults(ctx.comp.id);
    const finalPlaces = new Map(results.map(r => [r.competitor_id, r.place]));

    const w = new XmlWriter();
    const root = rootAttrs(ctx);
    w.open('CompetitionIndividuelle', root);

    w.open('Tireurs');
    const isFie = root.Championnat === 'FIE';
    for (const c of ctx.competitors) {
      w.empty('Tireur', {
        ID: ctx.fencerId(c),
        Nom: c.last_name,
        Prenom: c.first_name,
        Sexe: c.gender,
        DateNaissance: fieDate(c.date_of_birth),
        Lateralite: lateralite(c.handedness),
        Nation: c.nationality,
        Club: isFie ? null : c.club_name,
        Licence: c.fie_licence,
        RangInitial: c.seeding_position,
        Classement: finalPlaces.get(c.id),
      });
    }
    w.close('Tireurs');

    w.open('Arbitres');
    const weaponGrade = { foil: 'CategorieFleuret', epee: 'CategorieEpee', sabre: 'CategorieSabre' }[ctx.comp.weapon];
    const byName = (a, b) => (a.last_name || '').localeCompare(b.last_name || '') || (a.first_name || '').localeCompare(b.first_name || '');
    for (const r of [...ctx.referees].sort(byName)) {
      // FIE grades referees A/B/C; Atlas's free-text level is only passed on when it is one.
      const grade = /^[ABC]$/i.test(String(r.level || '').trim()) ? String(r.level).trim().toUpperCase() : null;
      w.empty('Arbitre', {
        ID: ctx.refId(r.id),
        Nom: r.last_name,
        Prenom: r.first_name,
        Sexe: ['M', 'F'].includes(r.gender) ? r.gender : null,
        Nation: r.nationality,
        DateNaissance: fieDate(r.date_of_birth),
        Club: isFie ? null : r.club_name,
        Categorie: grade,
        ...(weaponGrade ? { [weaponGrade]: grade } : {}),
      });
    }
    w.close('Arbitres');

    w.open('Phases');
    ctx.phases.forEach((ph, i) => (ph.type === 'pool'
      ? Phases.writeTourDePoules(w, ctx, ph, i + 1)
      : Phases.writePhaseDeTableaux(w, ctx, ph, i + 1, finalPlaces)));
    w.close('Phases');

    w.close('CompetitionIndividuelle');

    const safe = String(ctx.comp.code || ctx.comp.name || 'competition').replace(/[^A-Za-z0-9_-]+/g, '_');
    return { xml: w.toString(), filename: `${root.ID}-RESULTS_${safe}.xml` };
  },
};

module.exports = FieExport;
