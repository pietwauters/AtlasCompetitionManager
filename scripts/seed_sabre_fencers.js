'use strict';
const db = require('../db');

// 50 sabre fencers: 40M / 10F
// Age spread: U11(3), U13(4), U15(4), U17(5), U20(5), Senior(15), Veteran(12, born ≤1985)
// Veterans: ~30% with 2nd weapon, ~10% with 3rd weapon

const clubIds = [1, 2, 3, 4, 5, 6, 7, 8];

const fencers = [
  // --- U11 (born 2016-2017) ---
  { fn:'Axel',    ln:'Maes',         dob:'2016-03-12', gender:'M', club:1, ranking:8  },
  { fn:'Noah',    ln:'Claes',        dob:'2017-07-04', gender:'M', club:3, ranking:15 },
  { fn:'Zoe',     ln:'Fontaine',     dob:'2016-11-20', gender:'F', club:2, ranking:4  },

  // --- U13 (born 2014-2015) ---
  { fn:'Liam',    ln:'Vandenberghe', dob:'2015-02-18', gender:'M', club:4, ranking:3  },
  { fn:'Hugo',    ln:'Pirard',       dob:'2014-09-05', gender:'M', club:6, ranking:11 },
  { fn:'Tom',     ln:'Goossens',     dob:'2015-05-22', gender:'M', club:1, ranking:19 },
  { fn:'Lucie',   ln:'Gosselin',     dob:'2014-12-01', gender:'F', club:5, ranking:7  },

  // --- U15 (born 2012-2013) ---
  { fn:'Arthur',  ln:'Vermeersch',   dob:'2013-04-14', gender:'M', club:2, ranking:2  },
  { fn:'Mathis',  ln:'De Smet',      dob:'2012-08-30', gender:'M', club:7, ranking:10 },
  { fn:'Ruben',   ln:'Libert',       dob:'2013-01-09', gender:'M', club:3, ranking:22 },
  { fn:'Emma',    ln:'Charlier',     dob:'2012-06-25', gender:'F', club:4, ranking:6  },

  // --- U17 (born 2010-2011) ---
  { fn:'Lucas',   ln:'Peeters',      dob:'2011-03-03', gender:'M', club:5, ranking:1  },
  { fn:'Nathan',  ln:'Jacobs',       dob:'2010-10-17', gender:'M', club:1, ranking:9  },
  { fn:'Victor',  ln:'Nijs',         dob:'2011-07-28', gender:'M', club:6, ranking:17 },
  { fn:'Théo',    ln:'Willems',      dob:'2010-04-06', gender:'M', club:8, ranking:24 },
  { fn:'Camille', ln:'Bastin',       dob:'2011-12-14', gender:'F', club:2, ranking:5  },

  // --- U20 (born 2007-2009) ---
  { fn:'Jules',   ln:'Declercq',     dob:'2008-05-19', gender:'M', club:3, ranking:13 },
  { fn:'Simon',   ln:'Lambert',      dob:'2007-11-02', gender:'M', club:7, ranking:20 },
  { fn:'Ethan',   ln:'Bogaert',      dob:'2009-02-27', gender:'M', club:4, ranking:28 },
  { fn:'Maxime',  ln:'Renard',       dob:'2008-08-11', gender:'M', club:1, ranking:33 },
  { fn:'Sophie',  ln:'Leclercq',     dob:'2007-06-30', gender:'F', club:5, ranking:12 },

  // --- Senior (born 1990-2005) ---
  { fn:'Thomas',  ln:'Mertens',      dob:'2002-01-15', gender:'M', club:2, ranking:14 },
  { fn:'Antoine', ln:'De Wolf',      dob:'1998-07-22', gender:'M', club:6, ranking:16 },
  { fn:'Louis',   ln:'Smeets',       dob:'2000-09-08', gender:'M', club:3, ranking:18 },
  { fn:'Nicolas', ln:'Paulissen',    dob:'1995-03-30', gender:'M', club:1, ranking:21 },
  { fn:'Romain',  ln:'Moreau',       dob:'1999-11-14', gender:'M', club:7, ranking:23 },
  { fn:'Baptiste',ln:'Collignon',    dob:'1997-05-05', gender:'M', club:4, ranking:25 },
  { fn:'Julien',  ln:'Leroy',        dob:'2003-08-18', gender:'M', club:8, ranking:26 },
  { fn:'Pieter',  ln:'Van Acker',    dob:'1993-12-03', gender:'M', club:5, ranking:27 },
  { fn:'Stef',    ln:'Stevens',      dob:'2001-04-20', gender:'M', club:2, ranking:29 },
  { fn:'Jonas',   ln:'Hermans',      dob:'1996-06-09', gender:'M', club:6, ranking:30 },
  { fn:'Karel',   ln:'Dubois',       dob:'1990-10-25', gender:'M', club:3, ranking:31 },
  { fn:'Lars',    ln:'Janssen',      dob:'2004-02-14', gender:'M', club:1, ranking:32 },
  { fn:'Léa',     ln:'Durand',       dob:'2001-07-07', gender:'F', club:4, ranking:34 },
  { fn:'Marie',   ln:'Lefebvre',     dob:'1997-03-19', gender:'F', club:7, ranking:36 },
  { fn:'Clara',   ln:'Gillain',      dob:'2003-09-01', gender:'F', club:2, ranking:38 },

  // --- Veteran (born 1960-1985, age 40+) ---
  // weapons: default sabre; ~30% add 2nd, ~10% add 3rd
  { fn:'Marc',    ln:'Colignon',     dob:'1978-04-11', gender:'M', club:5, ranking:35, extraWeapons:['foil']        },
  { fn:'Jean',    ln:'Mathieu',      dob:'1971-09-24', gender:'M', club:1, ranking:37, extraWeapons:['epee']        },
  { fn:'Philippe',ln:'Bernard',      dob:'1966-01-30', gender:'M', club:3, ranking:39, extraWeapons:['foil','epee'] },
  { fn:'Henri',   ln:'Picard',       dob:'1975-07-16', gender:'M', club:6, ranking:40, extraWeapons:['epee']        },
  { fn:'François',ln:'Nguyên',       dob:'1982-03-08', gender:'M', club:2, ranking:41 },
  { fn:'Michel',  ln:'Klein',        dob:'1969-11-05', gender:'M', club:4, ranking:42 },
  { fn:'Laurent', ln:'Desmet',       dob:'1984-06-22', gender:'M', club:7, ranking:43 },
  { fn:'Patrick', ln:'Dubois',       dob:'1960-08-03', gender:'M', club:8, ranking:44 },
  { fn:'Denis',   ln:'Charlier',     dob:'1977-02-17', gender:'M', club:5, ranking:45 },
  { fn:'Bernard', ln:'Fontaine',     dob:'1963-12-29', gender:'M', club:1, ranking:46 },
  { fn:'Julie',   ln:'Pirard',       dob:'1979-05-14', gender:'F', club:3, ranking:47 },
  { fn:'Manon',   ln:'Renard',       dob:'1984-10-09', gender:'F', club:6, ranking:48, extraWeapons:['foil'] },
];

const insertPerson  = db.prepare(`
  INSERT INTO people (first_name, last_name, date_of_birth, gender, nationality, club_id)
  VALUES (@fn, @ln, @dob, @gender, 'BEL', @club_id)
`);
const insertFencer  = db.prepare(`
  INSERT INTO fencers (person_id, weapons, ranking)
  VALUES (@person_id, @weapons, @ranking)
`);

const insertAll = db.transaction(() => {
  for (const f of fencers) {
    const weapons = ['sabre', ...(f.extraWeapons || [])];
    const { lastInsertRowid: pid } = insertPerson.run({
      fn: f.fn, ln: f.ln, dob: f.dob, gender: f.gender, club_id: f.club,
    });
    insertFencer.run({
      person_id: pid,
      weapons: JSON.stringify(weapons),
      ranking: f.ranking,
    });
  }
});

insertAll();

const count = db.prepare('SELECT COUNT(*) as n FROM fencers').get();
console.log(`Done. Total fencers now: ${count.n}`);
console.log(`Inserted ${fencers.length} sabre fencers.`);
const veterans = fencers.filter(f => parseInt(f.dob) <= 1985);
console.log(`Veterans: ${veterans.length}, with 2nd weapon: ${veterans.filter(f => f.extraWeapons?.length >= 1).length}, with 3rd weapon: ${veterans.filter(f => f.extraWeapons?.length >= 2).length}`);
