const express = require('express');
const path = require('path');
const webpush = require('web-push');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// In-memory key/value store. This resets whenever the server restarts,
// which is fine here: each game is meant to start fresh anyway.
const store = new Map();

app.get('/healthz', (req, res) => res.status(200).send('ok'));

app.get('/api/kv/:key', (req, res) => {
  const key = req.params.key;
  if (!store.has(key)) return res.status(404).json({ error: 'not found' });
  res.json({ key, value: store.get(key) });
});

app.post('/api/kv/:key', (req, res) => {
  const key = req.params.key;
  const value = req.body && req.body.value;
  if (typeof value !== 'string') return res.status(400).json({ error: 'value must be a string' });
  if (key.length > 200) return res.status(400).json({ error: 'key too long' });
  store.set(key, value);
  res.json({ key, value });
});

app.delete('/api/kv/:key', (req, res) => {
  store.delete(req.params.key);
  res.json({ key: req.params.key, deleted: true });
});

app.get('/api/kv-list', (req, res) => {
  const prefix = req.query.prefix || '';
  const keys = [];
  for (const k of store.keys()) {
    if (k.indexOf(prefix) === 0) keys.push(k);
  }
  res.json({ keys, prefix });
});


// ---------- Web Push (lock-screen + smartwatch alerts) ----------
// VAPID keys identify this server to the phone vendors' push services.
// If you don't set them as Azure App Settings, fresh keys are generated at startup.
// That's fine here: phones re-subscribe every time someone joins a game.
let vapidKeys = {
  publicKey: process.env.VAPID_PUBLIC_KEY,
  privateKey: process.env.VAPID_PRIVATE_KEY,
};
if (!vapidKeys.publicKey || !vapidKeys.privateKey) {
  vapidKeys = webpush.generateVAPIDKeys();
}
webpush.setVapidDetails(
  process.env.VAPID_SUBJECT || 'mailto:admin@reprumble.app',
  vapidKeys.publicKey,
  vapidKeys.privateKey
);

// deviceId -> push subscription (in memory, resets on restart like everything else)
const pushSubs = new Map();

app.get('/api/push/key', (req, res) => res.json({ key: vapidKeys.publicKey }));

app.post('/api/push/subscribe', (req, res) => {
  const { deviceId, subscription } = req.body || {};
  if (typeof deviceId !== 'string' || !deviceId || deviceId.length > 100) {
    return res.status(400).json({ error: 'bad deviceId' });
  }
  if (!subscription || typeof subscription.endpoint !== 'string') {
    return res.status(400).json({ error: 'bad subscription' });
  }
  pushSubs.set(deviceId, subscription);
  res.json({ ok: true });
});

app.post('/api/push/send', async (req, res) => {
  const { deviceIds, title, body, tag } = req.body || {};
  if (!Array.isArray(deviceIds) || deviceIds.length === 0 || deviceIds.length > 100) {
    return res.status(400).json({ error: 'bad deviceIds' });
  }
  const payload = JSON.stringify({
    title: String(title || 'Rep Rumble Arcade').slice(0, 80),
    body: String(body || '').slice(0, 200),
    tag: String(tag || 'rr').slice(0, 40),
  });
  let sent = 0;
  let failed = 0;
  await Promise.all(deviceIds.map(async (id) => {
    const sub = pushSubs.get(String(id));
    if (!sub) return;
    try {
      await webpush.sendNotification(sub, payload, { TTL: 120, urgency: 'high' });
      sent++;
    } catch (err) {
      failed++;
      if (err && (err.statusCode === 404 || err.statusCode === 410)) pushSubs.delete(String(id));
    }
  }));
  res.json({ sent, failed });
});

// Fallback to the single-page app for any other route.
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log('Rep Rumble Arcade listening on port ' + PORT);
});
