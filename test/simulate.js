// Local test: pushes the same shape as ESP32 sensor nodes (see POST /api/readings).
const admin = require('firebase-admin');
const serviceAccount = require('../serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://iot-project-36aef-default-rtdb.firebaseio.com',
});

const db = admin.database();

setInterval(() => {
  db.ref('readings').push({
    nodeName: 'BEDSIDE',
    temp: 21 + Math.random() * 2,
    pressure: 1000 + Math.random() * 15,
    soundActivity: Math.round(50 + Math.random() * 400),
    timestamp: Date.now(),
  });
  console.log('Pushed simulated reading');
}, 1000);
