// test/simulate.js
const admin = require('firebase-admin');
const serviceAccount = require('../serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://iot-project-36aef-default-rtdb.firebaseio.com'
});

const db = admin.database();

setInterval(() => {
  db.ref('readings').push({
    nodeId: Math.random() > 0.5 ? 1 : 2,
    spo2: 95 + Math.random() * 4,
    heartRate: 60 + Math.random() * 20,
    irValue: 80000 + Math.random() * 10000,
    timestamp: Date.now(),
  });
  console.log('Pushed simulated reading');
}, 500);