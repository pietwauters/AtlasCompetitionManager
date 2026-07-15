'use strict';
// Run from the project root: node scripts/issue-cms-certificate.js
//
// Idempotent issuance of Atlas's own Tier A broker client certificate — skips if
// one already exists, and refuses (rather than failing) if the local CA hasn't
// been generated yet. Shared by install.sh and update.sh so both stay in sync.
const fs = require('fs');
const path = require('path');

const tlsDir = path.join(__dirname, '..', 'data', 'tls');

if (fs.existsSync(path.join(tlsDir, 'software-client.crt'))) {
  console.log('CMS client certificate already provisioned, skipping.');
  process.exit(0);
}

if (!fs.existsSync(path.join(tlsDir, 'ca.key')) || !fs.existsSync(path.join(tlsDir, 'ca.crt'))) {
  console.log('No local CA yet — run ./scripts/generate-tls-cert.sh, then re-run this');
  console.log('step manually: ./scripts/provision-cms-client-cert.sh');
  process.exit(0);
}

const Provisioning = require('../services/provisioning');
const { serial } = Provisioning.issueCmsCertificate();
console.log(`Issued (serial ${serial}) — Atlas will use it automatically on next start,`);
console.log('once it is pushed to the broker via scripts/sync-mosquitto-scoresheet-acl.sh.');
