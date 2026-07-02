'use strict';
const os = require('os');
const db = require('../db');

const stmtGet    = db.prepare('SELECT value FROM settings WHERE key = ?');
const stmtSet    = db.prepare(`
  INSERT INTO settings (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);
const stmtAll    = db.prepare('SELECT key, value FROM settings');
const stmtDelete = db.prepare('DELETE FROM settings WHERE key = ?');

// Interfaces to ignore when guessing this machine's LAN address — loopback
// and the usual virtual/container bridges, none of which any other device
// on the network could ever route to.
const SKIP_IFACE = /^(lo|docker|veth|br-|virbr)/i;

function detectLanIp() {
  const ifaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (SKIP_IFACE.test(name)) continue;
    for (const addr of addrs || []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return null;
}

const Settings = {
  get(key) {
    const row = stmtGet.get(key);
    return row ? row.value : null;
  },

  set(key, value) {
    stmtSet.run(key, String(value));
  },

  all() {
    return stmtAll.all().reduce((acc, { key, value }) => { acc[key] = value; return acc; }, {});
  },

  delete(key) {
    stmtDelete.run(key);
  },

  // The broker URL as browser clients (scoresheet tablets) should use it.
  // `opp2_broker_url` is stored and used verbatim for the server's own TCP
  // MQTT connection, but "localhost"/"127.0.0.1" means something different
  // on every device — a tablet resolving it reaches itself, not this
  // server. When the stored value is a loopback address, substitute this
  // machine's own LAN IP so it actually works from other devices on the
  // network. Any other configured host (a real IP, or a hostname like
  // openpiste.local) is left untouched and always wins.
  effectiveBrokerUrl() {
    const raw = this.get('opp2_broker_url');
    if (!raw || !/:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(raw)) return raw;
    const lanIp = detectLanIp();
    return lanIp ? raw.replace(/localhost|127\.0\.0\.1/i, lanIp) : raw;
  },
};

module.exports = Settings;
