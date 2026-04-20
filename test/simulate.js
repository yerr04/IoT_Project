// Local simulator that writes to /readings/bedside_sim and /readings/body_sim.
const admin = require('firebase-admin');
const serviceAccount = require('../serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://iot-project-36aef-default-rtdb.firebaseio.com',
});

const db = admin.database();

const BEDSIDE_PATH = 'readings/bedside_sim';
const BODY_PATH    = 'readings/body_sim';

// Tunables
const BEDSIDE_INTERVAL_MS = 1000;
const BODY_INTERVAL_MS    = 1000;
const APNEA_EVENT_PROB    = 0.02;   // chance per body tick to start an event
const APNEA_EVENT_MIN_MS  = 4000;
const APNEA_EVENT_MAX_MS  = 9000;

// Slow-moving baselines so the charts look like real physiological signals
// rather than uniform noise.
let baseTemp     = 22.0;
let basePressure = 1008.5;
let baseSound    = 120;

let baseHr       = 68;
let baseSpo2     = 97;
let prone        = false;
let proneUntil   = 0;

// Apnea state machine
let alertActive  = false;
let alertName    = '';
let alertType    = 0;
let alertEndsAt  = 0;

function jitter(value, amount) {
  return value + (Math.random() - 0.5) * 2 * amount;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function startSimulatedApnea() {
  const roll = Math.random();
  if (roll < 0.34) {
    alertName = 'VITALS';   alertType = 1;
  } else if (roll < 0.67) {
    alertName = 'POSITION'; alertType = 2;
    prone = true;
    proneUntil = Date.now() + 30000;
  } else {
    alertName = 'COMBINED'; alertType = 3;
    prone = true;
    proneUntil = Date.now() + 30000;
  }
  alertActive = true;
  alertEndsAt = Date.now()
    + APNEA_EVENT_MIN_MS
    + Math.random() * (APNEA_EVENT_MAX_MS - APNEA_EVENT_MIN_MS);
}

async function tickBedside() {
  baseTemp  = clamp(jitter(baseTemp,  0.02), 18, 30);
  baseSound = clamp(jitter(baseSound, 25),   20, 3000);

  const now = Date.now();
  const reading = {
    nodeName: 'BEDSIDE',
    temp: Number(baseTemp.toFixed(2)),
    pressure: Number(basePressure.toFixed(2)),
    soundActivity: Math.round(baseSound),
    receivedAtMs: now,
    timestamp: now,
  };

  try {
    await db.ref(BEDSIDE_PATH).set(reading);
  } catch (err) {
    console.error('bedside_sim write failed:', err.message);
  }
}

async function tickBody() {
  const now = Date.now();

  if (!alertActive && Math.random() < APNEA_EVENT_PROB) startSimulatedApnea();
  if (alertActive && now >= alertEndsAt) {
    alertActive = false;
    alertName = '';
    alertType = 0;
  }
  if (prone && now >= proneUntil && !alertActive) {
    prone = false;
  }

  // During a vitals/combined event, exaggerate the dip; otherwise drift gently.
  if (alertActive && (alertName === 'VITALS' || alertName === 'COMBINED')) {
    baseHr   = clamp(jitter(baseHr,   1.5), 38,  130);
    baseSpo2 = clamp(jitter(baseSpo2, 0.6), 78,  100);
    baseSpo2 = clamp(baseSpo2 - 0.4, 78, 100);
    baseHr   = clamp(baseHr   - 0.3, 38, 130);
  } else {
    baseHr   = clamp(jitter(baseHr,   0.6), 55,  95);
    baseSpo2 = clamp(jitter(baseSpo2, 0.2), 94,  100);
  }

  const accelZ = prone ? jitter(-0.85, 0.05) : jitter(0.95, 0.05);

  const reading = {
    nodeName: 'BODY',
    heartRate: Number(baseHr.toFixed(1)),
    spo2: Number(baseSpo2.toFixed(1)),
    accelZ: Number(accelZ.toFixed(3)),
    fingerPresent: true,
    prone,
    alertActive,
    alertType,
    alertName,
    receivedAtMs: now,
    timestamp: now,
  };

  try {
    await db.ref(BODY_PATH).set(reading);
  } catch (err) {
    console.error('body_sim write failed:', err.message);
  }
}

console.log('Simulator running. Writing in place to:');
console.log('  /' + BEDSIDE_PATH);
console.log('  /' + BODY_PATH);
console.log('Press Ctrl+C to stop. To remove the simulated docs later:');
console.log('  npm run clean:simulated');

setInterval(tickBedside, BEDSIDE_INTERVAL_MS);
setInterval(tickBody,    BODY_INTERVAL_MS);

function shutdown() {
  console.log('\nStopping simulator.');
  process.exit(0);
}
process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);
