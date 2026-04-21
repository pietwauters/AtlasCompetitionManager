const express = require('express');
const dns = require('dns');
const router = express.Router();

// GET /api/resolve?host=hostname
router.get('/', (req, res) => {
  const host = req.query.host;
  if (!host) return res.status(400).json({ error: 'Missing host parameter' });
  dns.lookup(host, { family: 4 }, (err, address) => {
    if (err) {
      res.status(404).json({ error: 'Could not resolve host via DNS' });
    } else {
      res.json({ ip: address });
    }
  });
});

module.exports = router;
