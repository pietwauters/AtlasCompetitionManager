const mqtt = require('mqtt');
const EventEmitter = require('events');

class CyranoServer extends EventEmitter {
  constructor({ brokerUrl, db, getActivePistes }) {
    super();
    this.brokerUrl = brokerUrl;
    this.db = db; // Database instance or API
    this.getActivePistes = getActivePistes; // Function to get active pistes from DB
    this.client = null;
    this.activePistes = new Set();
    this.topicMap = new Map(); // pisteNumber -> { topics }
  }

  connect() {
    this.client = mqtt.connect(this.brokerUrl, { rejectUnauthorized: false });
    this.client.on('connect', () => {
      console.log('[CyranoServer] Connected to MQTT broker:', this.brokerUrl);
      this.emit('connected');
      this.refreshSubscriptions();
    });
    this.client.on('error', (err) => {
      console.error('[CyranoServer] MQTT error:', err);
      this.emit('error', err);
    });
    this.client.on('message', (topic, message) => {
      this.handleMessage(topic, message.toString());
    });
  }

  async refreshSubscriptions() {
    const pistes = await this.getActivePistes();
    const newPistes = new Set(pistes);
    // Unsubscribe from deactivated pistes
    for (const piste of this.activePistes) {
      if (!newPistes.has(piste)) {
        this.unsubscribePiste(piste);
      }
    }
    // Subscribe to new pistes
    for (const piste of newPistes) {
      if (!this.activePistes.has(piste)) {
        this.subscribePiste(piste);
      }
    }
    this.activePistes = newPistes;
  }

  subscribePiste(piste) {
    const topics = [
      `MQTT_Cyrano/Piste_${piste}/FromDeviceToSoft/#`,
      `Cyrano_mqtt/Piste_${piste}/Connection`
    ];
    topics.forEach(topic => this.client.subscribe(topic));
    this.topicMap.set(piste, { topics });
    console.log(`[CyranoServer] Subscribed to topics for piste ${piste}`);
  }

  unsubscribePiste(piste) {
    const entry = this.topicMap.get(piste);
    if (entry) {
      entry.topics.forEach(topic => this.client.unsubscribe(topic));
      this.topicMap.delete(piste);
      console.log(`[CyranoServer] Unsubscribed from topics for piste ${piste}`);
    }
  }

  handleMessage(topic, message) {
    // TODO: Parse and dispatch message by type
    // Example: this.emit('info', { topic, message })
    console.log(`[CyranoServer] Received message on ${topic}:`, message);
  }

  sendMessage(piste, direction, payload) {
    // direction: 'ToDevice' or 'ToSoft'
    // payload: JSON object (all fields as strings)
    let topic;
    if (direction === 'ToDevice') {
      topic = `MQTT_Cyrano/Piste_${piste}/FromSoftToDevice/`;
    } else {
      topic = `MQTT_Cyrano/Piste_${piste}/FromDeviceToSoft/`;
    }
    this.client.publish(topic, JSON.stringify(payload));
    console.log(`[CyranoServer] Sent message to ${topic}:`, payload);
  }

  disconnect() {
    if (this.client) {
      this.client.end();
      this.client = null;
      this.activePistes.clear();
      this.topicMap.clear();
      console.log('[CyranoServer] Disconnected from MQTT broker');
    }
  }
}

module.exports = CyranoServer;
