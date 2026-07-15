'use strict';
// Tier A (certificate-based) provisioning exchange, docs/level2.md §30.5. Handles
// the two reserved, non-piste-scoped topics — openpiste/_provision/request and
// openpiste/_provision/response/{device_id} — which don't fit the normal
// openpiste/{piste}/{publisher}/{type} shape lib/opp2Client.js's handleMessage
// otherwise assumes, so this is wired in as a special case before that parsing runs.
const Transport = require('./opp2Transport');
const Provisioning = require('../services/provisioning');

const ROLES = ['apparatus', 'scoresheet', 'remote', 'var'];
const DEVICE_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function respond(deviceId, body) {
  // device_id has already been validated against DEVICE_ID_RE by the caller —
  // never build this topic from unvalidated input (it would otherwise let a
  // malicious request redirect the response to an arbitrary topic).
  const topic = `openpiste/_provision/response/${deviceId}`;
  Transport.rawPublish(topic, {
    protocol: Transport.PROTOCOL, version: Transport.VERSION, seq: Transport.nextSeq(),
    ts: Date.now(), ...body,
  }, { qos: 1, retain: false });
}

function handleProvisionRequest(rawMessage) {
  let payload;
  try { payload = JSON.parse(rawMessage.toString()); }
  catch { return; }

  const { code, role, device_id: deviceId, device_label: deviceLabel, csr } = payload;

  // No safe topic to respond on without a valid device_id — log and drop rather
  // than guess.
  if (!DEVICE_ID_RE.test(deviceId || '')) {
    console.warn('[OPP2] Tier A provisioning request with missing/invalid device_id — dropped');
    return;
  }

  if (!code || !ROLES.includes(role) || !csr) {
    console.warn(`[OPP2] Tier A provisioning request from ${deviceId}: malformed request`);
    return respond(deviceId, { status: 'denied', reason: 'malformed_request' });
  }

  let result;
  try {
    result = Provisioning.signCertificate({ code, role, deviceId, deviceLabel, csrPem: csr });
  } catch (err) {
    console.error(`[OPP2] Tier A provisioning error for ${deviceId}:`, err.message);
    return respond(deviceId, { status: 'denied', reason: 'signing_failed' });
  }

  if (!result) {
    console.log(`[OPP2] Tier A provisioning denied for ${deviceId} (role ${role}): invalid or expired code`);
    return respond(deviceId, { status: 'denied', reason: 'invalid_or_expired_code' });
  }

  console.log(`[OPP2] Tier A provisioning granted for ${deviceId} (role ${role}, serial ${result.serial})`);
  respond(deviceId, { status: 'granted', role, cert: result.certPem, ca_cert: result.caCertPem });
}

module.exports = { handleProvisionRequest };
