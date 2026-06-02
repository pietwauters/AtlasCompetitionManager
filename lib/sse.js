'use strict';

const subscribers = new Map();

const SSE = {
  subscribe(channelId, res) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const key = String(channelId);
    if (!subscribers.has(key)) subscribers.set(key, new Set());
    subscribers.get(key).add(res);

    res.on('close', () => {
      subscribers.get(key)?.delete(res);
      if (subscribers.get(key)?.size === 0) subscribers.delete(key);
    });
  },

  emit(channelId, event, data) {
    const key = String(channelId);
    const subs = subscribers.get(key);
    if (!subs || subs.size === 0) return;
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of subs) res.write(msg);
  },
};

module.exports = SSE;
