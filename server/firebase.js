const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const DATABASE_URL =
  process.env.FIREBASE_DATABASE_URL ||
  'https://iot-project-36aef-default-rtdb.firebaseio.com';

function loadServiceAccount() {
  // Preferred in cloud hosts (Railway, Render, Fly, etc.): paste the full
  // service account JSON into an env var.
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } catch (err) {
      throw new Error(
        'FIREBASE_SERVICE_ACCOUNT is set but is not valid JSON: ' + err.message
      );
    }
  }

  // Local development: point at a file on disk.
  const keyPath =
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (!keyPath) {
    throw new Error(
      'Set FIREBASE_SERVICE_ACCOUNT (JSON string) for cloud hosts, or GOOGLE_APPLICATION_CREDENTIALS to the absolute path of your Firebase service account JSON for local dev. Do not commit that file.'
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
