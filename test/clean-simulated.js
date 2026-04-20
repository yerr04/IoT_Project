// Removes simulated readings from Firebase RTDB while leaving the real
// sensor-node documents (/readings/bedside, /readings/body) untouched.

const admin = require('firebase-admin');
const serviceAccount = require('../serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://iot-project-36aef-default-rtdb.firebaseio.com',
});

const KEEP = new Set(['bedside', 'body']);

(async () => {
  const db = admin.database();
  const snap = await db.ref('readings').once('value');
  if (!snap.exists()) {
    console.log('No /readings node found. Nothing to clean.');
    process.exit(0);
  }

  const updates = {};
  let removed = 0;
  snap.forEach((child) => {
    if (!KEEP.has(child.key)) {
      updates[child.key] = null;
      removed += 1;
    }
  });

  if (!removed) {
    console.log('No simulated push-id readings found. Nothing to remove.');
    process.exit(0);
  }

  await db.ref('readings').update(updates);
  console.log(`Removed ${removed} simulated reading(s) from /readings.`);
  process.exit(0);
})().catch((err) => {
  console.error('Cleanup failed:', err);
  process.exit(1);
});
