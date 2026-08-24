'use strict';
const mqtt = require('mqtt');
const fs   = require('fs');
const path = require('path');

const PROTOCOL = 'OPP2';
const VERSION  = '1.0';

const TLS_DIR   = path.join(__dirname, '..', 'data', 'tls');
const CMS_KEY   = path.join(TLS_DIR, 'software-client.key');
const CMS_CERT  = path.join(TLS_DIR, 'software-client.crt');
const CA_CERT   = path.join(TLS_DIR, 'ca.crt');

let client    = null;
let brokerUrl = null;
let seq       = 0;

// Atlas's own Tier A client certificate (services/provisioning.js's
// issueCmsCertificate), if one has been issued. Additive/opt-in: an install that
// hasn't run the CMS-cert provisioning step yet has none of these three files, and
// connect() below falls back to the existing plain/anonymous URL exactly as before —
// this can never break an install that hasn't opted in.
function cmsTlsMaterial() {
  if (!fs.existsSync(CMS_KEY) || !fs.existsSync(CMS_CERT) || !fs.existsSync(CA_CERT)) return null;
  return {
    key: fs.readFileSync(CMS_KEY),
    cert: fs.readFileSync(CMS_CERT),
    ca: fs.readFileSync(CA_CERT),
    rejectUnauthorized: true,
  };
}

// Tier A's mTLS listener is always 8883 regardless of what plain host:port the
// broker URL setting points at (services/settings.js's opp2_broker_url) — same
// "derive, don't ask the operator to configure a second thing" approach as
// Settings.effectiveBrokerUrl's loopback substitution.
function toMqttsUrl(url) {
  return url.replace(/^mqtts?:\/\/([^/:]+)(:\d+)?/, 'mqtts://$1:8883');
}

function nextSeq()  { return ++seq; }
function resetSeq() { seq = 0; }

function topic(pisteId, publisher, type) {
  return `openpiste/${pisteId}/${publisher}/${type}`;
}

// Publish an OPP2 envelope (adds protocol/version/seq, QoS 1, non-retained by default).
function publish(pisteId, type, payload, opts = {}) {
  if (!client?.connected) return;
  const msg = JSON.stringify({ protocol: PROTOCOL, version: VERSION, seq: nextSeq(), ...payload });
  client.publish(topic(pisteId, 'software', type), msg, { qos: 1, retain: false, ...opts });
}

// Publish a raw MQTT message (bypasses the OPP2 envelope — used for QoS-0 clock messages).
function rawPublish(topicStr, payload, opts = {}) {
  if (!client?.connected) return;
  const msg = typeof payload === 'string' ? payload : JSON.stringify(payload);
  client.publish(topicStr, msg, opts);
}

function publishConnection(pisteId, online) {
  if (!client?.connected) return;
  const payload = online
    ? { protocol: PROTOCOL, version: VERSION, seq: nextSeq(),
        online: true, software: 'Atlas', sw_version: '0.1.0' }
    : { online: false };
  client.publish(topic(pisteId, 'software', 'connection'),
    JSON.stringify(payload), { qos: 1, retain: true });
}

// Clear a retained message by publishing an empty payload on its topic.
function clearRetained(topicStr) {
  if (!client?.connected) return;
  client.publish(topicStr, '', { qos: 1, retain: true });
}

function subscribe(topicPattern, qos = 1) {
  if (client) client.subscribe(topicPattern, { qos });
}

function isConnected() { return client?.connected === true; }
function getBrokerUrl() { return brokerUrl; }

// The real IP this process is actually talking to, straight from the underlying
// socket (net.Socket for mqtt://, tls.TLSSocket for mqtts://) — independent of
// whatever a fresh DNS/mDNS lookup says right now. See lib/brokerIdentityCheck.js,
// which compares the two to catch another device claiming the broker's mDNS name.
function getConnectedRemoteAddress() {
  return client?.stream?.remoteAddress || null;
}

// Connect to an MQTT broker. Callbacks are called from MQTT event handlers.
// Returns a Promise that resolves on first successful connection.
function connect(url, { onConnect, onReconnect, onClose, onMessage } = {}) {
  if (client) disconnect();

  const tls = cmsTlsMaterial();
  const effectiveUrl = tls ? toMqttsUrl(url) : url;
  brokerUrl = effectiveUrl;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Connection timeout')), 10000);

    client = mqtt.connect(effectiveUrl, {
      clientId:        'atlas-cms-' + Math.random().toString(16).slice(2, 8),
      clean:           true,
      reconnectPeriod: 5000,
      connectTimeout:  8000,
      will: {
        topic:   'openpiste/atlas/software/connection',
        payload: JSON.stringify({ online: false }),
        qos: 1, retain: true,
      },
      ...tls,
    });

    client.once('connect', () => {
      clearTimeout(timer);
      resetSeq();
      console.log('[OPP2] Connected to', effectiveUrl, tls ? '(mTLS, cert CN software-cms)' : '(anonymous)');
      onConnect?.();
      resolve();
    });

    client.once('error', err => {
      clearTimeout(timer);
      console.error('[OPP2] MQTT error:', err.message);
      reject(err);
    });

    client.on('message',   (t, msg, pkt) => onMessage?.(t, msg, pkt));
    client.on('error',     err => console.error('[OPP2] MQTT error:', err.message));
    client.on('offline',   ()  => console.warn('[OPP2] MQTT client offline'));
    client.on('reconnect', ()  => onReconnect?.());
    client.on('close',     ()  => onClose?.());
  });
}

function disconnect() {
  if (!client) return;
  client.end(true);
  client = null;
  brokerUrl = null;
}

module.exports = {
  PROTOCOL, VERSION,
  topic, nextSeq,
  publish, rawPublish, publishConnection, clearRetained, subscribe,
  isConnected, getBrokerUrl, getConnectedRemoteAddress,
  connect, disconnect,
};
