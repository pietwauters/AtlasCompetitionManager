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

// Domain route modules
app.use('/api/competitions', require('./routes/competitions'));
app.use('/api/competitions/:compId/fencers', require('./routes/fencers'));

// Page routes — serve HTML for each section
app.get('/competitions',           (_req, res) => res.sendFile(path.join(__dirname, 'public', 'competitions.html')));
app.get('/competitions/:id',       (_req, res) => res.sendFile(path.join(__dirname, 'public', 'competition-detail.html')));
app.get('/competitions/:id/fencers', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'fencers.html')));

// Stubs (to be added as slices)
// app.use('/api/phases',       require('./routes/phases'));
// app.use('/api/resources',    require('./routes/resources'));
// app.use('/api/auth',         require('./routes/auth'));

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`AtlasCompetitionManager running on http://localhost:${PORT}`);
});
