const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();

const configPath = path.join(__dirname, '../config/config.json');

// Helper to read config
function readConfig() {
  if (!fs.existsSync(configPath)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

// Helper to write config
function writeConfig(data) {
  fs.writeFileSync(configPath, JSON.stringify(data, null, 2));
}

// GET /api/config
router.get('/', (req, res) => {
  res.json(readConfig());
});

// POST /api/config
router.post('/', (req, res) => {
  const newConfig = req.body;
  writeConfig(newConfig);
  res.json({ success: true });
});

module.exports = router;
