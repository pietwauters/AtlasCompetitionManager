'use strict';
// Formatting primitives for the FIE XML exchange format (docs/FIE_XML/) —
// shared by services/fieExport.js and services/fieExportPhases.js.

function esc(v) {
  return String(v)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Attributes whose value is null/undefined/'' are omitted — the spec says
// "omitted if unknown" throughout, never an empty string.
function attrs(obj) {
  return Object.entries(obj)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
}

class XmlWriter {
  constructor() { this.lines = []; this.depth = 0; }
  _pad() { return '  '.repeat(this.depth); }
  empty(tag, a = {}) { this.lines.push(`${this._pad()}<${tag}${attrs(a)}/>`); }
  open(tag, a = {}) { this.lines.push(`${this._pad()}<${tag}${attrs(a)}>`); this.depth++; }
  close(tag) { this.depth--; this.lines.push(`${this._pad()}</${tag}>`); }
  toString() { return '<?xml version="1.0" encoding="UTF-8"?>\n' + this.lines.join('\n') + '\n'; }
}

// ISO YYYY-MM-DD → DD.MM.YYYY
function fieDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  return m ? `${m[3]}.${m[2]}.${m[1]}` : null;
}

function fieNow() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function heure(t) {
  const m = /^(\d{1,2}):(\d{2})/.exec(t || '');
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
}

function stripLabel(row) {
  if (!row) return null;
  return row.strip_name || (row.strip_number != null ? String(row.strip_number) : null);
}

function lateralite(h) {
  return h === 'L' ? 'G' : h === 'R' ? 'D' : null;
}

// An FIE file must carry the FIE database IDs it was given (fie_id), but
// Atlas-only entries have none. Fall back to the local row id, prefixed only
// when some entries do carry fie_ids, so the two numbering spaces can't collide.
function makeIdFn(rows, prefix) {
  const anyFie = rows.some(r => r.fie_id);
  return r => (r.fie_id ? String(r.fie_id) : anyFie ? `${prefix}${r.id}` : String(r.id));
}

function powerOfTwoAtLeast(n) {
  let t = 2;
  while (t < n) t *= 2;
  return t;
}

module.exports = {
  esc, attrs, XmlWriter, fieDate, fieNow, heure, stripLabel, lateralite, makeIdFn, powerOfTwoAtLeast,
};
