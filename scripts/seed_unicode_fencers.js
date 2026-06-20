'use strict';
// seed_unicode_fencers.js
// Inserts a small set of fencers with non-Latin names to verify Unicode support.
// Safe to run multiple times — skips any name that already exists.

const db = require('../db');

const fencers = [
  // Chinese
  { first_name: '伟',      last_name: '王',      gender: 'M', nationality: 'CHN', script: 'Chinese' },
  { first_name: '芳',      last_name: '李',      gender: 'F', nationality: 'CHN', script: 'Chinese' },
  // Cyrillic (Russian)
  { first_name: 'Иван',    last_name: 'Петров',  gender: 'M', nationality: 'RUS', script: 'Cyrillic' },
  { first_name: 'Наталья', last_name: 'Иванова', gender: 'F', nationality: 'RUS', script: 'Cyrillic' },
  // Hebrew
  { first_name: 'יוסף',   last_name: 'כהן',     gender: 'M', nationality: 'ISR', script: 'Hebrew' },
  { first_name: 'מרים',   last_name: 'לוי',     gender: 'F', nationality: 'ISR', script: 'Hebrew' },
  // Arabic
  { first_name: 'محمد',   last_name: 'العلي',   gender: 'M', nationality: 'EGY', script: 'Arabic' },
  { first_name: 'فاطمة',  last_name: 'حسن',     gender: 'F', nationality: 'EGY', script: 'Arabic' },
  // Thai
  { first_name: 'สมชาย',  last_name: 'ศรีสวัสดิ์', gender: 'M', nationality: 'THA', script: 'Thai' },
  { first_name: 'สุภา',   last_name: 'ทองดี',   gender: 'F', nationality: 'THA', script: 'Thai' },
  // Greek
  { first_name: 'Νίκος',  last_name: 'Παπαδόπουλος', gender: 'M', nationality: 'GRE', script: 'Greek' },
  // Japanese (mixed kanji + kana)
  { first_name: '太郎',   last_name: '山田',     gender: 'M', nationality: 'JPN', script: 'Japanese' },
  { first_name: 'はな',   last_name: '田中',     gender: 'F', nationality: 'JPN', script: 'Japanese' },
  // Korean
  { first_name: '민준',   last_name: '김',       gender: 'M', nationality: 'KOR', script: 'Korean' },
  // Georgian
  { first_name: 'გიორგი', last_name: 'კვარაცხელია', gender: 'M', nationality: 'GEO', script: 'Georgian' },
];

let inserted = 0, skipped = 0;

for (const f of fencers) {
  const exists = db.prepare(
    'SELECT id FROM people WHERE first_name = ? AND last_name = ?'
  ).get(f.first_name, f.last_name);

  if (exists) { skipped++; continue; }

  const { lastInsertRowid: personId } = db.prepare(
    'INSERT INTO people (first_name, last_name, gender, nationality) VALUES (?, ?, ?, ?)'
  ).run(f.first_name, f.last_name, f.gender, f.nationality);

  db.prepare(
    'INSERT INTO fencers (person_id, weapons, handedness) VALUES (?, ?, ?)'
  ).run(personId, JSON.stringify(['foil', 'epee', 'sabre']), 'R');

  console.log(`  [${f.script}]  ${f.last_name} ${f.first_name}  (${f.nationality})`);
  inserted++;
}

console.log(`\nDone — ${inserted} inserted, ${skipped} already existed.`);
