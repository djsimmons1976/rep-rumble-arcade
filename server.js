const express = require('express');
const compression = require('compression');
const path = require('path');
const fs = require('fs');
const webpush = require('web-push');

// A crash would wipe a live game, so log problems instead of dying.
process.on('unhandledRejection', (err) => console.error('unhandledRejection:', err && err.stack || err));
process.on('uncaughtException', (err) => console.error('uncaughtException:', err && err.stack || err));

const app = express();
app.use(compression());
app.use(express.json({ limit: '1mb' }));

// ---------- tiny request counters (visible at /api/stats) ----------
const stats = { started: Date.now(), total: 0, perRoute: {}, minute: [] };
app.use((req, res, next) => {
  stats.total++;
  const route = req.path.startsWith('/api/') ? req.path.split('/').slice(0, 3).join('/') : 'static';
  stats.perRoute[route] = (stats.perRoute[route] || 0) + 1;
  const m = Math.floor(Date.now() / 60000);
  const last = stats.minute[stats.minute.length - 1];
  if (last && last.m === m) last.n++; else { stats.minute.push({ m, n: 1 }); if (stats.minute.length > 10) stats.minute.shift(); }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ---------- the key/value store ----------
// Every key remembers a version, so two phones can't silently overwrite each other (see ifVersion below).
const store = new Map();            // key -> { value: string, ver: number, t: ms }
let counter = 0;                    // goes up on every write or delete
const gameVersion = new Map();      // game prefix -> counter at that game's last change
const EPOCH = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);   // changes on every server start

function gamePrefix(key) {
  const parts = key.split(':');
  if (parts[0] === 'classic') return 'classic:';
  return parts.length >= 3 ? parts[0] + ':' + parts[1] + ':' : parts[0] + ':';
}
function bump(key) { counter++; gameVersion.set(gamePrefix(key), counter); return counter; }
function validKey(key) { return typeof key === 'string' && key.length > 0 && key.length <= 200; }

// ---------- keep the game alive across restarts ----------
function pickDataDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  try { fs.accessSync('/home', fs.constants.W_OK); return '/home/rr-data'; } catch (e) { /* not on Azure */ }
  return path.join(__dirname, '.data');
}
const DATA_DIR = pickDataDir();
const DATA_FILE = path.join(DATA_DIR, 'store.json');
const KEEP_MS = 24 * 3600 * 1000;
let dirty = false;
let persistWarned = false;

function loadStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const cutoff = Date.now() - KEEP_MS;
    let n = 0;
    for (const [k, e] of Object.entries(raw.items || {})) {
      if (e && typeof e.value === 'string' && e.t >= cutoff) {
        store.set(k, e);
        counter = Math.max(counter, e.ver || 0);
        const gp = gamePrefix(k);
        gameVersion.set(gp, Math.max(gameVersion.get(gp) || 0, e.ver || 0));
        n++;
      }
    }
    console.log('Restored ' + n + ' keys from ' + DATA_FILE);
  } catch (e) { /* first run, nothing to restore */ }
}
function saveStore() {
  if (!dirty) return;
  dirty = false;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ savedAt: Date.now(), items: Object.fromEntries(store) }));
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) {
    if (!persistWarned) { console.error('Could not save game data (continuing in memory only):', e.message); persistWarned = true; }
  }
}
function expireOld() {
  const cutoff = Date.now() - KEEP_MS;
  let removed = 0;
  for (const [k, e] of store) { if (e.t < cutoff) { store.delete(k); removed++; } }
  if (removed) { dirty = true; }
}
loadStore();
setInterval(saveStore, 2000).unref();
setInterval(expireOld, 10 * 60 * 1000).unref();

app.get('/healthz', (req, res) => res.status(200).send('ok'));

app.get('/api/stats', (req, res) => {
  res.json({
    uptimeSec: Math.round((Date.now() - stats.started) / 1000),
    requestsTotal: stats.total,
    requestsPerRoute: stats.perRoute,
    requestsPerMinute: stats.minute.map((x) => x.n),
    keys: store.size,
    games: gameVersion.size,
    dataFile: DATA_FILE,
  });
});

app.get('/api/kv/:key', (req, res) => {
  const e = store.get(req.params.key);
  if (!e) return res.status(404).json({ error: 'not found' });
  res.json({ key: req.params.key, value: e.value, version: e.ver });
});

// Optional ifVersion makes a write conditional: 0 means "only if the key doesn't exist yet",
// any other number means "only if nobody has changed it since I read it". Otherwise 409.
app.post('/api/kv/:key', (req, res) => {
  const key = req.params.key;
  const value = req.body && req.body.value;
  if (!validKey(key)) return res.status(400).json({ error: 'bad key' });
  if (typeof value !== 'string') return res.status(400).json({ error: 'value must be a string' });
  const ifVersion = req.body.ifVersion;
  if (ifVersion !== undefined) {
    const cur = store.get(key);
    const curVer = cur ? cur.ver : 0;
    if (curVer !== ifVersion) return res.status(409).json({ error: 'conflict', value: cur ? cur.value : null, version: curVer });
  }
  const ver = bump(key);
  store.set(key, { value, ver, t: Date.now() });
  dirty = true;
  res.json({ key, value, version: ver });
});

app.delete('/api/kv/:key', (req, res) => {
  const key = req.params.key;
  if (store.delete(key)) { bump(key); dirty = true; }
  res.json({ key, deleted: true });
});

app.get('/api/kv-list', (req, res) => {
  const prefix = req.query.prefix || '';
  const keys = [];
  for (const k of store.keys()) { if (k.indexOf(prefix) === 0) keys.push(k); }
  res.json({ keys, prefix });
});

// Everything a phone needs for one game, in ONE request. If nothing changed since `since`, the reply is tiny.
app.get('/api/snapshot', (req, res) => {
  const prefix = String(req.query.prefix || '');
  if (!prefix || prefix.length > 80 || prefix.slice(-1) !== ':') return res.status(400).json({ error: 'bad prefix' });
  let since = parseInt(req.query.since || '0', 10) || 0;
  if (req.query.epoch !== EPOCH) since = 0;                 // the server restarted: send everything again
  const version = gameVersion.get(prefix) || 0;
  const base = { epoch: EPOCH, version, serverNow: Date.now() };
  if (since && version <= since) return res.json(Object.assign(base, { changed: false }));
  const items = {};
  for (const [k, e] of store) { if (k.indexOf(prefix) === 0) items[k] = e.value; }
  res.json(Object.assign(base, { changed: true, items }));
});

// Wipe many keys at once (used when the Q resets a round).
app.post('/api/kv-delete-prefix', (req, res) => {
  const prefixes = req.body && req.body.prefixes;
  if (!Array.isArray(prefixes) || prefixes.length === 0 || prefixes.length > 30) return res.status(400).json({ error: 'bad prefixes' });
  const ok = prefixes.every((p) => typeof p === 'string' && p.length >= 5 && p.length <= 100);
  if (!ok) return res.status(400).json({ error: 'bad prefixes' });
  let removed = 0;
  for (const k of Array.from(store.keys())) {
    if (prefixes.some((p) => k.indexOf(p) === 0)) { store.delete(k); bump(k); removed++; }
  }
  if (removed) dirty = true;
  res.json({ removed });
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
const server = app.listen(PORT, () => {
  console.log('Rep Rumble Arcade listening on port ' + PORT + ' (data: ' + DATA_FILE + ')');
});
// Save whatever is pending when the server is told to stop (for example during a redeploy).
function shutdown() { dirty = true; saveStore(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
