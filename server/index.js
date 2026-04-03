const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const db = require('./firebase');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

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

app.delete('/api/readings', async (_req, res) => {
  try {
    await db.ref('readings').remove();
    io.emit('cleared');
    res.json({ ok: true });
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
  if (INGEST_SECRET) {
    console.log('POST /api/readings requires ingest authentication.');
  }
});
