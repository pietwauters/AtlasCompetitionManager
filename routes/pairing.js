'use strict';
const express = require('express');
const QRCode  = require('qrcode');
const Pairing = require('../services/pairing');

const router = express.Router();

// Operator-facing — mounted with auth.require('director') in server.js.

function pairingUrl(cred) {
  const httpsPort = process.env.HTTPS_PORT || 3443;
  // Credential goes in the URL fragment, not the query string, so it's never sent to
  // Atlas's own server (fragments are client-side only) and doesn't land in access
  // logs or get forwarded anywhere. escoresheet/js/app.js reads it off location.hash.
  return `https://openpiste.local:${httpsPort}/escoresheet/` +
    `#u=${encodeURIComponent(cred.username)}&p=${encodeURIComponent(cred.password)}`;
}

router.post('/assign', (req, res) => {
  const { deviceLabel } = req.body || {};
  const cred = Pairing.assignCredential(deviceLabel);
  if (!cred) {
    return res.status(409).json({
      error: 'No unassigned credentials left in the pool. Run ' +
        '`node scripts/top-up-credential-pool.js` and ' +
        '`scripts/sync-mosquitto-scoresheet-acl.sh` to add more.',
    });
  }
  res.json({ ...cred, pairingUrl: pairingUrl(cred) });
});

router.get('/devices', (req, res) => {
  res.json(Pairing.listCredentials());
});

router.get('/devices/:id/reveal', (req, res) => {
  const cred = Pairing.revealCredential(req.params.id);
  if (!cred) return res.status(404).json({ error: 'Not found, unassigned, or revoked' });
  res.json({ ...cred, pairingUrl: pairingUrl(cred) });
});

router.get('/devices/:id/qr', (req, res) => {
  const cred = Pairing.revealCredential(req.params.id);
  if (!cred) return res.status(404).json({ error: 'Not found, unassigned, or revoked' });
  QRCode.toBuffer(pairingUrl(cred), { width: 220, margin: 2 }, (err, buf) => {
    if (err) return res.status(500).json({ error: 'QR generation failed' });
    res.set('Content-Type', 'image/png');
    res.send(buf);
  });
});

router.post('/devices/:id/revoke', (req, res) => {
  const device = Pairing.revokeCredential(req.params.id);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  res.json(device);
});

router.get('/pool-stats', (req, res) => {
  res.json(Pairing.poolStats());
});

module.exports = router;
