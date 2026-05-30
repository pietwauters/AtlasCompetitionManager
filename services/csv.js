'use strict';

// Lightweight CSV parser and generator.
// Handles quoted fields (commas, double-quotes, newlines inside quotes).

const Csv = {
  // Parse CSV text → array of row objects keyed by the header row.
  parse(text) {
    const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim().split('\n');
    if (lines.length < 2) return [];

    const headers = this._splitLine(lines[0]).map(h => h.trim().toLowerCase());
    const rows = [];

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const values = this._splitLine(line);
      const row = {};
      headers.forEach((h, j) => { row[h] = (values[j] ?? '').trim(); });
      rows.push(row);
    }
    return rows;
  },

  // Generate CSV text from an array of row objects.
  // columns: array of { key, header } or plain strings (key = header)
  generate(rows, columns) {
    const cols = columns.map(c => typeof c === 'string' ? { key: c, header: c } : c);
    const header = cols.map(c => this._quote(c.header)).join(',');
    const lines  = rows.map(row =>
      cols.map(c => this._quote(String(row[c.key] ?? ''))).join(',')
    );
    return [header, ...lines].join('\r\n');
  },

  _quote(value) {
    const s = String(value ?? '');
    return (s.includes(',') || s.includes('"') || s.includes('\n'))
      ? '"' + s.replace(/"/g, '""') + '"'
      : s;
  },

  _splitLine(line) {
    const fields = [];
    let i = 0;
    while (i <= line.length) {
      if (line[i] === '"') {
        let field = '';
        i++;
        while (i < line.length) {
          if (line[i] === '"' && line[i + 1] === '"') { field += '"'; i += 2; }
          else if (line[i] === '"')                    { i++; break; }
          else                                          { field += line[i++]; }
        }
        fields.push(field);
        if (line[i] === ',') i++;
      } else {
        const end = line.indexOf(',', i);
        if (end === -1) { fields.push(line.slice(i)); break; }
        fields.push(line.slice(i, end));
        i = end + 1;
      }
    }
    return fields;
  },
};

module.exports = Csv;
