'use strict';
// seed_test_population.js
// Populates a fresh Atlas database with realistic Belgian test data:
//   - 8 clubs
//   - 200 fencers (foil/épée/sabre × all age groups × M/F)
//   - 15 referees (9M, 6F, levels 1–4)
//
// Usage:
//   node scripts/seed_test_population.js            # exits if data already exists
//   node scripts/seed_test_population.js --force    # clears people data first

const db = require('../db');

const force = process.argv.includes('--force');

// ---------------------------------------------------------------------------
// Guard: don't overwrite existing data unless --force
// ---------------------------------------------------------------------------
const existing = db.prepare('SELECT COUNT(*) AS n FROM people').get().n;
if (existing > 0 && !force) {
  console.error(`DB already has ${existing} people records. Use --force to clear and repopulate.`);
  process.exit(1);
}

if (force && existing > 0) {
  console.log(`--force: clearing ${existing} existing people records...`);
  db.prepare('DELETE FROM bouts').run();
  db.prepare('DELETE FROM competitors').run();
  db.prepare('DELETE FROM fencers').run();
  db.prepare('DELETE FROM referees').run();
  db.prepare('DELETE FROM people').run();
  db.prepare('DELETE FROM clubs').run();
  console.log('Cleared.');
}

// ---------------------------------------------------------------------------
// Name pools (Belgian: Flemish + Walloon mix)
// ---------------------------------------------------------------------------
const MALE_FIRST = [
  'Lucas','Thomas','Nathan','Mathis','Liam','Antoine','Théo','Arthur','Victor',
  'Martin','Simon','Jules','Maxime','Louis','Hugo','Ethan','Romain','Baptiste',
  'Julien','Nicolas','Sébastien','Marc','Jean','Henri','François','Philippe',
  'Michel','Laurent','Wout','Rémi','Lars','Jonas','Ruben','Pieter','Stef',
  'Karel','Joris','Bram','Noah','Axel',
];

const FEMALE_FIRST = [
  'Emma','Sophie','Léa','Camille','Lucie','Marie','Clara','Sarah','Manon',
  'Julie','Laura','Elisa','Charlotte','Amélie','Nathalie','An','Lies','Katrien',
  'Ellen','Hanne','Jana','Sofie','Noor','Lore','Fien','Axelle','Céline',
  'Aurélie','Virginie','Isabelle','Audrey','Sandrine','Élodie','Laetitia','Nadia',
];

const LAST = [
  'Dupont','Martin','Laurent','Michel','Simon','Leroy','Dubois','Moreau',
  'Lefebvre','Thomas','Petit','Durand','Lambert','Picard','Renard','Maes',
  'De Wolf','Van Den Berg','Janssen','Claes','Mertens','Willems','Stevens',
  'Jacobs','Peeters','De Smet','Nijs','Bogaert','Hermans','Leclercq',
  'Fontaine','Gosselin','Pirard','Charlier','Smeets','Paulissen','Gillain',
  'Colignon','Bastin','Mathieu','Vandenberghe','Vermeersch','Goossens',
  'Van Acker','Declercq','Libert','Nguyen','Klein','Desmet','Wouters',
  'Claeys','Van De Velde','Michiels','Martens','Cools','De Backer','Van Dyck',
  'Aerts','Baert','Claessens','De Cock','Demeester','Geeroms','Helsen',
  'Lemmens','Marien','Nuyts','Pieters','Raes','Thijs','Verhoeven',
  'Lecomte','Bernard','Gilles','Daix','Stiernet','Roland','Nihoul','Joris',
];

// Counters for name picking — ensures unique first+last combos across the full run
let maleCounter   = 0;
let femaleCounter = 0;

function nextName(gender) {
  if (gender === 'M') {
    const first = MALE_FIRST[maleCounter % MALE_FIRST.length];
    const last  = LAST[Math.floor(maleCounter / MALE_FIRST.length) % LAST.length];
    maleCounter++;
    return { first, last };
  }
  const first = FEMALE_FIRST[femaleCounter % FEMALE_FIRST.length];
  const last  = LAST[Math.floor(femaleCounter / FEMALE_FIRST.length) % LAST.length];
  femaleCounter++;
  return { first, last };
}

// ---------------------------------------------------------------------------
// DOB helpers — cycles through days within a year range deterministically
// ---------------------------------------------------------------------------
function makeDob(yearMin, yearMax, index) {
  const years  = yearMax - yearMin + 1;
  const year   = yearMin + (index % years);
  const month  = String((index % 12) + 1).padStart(2, '0');
  const day    = String((index % 28) + 1).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Age group DOB year ranges (competition year 2026).
// Upper bound kept 1 year inside the limit to avoid boundary fencers
// straddling two categories depending on exact birthday.
const AGE_GROUPS = {
  U11:     { min: 2016, max: 2017 },  // age 9–10
  U13:     { min: 2014, max: 2015 },  // age 11–12
  U15:     { min: 2012, max: 2013 },  // age 13–14
  U17:     { min: 2010, max: 2011 },  // age 15–16
  U20:     { min: 2007, max: 2008 },  // age 18–19
  Senior:  { min: 1990, max: 2005 },  // age 21–36
  Veteran: { min: 1958, max: 1985 },  // age 41–68
};

// ---------------------------------------------------------------------------
// Fencer distribution: [weapon, age_group, gender, count]
// Total: foil 70 + épée 80 + sabre 50 = 200
// ---------------------------------------------------------------------------
const GROUPS = [
  // Foil — 70 total (42M, 28F)
  ['foil', 'U11',     'M', 4], ['foil', 'U11',     'F', 2],
  ['foil', 'U13',     'M', 5], ['foil', 'U13',     'F', 3],
  ['foil', 'U15',     'M', 6], ['foil', 'U15',     'F', 4],
  ['foil', 'U17',     'M', 7], ['foil', 'U17',     'F', 4],
  ['foil', 'U20',     'M', 5], ['foil', 'U20',     'F', 3],
  ['foil', 'Senior',  'M', 9], ['foil', 'Senior',  'F', 7],
  ['foil', 'Veteran', 'M', 6], ['foil', 'Veteran', 'F', 5],
  // Épée — 80 total (45M, 35F)
  ['epee', 'U11',     'M', 4], ['epee', 'U11',     'F', 3],
  ['epee', 'U13',     'M', 6], ['epee', 'U13',     'F', 4],
  ['epee', 'U15',     'M', 7], ['epee', 'U15',     'F', 5],
  ['epee', 'U17',     'M', 8], ['epee', 'U17',     'F', 5],
  ['epee', 'U20',     'M', 5], ['epee', 'U20',     'F', 4],
  ['epee', 'Senior',  'M',10], ['epee', 'Senior',  'F', 9],
  ['epee', 'Veteran', 'M', 5], ['epee', 'Veteran', 'F', 5],
  // Sabre — 50 total (35M, 15F)
  ['sabre','U11',     'M', 3], ['sabre','U11',     'F', 1],
  ['sabre','U13',     'M', 4], ['sabre','U13',     'F', 2],
  ['sabre','U15',     'M', 5], ['sabre','U15',     'F', 2],
  ['sabre','U17',     'M', 6], ['sabre','U17',     'F', 2],
  ['sabre','U20',     'M', 4], ['sabre','U20',     'F', 2],
  ['sabre','Senior',  'M', 8], ['sabre','Senior',  'F', 3],
  ['sabre','Veteran', 'M', 5], ['sabre','Veteran', 'F', 3],
];

// Other weapons to add to veterans (cycling)
const OTHER_WEAPONS = {
  foil:  ['epee', 'sabre'],
  epee:  ['foil', 'sabre'],
  sabre: ['foil', 'epee'],
};

// ---------------------------------------------------------------------------
// Referees — 15 total (9M, 6F), levels 1–4
// ---------------------------------------------------------------------------
const REFEREES = [
  { fn:'Bernard',   ln:'Lecomte',    gender:'M', dob:'1975-03-14', level:3 },
  { fn:'Marc',      ln:'Fontaine',   gender:'M', dob:'1982-07-22', level:2 },
  { fn:'Philippe',  ln:'Willems',    gender:'M', dob:'1969-11-05', level:4 },
  { fn:'Thomas',    ln:'Peeters',    gender:'M', dob:'1990-04-18', level:2 },
  { fn:'Luc',       ln:'De Smet',    gender:'M', dob:'1978-09-30', level:3 },
  { fn:'François',  ln:'Charlier',   gender:'M', dob:'1985-01-12', level:1 },
  { fn:'Nicolas',   ln:'Vandenberghe',gender:'M',dob:'1993-06-25', level:2 },
  { fn:'Joris',     ln:'Maes',       gender:'M', dob:'1988-12-03', level:1 },
  { fn:'Olivier',   ln:'Lambert',    gender:'M', dob:'1972-08-19', level:3 },
  { fn:'Isabelle',  ln:'Dupont',     gender:'F', dob:'1980-05-07', level:3 },
  { fn:'Sophie',    ln:'Janssen',    gender:'F', dob:'1987-02-14', level:2 },
  { fn:'Nathalie',  ln:'Moreau',     gender:'F', dob:'1971-10-28', level:4 },
  { fn:'Virginie',  ln:'Stevens',    gender:'F', dob:'1995-03-31', level:1 },
  { fn:'An',        ln:'Claes',      gender:'F', dob:'1983-07-09', level:2 },
  { fn:'Katrien',   ln:'De Wolf',    gender:'F', dob:'1991-11-16', level:1 },
];

// ---------------------------------------------------------------------------
// Inserts
// ---------------------------------------------------------------------------
const insertClub    = db.prepare('INSERT INTO clubs (name) VALUES (@name)');
const insertPerson  = db.prepare(`
  INSERT INTO people (first_name, last_name, date_of_birth, gender, nationality, club_id)
  VALUES (@first, @last, @dob, @gender, 'BEL', @club_id)
`);
const insertFencer  = db.prepare(`
  INSERT INTO fencers (person_id, weapons, ranking)
  VALUES (@person_id, @weapons, @ranking)
`);
const insertReferee = db.prepare(`
  INSERT INTO referees (person_id, level)
  VALUES (@person_id, @level)
`);

const run = db.transaction(() => {
  // --- Clubs ---
  const clubNames = [
    'Club Namur','Club Gent','Club Bruxelles','Club Liège',
    'Club Antwerpen','Club Tournai','Club Liège Est','Atlas Fencing',
  ];
  const clubIds = clubNames.map(name => insertClub.run({ name }).lastInsertRowid);
  console.log(`Created ${clubIds.length} clubs.`);

  // --- Fencers ---
  // Track per-weapon ranking counters
  const rankCounter = { foil: 1, epee: 1, sabre: 1 };
  // Track veteran index per weapon for multi-weapon assignment
  const vetIdx = { foil: 0, epee: 0, sabre: 0 };
  let dobIdx = 0;
  let fencerCount = 0;

  for (const [weapon, ageGroup, gender, count] of GROUPS) {
    const { min, max } = AGE_GROUPS[ageGroup];
    const isVeteran = ageGroup === 'Veteran';

    for (let i = 0; i < count; i++) {
      const { first, last } = nextName(gender);
      const dob    = makeDob(min, max, dobIdx++);
      const clubId = clubIds[(fencerCount) % clubIds.length];

      const { lastInsertRowid: pid } = insertPerson.run({
        first, last, dob, gender, club_id: clubId,
      });

      // Weapons: veterans may get extras
      let weapons = [weapon];
      if (isVeteran) {
        const vi = vetIdx[weapon]++;
        const others = OTHER_WEAPONS[weapon];
        if (vi % 10 === 0) {
          // ~10% get a 3rd weapon
          weapons = [weapon, others[0], others[1]];
        } else if (vi % 3 === 0) {
          // ~30% get a 2nd weapon
          weapons = [weapon, others[0]];
        }
      }

      insertFencer.run({
        person_id: pid,
        weapons:   JSON.stringify(weapons),
        ranking:   rankCounter[weapon]++,
      });

      fencerCount++;
    }
  }

  console.log(`Created ${fencerCount} fencers.`);

  // --- Referees ---
  for (const r of REFEREES) {
    const clubId = clubIds[REFEREES.indexOf(r) % clubIds.length];
    const { lastInsertRowid: pid } = insertPerson.run({
      first: r.fn, last: r.ln, dob: r.dob, gender: r.gender, club_id: clubId,
    });
    insertReferee.run({ person_id: pid, level: r.level });
  }

  console.log(`Created ${REFEREES.length} referees.`);
});

run();

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
const totals = db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM people)   AS people,
    (SELECT COUNT(*) FROM fencers)  AS fencers,
    (SELECT COUNT(*) FROM referees) AS referees
`).get();

const byWeapon = db.prepare(`
  SELECT json_each.value AS weapon, COUNT(*) AS n
  FROM fencers, json_each(fencers.weapons)
  WHERE json_each.value IN ('foil','epee','sabre')
  GROUP BY json_each.value
`).all();

const byGender = db.prepare(`
  SELECT p.gender, COUNT(*) AS n
  FROM people p JOIN fencers f ON f.person_id = p.id
  GROUP BY p.gender
`).all();

console.log('\n=== Test population summary ===');
console.log(`People   : ${totals.people}`);
console.log(`Fencers  : ${totals.fencers}`);
console.log(`Referees : ${totals.referees}`);
console.log('By weapon:', byWeapon.map(r => `${r.weapon}:${r.n}`).join('  '));
console.log('By gender:', byGender.map(r => `${r.gender}:${r.n}`).join('  '));
