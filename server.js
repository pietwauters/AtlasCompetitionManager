'use strict';

const express = require('express');
const session = require('express-session');
const path    = require('path');
const fs      = require('fs');

// ---------------------------------------------------------------------------
// Config — override via environment variables or a .env file loaded externally
// ---------------------------------------------------------------------------
const PORT        = process.env.PORT        || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me-in-production';


const app = express();

// Set up EJS as the view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 8 * 60 * 60 * 1000   // 8 hours
  }
}));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Routes — stub placeholders, will be fleshed out per domain
// ---------------------------------------------------------------------------
// Health check (no auth required — useful for deployment monitoring)
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});


// Strips API
app.use('/api/strips', require('./routes/strips'));

// Domain route modules
app.use('/api/competitions', require('./routes/competitions'));
app.use('/api/competitions/:compId/results', require('./routes/results'));
app.use('/api/competitions/:compId/fencers', require('./routes/fencers'));
app.use('/api/competitions/:compId/phases',  require('./routes/phases'));
// Strips management page
app.get('/strips', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'strips.html')));

// Resources page
app.get('/resources', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'resources.html')));

// Serve overall results page per competition
app.get('/competitions/:id/results', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'results.html'));
});

// Rules catalogue — list available rule JSON files
app.get('/api/rules', (_req, res) => {
  const rulesDir = path.join(__dirname, 'rules');
  const files = fs.readdirSync(rulesDir)
    .filter(f => f.endsWith('.json') && !f.startsWith('rule-schema') && f !== 'categories.json');
  const rules = files.map(filename => {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(rulesDir, filename), 'utf8'));
      return { filename, id: data.id, description: data.description, type: data.type };
    } catch {
      return { filename, id: filename, description: filename, type: 'unknown' };
    }
  });
  res.json(rules);
});

// Serve individual rule JSON file by filename
app.get('/api/rules/:filename', (req, res) => {
  const rulesDir = path.join(__dirname, 'rules');
  const filename = req.params.filename;
  // Prevent directory traversal
  if (!/^[\w.-]+\.json$/.test(filename)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const filePath = path.join(rulesDir, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Rule file not found' });
  }
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to read rule file' });
  }
});

// Categories catalogue
app.get('/api/categories', (_req, res) => {
  const { listCategories } = require('./lib/categories');
  res.json(listCategories());
});

// Page routes — serve HTML for each section
app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/competitions',                          (_req, res) => res.sendFile(path.join(__dirname, 'public', 'competitions.html')));
app.get('/competitions/:id',                      (_req, res) => res.sendFile(path.join(__dirname, 'public', 'competition-detail.html')));
app.get('/competitions/:id/fencers',              (_req, res) => res.sendFile(path.join(__dirname, 'public', 'fencers.html')));
app.get('/competitions/:id/fencers/roster',        (_req, res) => res.sendFile(path.join(__dirname, 'public', 'fencer-roster.html')));
const phasesRouter = require('./routes/phases');
app.use('/competitions/:compId/phases', phasesRouter);

// Stubs (to be added as slices)
// app.use('/api/resources',    require('./routes/resources'));
// app.use('/api/auth',         require('./routes/auth'));

// Tournament management API
app.use('/api/tournaments', require('./routes/tournaments'));

// Serve the tournaments management page
app.get('/tournaments', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'tournaments.html')));

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`AtlasCompetitionManager running on http://localhost:${PORT}`);
});

// Global error handler — always return JSON for errors
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(err.status || 500);
  res.type('application/json');
  res.json({ error: err.message || 'Internal Server Error' });
});

app.use('/api/mdns', require('./routes/mdns'));
app.use('/api/resolve', require('./routes/resolve'));
app.use('/api/config', require('./routes/config'));
