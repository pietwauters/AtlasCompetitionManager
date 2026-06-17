'use strict';
const db = require('../db');

// ---------------------------------------------------------------------------
// Minimal XML parser — handles the two FIE document formats:
//   1. <Element ATTR="val" .../> (self-closing with attributes) — Tireur, Coach
//   2. <Element><Field>text</Field>...</Element>   — Accreditation
// ---------------------------------------------------------------------------

function parseAttrs(str) {
  const out = {};
  const re  = /(\w+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(str)) !== null) out[m[1]] = m[2];
  return out;
}

function parseRootAttrs(xml) {
  const m = xml.match(/<\w+\s+([^>]+?)(?:\s*\/?>)/);
  return m ? parseAttrs(m[1]) : {};
}

// Matches both self-closing (<Tag ATTRS />) and empty-body (<Tag ATTRS></Tag>).
function parseSelfClosing(xml, tag) {
  const re = new RegExp(`<${tag}\\s+([^>]+?)\\s*(?:/>|></(?:${tag})>)`, 'g');
  const items = [];
  let m;
  while ((m = re.exec(xml)) !== null) items.push(parseAttrs(m[1]));
  return items;
}

function parseAccreditations(xml) {
  const re   = /<Accreditation>([\s\S]*?)<\/Accreditation>/g;
  const items = [];
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const item  = {};
    const tagRe = /<(\w+)>([^<]*)<\/\1>/g;
    let t;
    while ((t = tagRe.exec(block)) !== null) item[t[1]] = t[2].trim();
    items.push(item);
  }
  return items;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WEAPON_MAP = { F: 'foil', E: 'epee', S: 'sabre' };

// FIE date DD.MM.YYYY → YYYY-MM-DD
function toIso(d) {
  if (!d) return null;
  const [dd, mm, yyyy] = d.split('.');
  if (!dd || !mm || !yyyy) return null;
  return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}

// Classement "9999" or missing → NULL (unranked)
function toPosition(raw) {
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return (isNaN(n) || n >= 9999) ? null : n;
}

// Points "11.500" → 11.5  (European decimal notation, standard float)
function toPoints(raw) {
  if (!raw) return null;
  const n = parseFloat(raw);
  return isNaN(n) ? null : n;
}

// Lateralite G(auche)/D(roite) → L/R
function toHandedness(raw) {
  if (raw === 'G') return 'L';
  if (raw === 'D') return 'R';
  return null;
}

// ---------------------------------------------------------------------------
// Core import
// ---------------------------------------------------------------------------

const findOrCreateTournament = db.transaction((championship, titreLong, season, federation) => {
  const existing = db.prepare(`
    SELECT id FROM tournaments
    WHERE championship = ? AND name = ? AND fie_season = ?
    LIMIT 1
  `).get(championship, titreLong, season);
  if (existing) return existing.id;

  const { lastInsertRowid } = db.prepare(`
    INSERT INTO tournaments (name, championship, fie_season, organizing_federation, status)
    VALUES (@name, @championship, @season, @federation, 'open')
  `).run({ name: titreLong, championship, season, federation });
  return lastInsertRowid;
});

const findOrCreateCompetition = db.transaction((tournamentId, attrs, weapon) => {
  if (attrs.ID) {
    const existing = db.prepare('SELECT id FROM competitions WHERE fie_id = ?').get(Number(attrs.ID));
    if (existing) return existing.id;
  }

  const { lastInsertRowid } = db.prepare(`
    INSERT INTO competitions
      (tournament_id, name, weapon, gender, date, fie_id, seeding_issuer, status)
    VALUES
      (@tournament_id, @name, @weapon, @gender, @date, @fie_id, @seeding_issuer, 'draft')
  `).run({
    tournament_id:   tournamentId,
    name:            attrs.TitreLong || '',
    weapon,
    gender:          attrs.Sexe || 'M',
    date:            toIso(attrs.Date),
    fie_id:          attrs.ID ? Number(attrs.ID) : null,
    seeding_issuer:  attrs.Championnat || null,
  });
  return lastInsertRowid;
});

// Upsert a single Tireur into competitors for a given competition.
// Returns 'created' | 'updated'.
function upsertTireur(competitionId, t, championship) {
  const fie_id          = t.ID ? Number(t.ID) : null;
  const seeding_position = toPosition(t.Classement);

  if (fie_id) {
    const existing = db.prepare(
      'SELECT id FROM competitors WHERE competition_id = ? AND fie_id = ?'
    ).get(competitionId, fie_id);

    if (existing) {
      db.prepare(`
        UPDATE competitors SET
          last_name = @last_name, first_name = @first_name,
          date_of_birth = @date_of_birth, gender = @gender,
          nationality = @nationality, handedness = @handedness,
          fie_licence = @fie_licence,
          seeding_position = @seeding_position,
          seeding_points   = @seeding_points,
          seeding_issuer   = @seeding_issuer
        WHERE id = @id
      `).run({
        id:               existing.id,
        last_name:        t.Nom        || null,
        first_name:       t.Prenom     || null,
        date_of_birth:    toIso(t.DateNaissance),
        gender:           t.Sexe       || null,
        nationality:      t.Nation     || null,
        handedness:       toHandedness(t.Lateralite),
        fie_licence:      t.Licence    || null,
        seeding_position,
        seeding_points:   toPoints(t.Points),
        seeding_issuer:   championship || null,
      });
      return 'updated';
    }
  }

  db.prepare(`
    INSERT INTO competitors
      (competition_id, last_name, first_name, date_of_birth, gender,
       nationality, fie_id, handedness, fie_licence,
       seeding_position, seeding_points, seeding_issuer, status)
    VALUES
      (@competition_id, @last_name, @first_name, @date_of_birth, @gender,
       @nationality, @fie_id, @handedness, @fie_licence,
       @seeding_position, @seeding_points, @seeding_issuer, 'active')
  `).run({
    competition_id:   competitionId,
    last_name:        t.Nom        || null,
    first_name:       t.Prenom     || null,
    date_of_birth:    toIso(t.DateNaissance),
    gender:           t.Sexe       || null,
    nationality:      t.Nation     || null,
    fie_id,
    handedness:       toHandedness(t.Lateralite),
    fie_licence:      t.Licence    || null,
    seeding_position,
    seeding_points:   toPoints(t.Points),
    seeding_issuer:   championship || null,
  });
  return 'created';
}

// After all tireurs are imported, assign initial_seed 1..N by seeding_position.
function assignInitialSeeds(competitionId) {
  const rows = db.prepare(`
    SELECT id FROM competitors
    WHERE competition_id = ? AND status = 'active'
    ORDER BY CASE WHEN seeding_position IS NULL THEN 1 ELSE 0 END,
             seeding_position ASC, last_name, first_name
  `).all(competitionId);

  const upd = db.prepare('UPDATE competitors SET initial_seed = ? WHERE id = ?');
  db.transaction(() => {
    rows.forEach((r, i) => upd.run(i + 1, r.id));
  })();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const FieImport = {
  // Import a BaseCompetitionIndividuelle XML (fencers file).
  // tournamentId: optional — attach to existing tournament instead of auto-creating.
  // Returns { tournament_id, competition_id, created, updated, skipped, warnings }.
  importFencers(xmlText, tournamentId = null) {
    const root    = parseRootAttrs(xmlText);
    const tireurs = parseSelfClosing(xmlText, 'Tireur');

    const weapon = WEAPON_MAP[root.Arme];
    if (!weapon) {
      throw Object.assign(
        new Error(`Unknown weapon code "${root.Arme}". Expected F, E or S.`),
        { status: 400 }
      );
    }

    const championship = root.Championnat || null;
    const season       = root.Annee       || null;
    const federation   = root.Federation  || null;
    const titreLong    = root.TitreLong   || 'Unnamed';

    const result = { tournament_id: null, competition_id: null, created: 0, updated: 0, skipped: 0, warnings: [] };

    db.transaction(() => {
      result.tournament_id = tournamentId
        ?? findOrCreateTournament(championship, titreLong, season, federation);

      result.competition_id = findOrCreateCompetition(result.tournament_id, root, weapon);

      for (const t of tireurs) {
        try {
          const action = upsertTireur(result.competition_id, t, championship);
          result[action]++;
        } catch (e) {
          result.skipped++;
          result.warnings.push(`Tireur ${t.ID} (${t.Nom} ${t.Prenom}): ${e.message}`);
        }
      }

      assignInitialSeeds(result.competition_id);
    })();

    return result;
  },

  // Detect document type and dispatch to the right handler.
  // Returns the same shape as importFencers.
  importXml(xmlText, tournamentId = null) {
    if (/<BaseCompetitionIndividuelle/.test(xmlText)) {
      return this.importFencers(xmlText, tournamentId);
    }
    throw Object.assign(
      new Error('Unrecognised FIE XML document type. Only BaseCompetitionIndividuelle is currently supported.'),
      { status: 400 }
    );
  },
};

module.exports = FieImport;
