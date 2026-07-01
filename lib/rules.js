'use strict';

const fs   = require('fs');
const path = require('path');

const RULES_DIR = path.join(__dirname, '..', 'rules');

const ruleCache = new Map();

function loadRule(filename) {
  if (ruleCache.has(filename)) return ruleCache.get(filename);
  const safe = path.basename(filename);          // prevent path traversal
  const full = path.join(RULES_DIR, safe);
  if (!fs.existsSync(full)) throw new Error(`Rule file not found: ${filename}`);
  const rule = JSON.parse(fs.readFileSync(full, 'utf8'));
  ruleCache.set(filename, rule);
  return rule;
}

function listRules(type = null) {
  return fs.readdirSync(RULES_DIR)
    .filter(f => f.endsWith('.json') && !f.includes('schema') && !f.includes('categories'))
    .map(f => {
      try {
        const rule = JSON.parse(fs.readFileSync(path.join(RULES_DIR, f), 'utf8'));
        return { filename: f, id: rule.id, description: rule.description, type: rule.type };
      } catch { return null; }
    })
    .filter(r => r && (!type || r.type === type))
    .sort((a, b) => a.description.localeCompare(b.description));
}

module.exports = { loadRule, listRules };
