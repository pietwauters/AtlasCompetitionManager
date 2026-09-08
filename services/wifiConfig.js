'use strict';
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT_PATH = path.join(__dirname, '..', 'scripts', 'configure-wifi.sh');
const COUNTRY_RE = /^[A-Za-z]{2}$/;
const SSID_MAX_BYTES = 32;

function assertValidCountry(country) {
  if (!COUNTRY_RE.test(country || '')) throw new Error('Invalid country code');
}

// nmcli -t output is colon-separated with literal colons escaped as "\:".
function parseScanOutput(raw) {
  const bySsid = new Map();
  raw.split('\n').forEach((line) => {
    if (!line) return;
    const [ssidRaw, signalRaw, securityRaw] = line.split(/(?<!\\):/).map((s) => (s || '').replace(/\\:/g, ':'));
    const ssid = ssidRaw;
    if (!ssid) return;
    const signal = parseInt(signalRaw, 10) || 0;
    const security = securityRaw && securityRaw !== '--' ? securityRaw : '';
    const existing = bySsid.get(ssid);
    if (!existing || signal > existing.signal) bySsid.set(ssid, { ssid, signal, security });
  });
  return [...bySsid.values()].sort((a, b) => b.signal - a.signal);
}

const WifiConfig = {
  scan(country) {
    assertValidCountry(country);
    const out = execFileSync('sudo', [SCRIPT_PATH, 'scan', country.toUpperCase()], { stdio: ['ignore', 'pipe', 'pipe'] });
    return parseScanOutput(out.toString('utf8'));
  },

  connect({ country, ssid, password }) {
    assertValidCountry(country);
    if (!ssid || Buffer.byteLength(ssid, 'utf8') > SSID_MAX_BYTES) throw new Error('Invalid SSID');
    execFileSync('sudo', [SCRIPT_PATH, 'connect', country.toUpperCase(), ssid], {
      input: `${password || ''}\n`,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { ok: true };
  },
};

module.exports = WifiConfig;
