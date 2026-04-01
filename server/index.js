const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const db = require('./firebase');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, '../public')));

db.ref('readings').limitToLast(50).on('child_added', (snapshot) => {
  const data = snapshot.val();
  console.log('New reading:', data);
  io.emit('newReading', data);
});

app.get('/api/readings', async (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 100;
  const snapshot = await db.ref('readings').limitToLast(limit).once('value');
  const readings = [];
  snapshot.forEach((child) => readings.push(child.val()));
  res.json(readings);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
});
