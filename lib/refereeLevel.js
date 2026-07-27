'use strict';

// Best-effort ordering for the free-text `referees.level` field, used by
// "auto-rank by level" on a tournament/competition referee roster.
//
// Real FIE Engarde export data (docs/GP/*.xml `Categorie`/`CategorieFleuret`
// attributes) grades referees with a per-weapon letter: A (highest,
// international) / B / C — every referee in the sample Grand Prix files is
// "B", so the full scale isn't confirmed from that data alone, just the
// letter convention. This app's own `referees.level` is free text
// (`people.html`'s placeholder is literally "National, International…"), and
// existing seed data instead uses numeric strings ("1.0".."4.0", lower
// number = better grade — the common domestic-federation convention). There
// is no single authoritative source for both conventions at once, so this
// treats letter grades (A/B/C) as ranking above any numeric grade, numeric
// grades ascending (1 best), and anything else/blank last.
function levelTier(level) {
  if (!level) return [2, 0];
  const s = String(level).trim().toUpperCase();
  if (/^[A-C]$/.test(s)) return [0, s.charCodeAt(0)];
  const n = parseFloat(s);
  if (!Number.isNaN(n)) return [1, n];
  return [2, 0];
}

function compareByLevel(levelA, levelB) {
  const [tierA, numA] = levelTier(levelA);
  const [tierB, numB] = levelTier(levelB);
  if (tierA !== tierB) return tierA - tierB;
  return numA - numB;
}

module.exports = { compareByLevel };
