'use strict';

const express = require('express');
const path    = require('path');
const { migrate } = require('./db/migrator');

migrate();

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

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`Atlas Competition Manager — http://localhost:${PORT}`);
});
