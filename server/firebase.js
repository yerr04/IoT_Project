const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const DATABASE_URL = 'https://iot-project-36aef-default-rtdb.firebaseio.com';

function loadServiceAccount() {
  const keyPath =
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (!keyPath) {
    throw new Error(
      'Set GOOGLE_APPLICATION_CREDENTIALS (or FIREBASE_SERVICE_ACCOUNT_PATH) to the absolute path of your Firebase service account JSON. Do not commit that file.'
    );
  }
  const resolved = path.resolve(keyPath);
  return JSON.parse(fs.readFileSync(resolved, 'utf8'));
}

admin.initializeApp({
  credential: admin.credential.cert(loadServiceAccount()),
  databaseURL: DATABASE_URL,
});

const db = admin.database();
module.exports = db;
