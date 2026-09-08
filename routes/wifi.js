'use strict';
const express = require('express');
const WifiConfig = require('../services/wifiConfig');

const router = express.Router();

function friendlyError(e) {
  const raw = ((e.stderr && e.stderr.toString()) || e.message || '').trim();
  if (/secrets were required|802-11-wireless-security|key-mgmt/i.test(raw)) {
    return 'Wrong password — check it and try again.';
  }
  if (/no network with ssid/i.test(raw)) {
    return "Network not found — check you're in range and the name is correct.";
  }
  return raw || 'WiFi operation failed.';
}

router.get('/scan', (req, res) => {
  const country = String(req.query.country || '').trim();
  if (!country) return res.status(400).json({ error: 'country required' });
  try {
    res.json({ networks: WifiConfig.scan(country) });
  } catch (e) {
    res.status(500).json({ error: friendlyError(e) });
  }
});

router.post('/connect', (req, res) => {
  const { country, ssid, password } = req.body || {};
  if (!country || !ssid) return res.status(400).json({ error: 'country and ssid required' });
  try {
    res.json(WifiConfig.connect({ country, ssid, password }));
  } catch (e) {
    res.status(500).json({ error: friendlyError(e) });
  }
});

module.exports = router;
