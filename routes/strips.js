'use strict';
const express = require('express');
const os      = require('os');
const Strip   = require('../services/strips');
const SSE     = require('../lib/sse');
const OPP2    = require('../lib/opp2Client');
const QRCode  = require('qrcode');

const router = express.Router();

function serverBaseUrl(req) {
  const port = process.env.PORT || 3001;
  const ifaces = os.networkInterfaces();
  for (const addrs of Object.values(ifaces)) {
    for (const a of addrs) {
      if (a.family === 'IPv4' && !a.internal) return `http://${a.address}:${port}`;
    }
  }
  return `${req.protocol}://${req.hostname}:${port}`;
}

router.get('/qr-base', (req, res) => {
  res.json({ baseUrl: serverBaseUrl(req) });
});

router.get('/qr', (req, res) => {
  const piste = req.query.piste;
  if (!piste) return res.status(400).json({ error: 'piste required' });
  const url = `${serverBaseUrl(req)}/scoresheet.html?piste=${encodeURIComponent(piste)}`;
  QRCode.toBuffer(url, { width: 200, margin: 2 }, (err, buf) => {
    if (err) return res.status(500).json({ error: 'QR generation failed' });
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(buf);
  });
});

router.get('/events', (req, res) => {
  SSE.subscribe('__strips__', res);
  // Send current live state immediately so the page doesn't wait for the next change
  for (const piste of OPP2.status().pistes) {
    res.write(`event: piste-state\ndata: ${JSON.stringify(piste)}\n\n`);
  }
});

router.get('/', (req, res) => {
  res.json(Strip.findAll());
});

router.get('/:id', (req, res) => {
  const s = Strip.findById(req.params.id);
  if (!s) return res.status(404).json({ error: 'Strip not found' });
  res.json(s);
});

router.post('/', (req, res) => {
  try {
    const s = Strip.create(req.body);
    OPP2.addPiste(s);
    res.status(201).json(s);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.patch('/:id', (req, res) => {
  const before = Strip.findById(req.params.id);
  if (!before) return res.status(404).json({ error: 'Strip not found' });
  const s = Strip.update(req.params.id, req.body);
  if (before.name !== s.name) OPP2.renamePiste(before.name, s.name);
  res.json(s);
});

// POST /api/strips/:id/ack — send an OPP2 ACK to this piste (topic id = strip name)
// to release an apparatus stuck waiting for confirmation.
router.post('/:id/ack', (req, res) => {
  const s = Strip.findById(req.params.id);
  if (!s) return res.status(404).json({ error: 'Strip not found' });
  if (!s.name) return res.status(400).json({ error: 'This strip has no name, so it has no OPP2 piste to send to.' });
  try {
    OPP2.manualAck(s.name);
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.delete('/:id', (req, res) => {
  const result = Strip.delete(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Strip not found' });
  res.json({ ok: true });
});

module.exports = router;
