const express = require('express');
const router = express.Router();

// Use 'mdns' or 'bonjour' for mDNS/Bonjour resolution
let bonjour;
try {
  bonjour = require('bonjour')();
} catch (e) {
  bonjour = null;
}

// GET /api/mdns/resolve?host=hostname.local
router.get('/resolve', async (req, res) => {
  const host = req.query.host;
  if (!host) return res.status(400).json({ error: 'Missing host parameter' });
  if (!bonjour) return res.status(500).json({ error: 'Bonjour/mDNS not available on server' });

  let found = null;
  const timeout = setTimeout(() => {
    if (!found) res.status(404).json({ error: 'No address found for host' });
  }, 3000);

  bonjour.find({ type: 'mqtt' }, service => {
    if (service.host === host || service.fqdn === host) {
      found = service.addresses.find(addr => addr.includes('.'));
      clearTimeout(timeout);
      if (found) {
        res.json({ ip: found, service });
      } else {
        res.status(404).json({ error: 'No IPv4 address found' });
      }
    }
  });
});

module.exports = router;
