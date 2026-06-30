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
const session  = require('express-session');
const { migrate } = require('./db/migrator');

migrate();

const Settings    = require('./services/settings');
const SQLiteStore = require('./lib/sessionStore');
const auth        = require('./middleware/auth');
const OPP2        = require('./lib/opp2Client');
const _brokerUrl = Settings.get('opp2_broker_url');
if (_brokerUrl) {
  OPP2.connect(_brokerUrl)
    .then(() => console.log('[OPP2] Auto-connected on startup'))
    .catch(e => console.error('[OPP2] Auto-connect failed:', e.message));
}

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.text({ type: ['text/csv', 'text/plain'] }));

app.use(session({
  store:             new SQLiteStore(),
  secret:            process.env.SESSION_SECRET || 'dev-secret-change-in-production',
  resave:            false,
  saveUninitialized: false,
  cookie:            { httpOnly: true, sameSite: 'lax', maxAge: 12 * 60 * 60 * 1000 },
}));
app.use(auth.attach);

app.use(express.static(path.join(__dirname, 'public')));

// Auth routes (public — no role required)
app.use('/api/auth', require('./routes/auth'));

// Middleware: pass GETs through; require a minimum role for mutations.
function writeOnly(role) {
  return (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    return auth.require(role)(req, res, next);
  };
}

// API routes
app.use('/api/people',       writeOnly('assistant'), require('./routes/people'));
app.use('/api/clubs',        writeOnly('assistant'), require('./routes/clubs'));
app.use('/api/nocs',         writeOnly('assistant'), require('./routes/nocs'));
app.use('/api/age-categories', writeOnly('director'), require('./routes/ageCategories'));
app.use('/api/tournaments',  writeOnly('director'),  require('./routes/tournaments'));
app.use('/api/competitions', writeOnly('director'),  require('./routes/competitions'));
app.use('/api/competitions/:compId/competitors', writeOnly('director'), require('./routes/competitors'));
app.use('/api/competitions/:compId/phases',      writeOnly('director'), require('./routes/phases'));
app.use('/api/competitions/:compId/teams',       writeOnly('director'), require('./routes/teams'));
app.use('/api/phases', writeOnly('director'), require('./routes/phasesById'));
app.use('/api/pools',  writeOnly('director'), require('./routes/pools'));
app.use('/api/bouts',  writeOnly('director'), require('./routes/bouts'));
app.use('/api/rules',   require('./routes/rules'));
app.use('/api/formats', require('./routes/formats'));
app.use('/api/strips', writeOnly('director'), require('./routes/strips'));
app.use('/api/opp2',     writeOnly('director'), require('./routes/opp2'));
app.use('/api/settings', writeOnly('director'), require('./routes/settings'));
app.use('/api/users',    auth.require('admin'), require('./routes/users'));
app.use('/api/fie',    writeOnly('director'), require('./routes/fieImport'));
app.use('/api',        writeOnly('director'), require('./routes/teamMatches'));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`Atlas Competition Manager — http://localhost:${PORT}`);
});
