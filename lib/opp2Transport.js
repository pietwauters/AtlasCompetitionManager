'use strict';
const mqtt = require('mqtt');

const PROTOCOL = 'OPP2';
const VERSION  = '1.0';

let client    = null;
let brokerUrl = null;
let seq       = 0;

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

// Connect to an MQTT broker. Callbacks are called from MQTT event handlers.
// Returns a Promise that resolves on first successful connection.
function connect(url, { onConnect, onReconnect, onClose, onMessage } = {}) {
  if (client) disconnect();
  brokerUrl = url;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Connection timeout')), 10000);

    client = mqtt.connect(url, {
      clientId:        'atlas-cms-' + Math.random().toString(16).slice(2, 8),
      clean:           true,
      reconnectPeriod: 5000,
      connectTimeout:  8000,
      will: {
        topic:   'openpiste/atlas/software/connection',
        payload: JSON.stringify({ online: false }),
        qos: 1, retain: true,
      },
    });

    client.once('connect', () => {
      clearTimeout(timer);
      resetSeq();
      console.log('[OPP2] Connected to', url);
      onConnect?.();
      resolve();
    });

    client.once('error', err => {
      clearTimeout(timer);
      console.error('[OPP2] MQTT error:', err.message);
      reject(err);
    });

    client.on('message',   (t, msg) => onMessage?.(t, msg));
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
  isConnected, getBrokerUrl,
  connect, disconnect,
};
