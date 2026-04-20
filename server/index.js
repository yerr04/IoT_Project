const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

console.log('[boot] starting IoT dashboard server, node=' + process.version);

let db;
try {
  db = require('./firebase');
  console.log('[boot] firebase admin initialized');
} catch (err) {
  console.error('[boot] FATAL: firebase init failed:', err && err.message);
  console.error(err && err.stack);
  process.exit(1);
}

process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException:', err && err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandledRejection:', reason);
});

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.get('/healthz', (_req, res) => res.status(200).send('ok'));

const INGEST_SECRET = process.env.INGEST_SECRET;

app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(__dirname, '../public')));

function assertIngestAuth(req, res) {
  if (!INGEST_SECRET) return true;
  const auth = req.get('authorization');
  const token = req.get('x-ingest-token');
  const bearer =
    auth && auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  const ok = bearer === INGEST_SECRET || token === INGEST_SECRET;
  if (!ok) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

let gatewayStatus = { online: false, lastSeen: null, packetsRelayed: 0 };

setInterval(() => {
  if (gatewayStatus.lastSeen && Date.now() - gatewayStatus.lastSeen > 30000) {
    if (gatewayStatus.online) {
      gatewayStatus.online = false;
      io.emit('gatewayStatus', gatewayStatus);
    }
  }
}, 5000);

io.on('connection', (socket) => {
  socket.emit('gatewayStatus', gatewayStatus);
});

const readingsRef = db.ref('readings');

readingsRef.on('child_added', (snapshot) => {
  const data = { _key: snapshot.key, ...snapshot.val() };
  console.log('Reading added:', data);
  io.emit('newReading', data);
});

readingsRef.on('child_changed', (snapshot) => {
  const data = { _key: snapshot.key, ...snapshot.val() };
  console.log('Reading updated:', data);
  io.emit('readingUpdate', data);
});

app.get('/api/readings', async (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 100;
  const snapshot = await db.ref('readings').limitToLast(limit).once('value');
  const readings = [];
  snapshot.forEach((child) => {
    readings.push({ _key: child.key, ...child.val() });
  });
  readings.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  res.json(readings);
});

app.get('/api/gateway-status', (_req, res) => {
  res.json(gatewayStatus);
});

// Clears simulated readings
app.delete('/api/readings', async (_req, res) => {
  try {
    const snap = await db.ref('readings').once('value');
    const updates = {};
    let removed = 0;
    snap.forEach((child) => {
      if (child.key !== 'bedside' && child.key !== 'body') {
        updates[child.key] = null;
        removed += 1;
      }
    });
    if (removed) await db.ref('readings').update(updates);
    io.emit('cleared');
    res.json({ ok: true, removed });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to clear readings' });
  }
});

app.post('/api/readings', async (req, res) => {
  if (!assertIngestAuth(req, res)) return;

  const body = req.body || {};
  if (typeof body.nodeName !== 'string' || !body.nodeName.trim()) {
    return res.status(400).json({ error: 'nodeName is required' });
  }

  const reading = {
    ...body,
    nodeName: body.nodeName.trim().slice(0, 64),
    timestamp: Date.now(),
  };

  try {
    await db.ref('readings').push(reading);
    gatewayStatus = {
      online: true,
      lastSeen: Date.now(),
      packetsRelayed: gatewayStatus.packetsRelayed + 1,
    };
    io.emit('gatewayStatus', gatewayStatus);
    io.emit('newReading', reading);
    res.status(201).json({ ok: true, reading });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save reading' });
  }
});

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = '0.0.0.0';
server.listen(PORT, HOST, () => {
  console.log(`[boot] listening on ${HOST}:${PORT}`);
  if (INGEST_SECRET) {
    console.log('POST /api/readings requires ingest authentication.');
  }
});

server.on('error', (err) => {
  console.error('[fatal] http server error:', err && err.stack);
});
