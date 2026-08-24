'use strict';
const dns = require('dns');
const net = require('net');
const Transport = require('./opp2Transport');

// docs/cross-platform-deployment-discussion.md §mDNS threat — openpiste.local (or
// whatever hostname the broker URL uses) has no owner enforcement: mDNS conflict
// resolution just auto-renames the loser, and nothing stops another device on the
// same network from answering for the name outright. Not bulletproof (an attacker
// spoofing the name at the exact moment a check runs would show as "matches" right
// then), but it catches the passive/lingering case — squatting, an Avahi auto-rename,
// a stale ARP/DHCP entry — cheaply and continuously.
//
// The broker is not necessarily this same machine (broker and CMS can be split
// across two devices), so "does the name resolve to one of my own interfaces" is the
// wrong question. The right one: does the name still resolve to the same IP this
// process is actually, currently, successfully talking to? That connected IP is
// ground truth — for a Tier A (mTLS) connection it's already been certificate-
// validated, so anything that later announces the name pointing elsewhere is the
// anomaly, not the connected socket.

const CHECK_INTERVAL_MS = 2 * 60 * 1000;
const HOSTNAME_RE = /^(?:mqtts?:\/\/)?\[?([^\]/:]+)\]?/i;

let timer = null;
let lastCheck = null;

function brokerHostname() {
  const url = Transport.getBrokerUrl();
  if (!url) return null;
  const m = HOSTNAME_RE.exec(url);
  return m ? m[1] : null;
}

function runCheck() {
  const hostname    = brokerHostname();
  const connectedIp = Transport.getConnectedRemoteAddress();

  if (!hostname || !connectedIp) {
    lastCheck = { checkedAt: new Date().toISOString(), hostname, connectedIp, resolvedIp: null, mismatch: false, error: 'not connected' };
    return;
  }

  // A literal IP in the broker URL has nothing to resolve or drift — skip the
  // lookup rather than report a trivially-always-matching non-check.
  if (net.isIP(hostname) !== 0) {
    lastCheck = { checkedAt: new Date().toISOString(), hostname, connectedIp, resolvedIp: connectedIp, mismatch: false, error: null };
    return;
  }

  dns.lookup(hostname, { family: 4 }, (err, resolvedIp) => {
    if (err) {
      lastCheck = { checkedAt: new Date().toISOString(), hostname, connectedIp, resolvedIp: null, mismatch: false, error: err.message };
      return;
    }
    lastCheck = {
      checkedAt: new Date().toISOString(),
      hostname, connectedIp, resolvedIp,
      mismatch: resolvedIp !== connectedIp,
      error: null,
    };
  });
}

module.exports = {
  start() {
    if (timer) return;
    runCheck();
    timer = setInterval(runCheck, CHECK_INTERVAL_MS);
    timer.unref?.();
  },
  stop() {
    if (timer) clearInterval(timer);
    timer = null;
    lastCheck = null;
  },
  getStatus() { return lastCheck; },
};
