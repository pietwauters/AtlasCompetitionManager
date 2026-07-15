'use strict';
const express = require('express');
const QRCode  = require('qrcode');
const Pairing = require('../services/pairing');
const Provisioning = require('../services/provisioning');

const router = express.Router();

// Operator-facing — mounted with auth.require('director') in server.js.

// Tier B credentials (username/password) are broker auth for any browser-based
// device — the e-scoresheet PWA is the only one that exists today, but "assign a
// credential" and "open it in the e-scoresheet app" are deliberately two separate
// actions below, not one. A future non-scoresheet Tier B device would use the same
// assign step and just skip the e-scoresheet-specific one.
function escoresheetPairingUrl(cred) {
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
  // escoresheetPairingUrl is included as data either way (cheap to compute, and the
  // e-scoresheet is the only real Tier B consumer today) — but the UI only surfaces
  // it behind the separate, explicit "show e-scoresheet QR/link" action, not
  // automatically, so a future non-scoresheet Tier B device isn't steered toward it.
  res.json({ ...cred, escoresheetPairingUrl: escoresheetPairingUrl(cred) });
});

router.get('/devices', (req, res) => {
  res.json(Pairing.listCredentials());
});

router.get('/devices/:id/reveal', (req, res) => {
  const cred = Pairing.revealCredential(req.params.id);
  if (!cred) return res.status(404).json({ error: 'Not found, unassigned, or revoked' });
  res.json({ ...cred, escoresheetPairingUrl: escoresheetPairingUrl(cred) });
});

// Separate, e-scoresheet-specific action — only relevant if the device being
// paired is actually the e-scoresheet PWA. Does not create or change anything;
// just re-derives the QR for an already-assigned credential.
router.get('/devices/:id/escoresheet-qr', (req, res) => {
  const cred = Pairing.revealCredential(req.params.id);
  if (!cred) return res.status(404).json({ error: 'Not found, unassigned, or revoked' });
  QRCode.toBuffer(escoresheetPairingUrl(cred), { width: 220, margin: 2 }, (err, buf) => {
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

// Clears revoked rows from the operator-facing list only — a revoked credential
// was already excluded from the broker regeneration, so this has no effect on
// broker state either way.
router.post('/devices/purge-revoked', (req, res) => {
  res.json(Pairing.purgeRevokedCredentials());
});

// ── Tier A (certificate-based) provisioning, docs/level2.md §30.5 ──────────────────
// Unlike Tier B's assign-a-pooled-credential flow, this issues a short-lived ticket
// code the operator relays to the device by whatever input mechanism it has (the
// real scoring-device firmware exposes a small web form for this, since it has no
// camera to scan a QR with) — the device itself performs the CSR/MQTT exchange.

router.post('/tier-a/tickets', (req, res) => {
  const { role, deviceLabel } = req.body || {};
  try {
    const ticket = Provisioning.createTicket(role, deviceLabel, req.session.user.id);
    res.json(ticket);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/tier-a/tickets', (req, res) => {
  res.json(Provisioning.listTickets());
});

router.get('/tier-a/certificates', (req, res) => {
  res.json(Provisioning.listCertificates());
});

router.post('/tier-a/certificates/:id/revoke', (req, res) => {
  const cert = Provisioning.revokeCertificate(req.params.id);
  if (!cert) return res.status(404).json({ error: 'Certificate not found' });
  res.json(cert);
});

// Clears revoked rows from the operator-facing list only — does not affect the
// CRL or broker-side revocation, which stays permanent regardless.
router.post('/tier-a/certificates/purge-revoked', (req, res) => {
  res.json(Provisioning.purgeRevokedCertificates());
});

module.exports = router;
