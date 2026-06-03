'use strict';

// Load .env file into process.env if it exists (no dependency needed)
const fs = require('fs');
const envPath = require('path').join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  });
}

const express  = require('express');
const path     = require('path');
const { migrate } = require('./db/migrator');

migrate();

const Settings = require('./services/settings');
const OPP2     = require('./lib/opp2Client');
if (Settings.get('opp2_enabled') === '1') {
  OPP2.connect(Settings.get('opp2_broker_url'))
    .then(() => console.log('[OPP2] Auto-connected on startup'))
    .catch(e => console.error('[OPP2] Auto-connect failed:', e.message));
}

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.text({ type: ['text/csv', 'text/plain'] }));  // for CSV import
app.use(express.static(path.join(__dirname, 'public')));

// API routes
app.use('/api/people',       require('./routes/people'));
app.use('/api/clubs',        require('./routes/clubs'));
app.use('/api/nocs',         require('./routes/nocs'));
app.use('/api/age-categories', require('./routes/ageCategories'));
app.use('/api/tournaments',  require('./routes/tournaments'));
app.use('/api/competitions', require('./routes/competitions'));
app.use('/api/competitions/:compId/competitors', require('./routes/competitors'));
app.use('/api/competitions/:compId/phases',    require('./routes/phases'));
app.use('/api/phases', require('./routes/phasesById'));
app.use('/api/pools',  require('./routes/pools'));
app.use('/api/bouts',  require('./routes/bouts'));
app.use('/api/rules',  require('./routes/rules'));
app.use('/api/strips', require('./routes/strips'));
app.use('/api/opp2',  require('./routes/opp2'));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`Atlas Competition Manager — http://localhost:${PORT}`);
});
