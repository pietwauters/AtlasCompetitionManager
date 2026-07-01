'use strict';

const subscribers = new Map();

// Send a keepalive comment to every subscriber every 30 s.
// This serves two purposes:
//   1. Detects dead connections (write fails → 'close' fires → subscriber removed).
//   2. Prevents intermediate proxies from closing idle SSE streams.
setInterval(() => {
  for (const subs of subscribers.values()) {
    for (const res of subs) {
      try { res.write(': keepalive\n\n'); } catch (_) {}
    }
  }
}, 30_000).unref();

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
    for (const res of subs) {
      try { res.write(msg); } catch (_) {}
    }
  },
};

module.exports = SSE;
