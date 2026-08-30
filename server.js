const express = require('express');
const path = require('path');

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

// Fallback to the single-page app for any other route.
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log('Rep Rumble Arcade listening on port ' + PORT);
});
