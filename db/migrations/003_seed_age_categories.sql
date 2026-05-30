-- Migration 003 — Seed standard FIE age categories
-- age = competition_year - birth_year
-- INSERT OR IGNORE is safe to re-run.

INSERT OR IGNORE INTO age_categories (code, label, min_age, max_age, federation, notes) VALUES
  ('U11',    'Under 11',  NULL, 10,   'FIE', 'Pupil / Poussin'),
  ('U13',    'Under 13',  NULL, 12,   'FIE', 'Minime / Benjamin'),
  ('U15',    'Under 15',  NULL, 14,   'FIE', 'Cadet junior'),
  ('U17',    'Under 17',  NULL, 16,   'FIE', 'Cadet'),
  ('U20',    'Under 20',  NULL, 19,   'FIE', 'Junior'),
  ('Senior', 'Senior',    NULL, NULL, 'FIE', 'No age restriction'),
  ('Veteran','Veteran',   40,   NULL, 'FIE', '40 years and older');
