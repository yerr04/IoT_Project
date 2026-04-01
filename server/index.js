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

db.ref('readings')
  .limitToLast(50)
  .on('child_added', (snapshot) => {
    const data = snapshot.val();
    console.log('New reading:', data);
    io.emit('newReading', data);
  });

app.get('/api/readings', async (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 100;
  const snapshot = await db.ref('readings').limitToLast(limit).once('value');
  const readings = [];
  snapshot.forEach((child) => readings.push(child.val()));
  readings.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  res.json(readings);
});

app.post('/api/readings', async (req, res) => {
  if (!assertIngestAuth(req, res)) return;

  const { nodeName, temp, pressure, soundActivity } = req.body || {};
  if (typeof nodeName !== 'string' || !nodeName.trim()) {
    return res.status(400).json({ error: 'nodeName is required' });
  }
  const t = Number(temp);
  const p = Number(pressure);
  const s = Number(soundActivity);
  if (!Number.isFinite(t) || !Number.isFinite(p) || !Number.isFinite(s)) {
    return res
      .status(400)
      .json({ error: 'temp, pressure, and soundActivity must be numbers' });
  }

  const reading = {
    nodeName: nodeName.trim().slice(0, 64),
    temp: t,
    pressure: p,
    soundActivity: Math.round(s),
    timestamp: Date.now(),
  };

  try {
    await db.ref('readings').push(reading);
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
