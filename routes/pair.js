'use strict';
const express = require('express');
const QRCode  = require('qrcode');

const router = express.Router();

// Device-facing — deliberately public, no Atlas session. The credential-delivery flow
// itself now lives entirely in routes/pairing.js (director-authed) + the QR/fragment
// URL it generates; nothing here needs to redeem anything, since assignment already
// happened on the operator's side (docs/security-provisioning-discussion.md §4.5).

// QR for the CA certificate download — encodes the plain-HTTP URL
// deliberately (see server.js's /ca.crt route), since a brand-new device
// has no reason yet to trust the HTTPS certificate this very CA signs.
router.get('/ca-qr', (req, res) => {
  const httpPort = process.env.PORT || 3001;
  const url = `http://openpiste.local:${httpPort}/ca.crt`;
  QRCode.toBuffer(url, { width: 220, margin: 2 }, (err, buf) => {
    if (err) return res.status(500).json({ error: 'QR generation failed' });
    res.set('Content-Type', 'image/png');
    res.send(buf);
  });
});

module.exports = router;
