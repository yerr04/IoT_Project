/* ApneaNite dashboard frontend.
 *
 * The Node/Express server in ../server/index.js mirrors Firebase Realtime
 * Database readings over Socket.IO:
 *   - newReading:    push of /readings/<child>
 *   - readingUpdate: update of /readings/<child>
 *   - gatewayStatus: { online, lastSeen, packetsRelayed }
 *   - cleared:       the database was wiped
 *
 * This file owns the live UI: Apple Health-inspired cards, rolling
 * averages, Chart.js trends, a threshold engine (persisted to
 * localStorage), and a toast system for apnea / threshold violations.
 */

const socket = io();

// ---------- constants ----------
const MAX_POINTS = 100;
const AVG_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const TOAST_COOLDOWN_MS = 15 * 1000;  // per-source rate limit
const THRESHOLD_STORAGE_KEY = 'apneanite.thresholds.v1';

const DEFAULT_THRESHOLDS = {
  hr:       { min: 50,  max: 120, on: true  },
  spo2:     { min: 90,          on: true  },
  sound:    { max: 1800,        on: false },
  proneOn:  true,
  apneaOn:  true,
  beepOn:   false,
};

let thresholds = loadThresholds();

// ---------- rolling buffers for averages ----------
const bedsideBuffer = []; // { t, pressure, sound }
const bodyBuffer    = []; // { t, hr, spo2, prone }

// ---------- chart buffers ----------
const bedsideLabels = [];
const pressureData = [];
const soundData = [];

const vitalsLabels = [];
const hrData = [];
const spo2Data = [];

const seenKeys = new Set();

// ---------- chart styling helpers ----------
function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

const C = {
  hr:       cssVar('--hr',       '#ff2d55'),
  spo2:     cssVar('--spo2',     '#5ac8fa'),
  pressure: cssVar('--pressure', '#30b0c7'),
  sound:    cssVar('--sound',    '#34c759'),
  fg:       cssVar('--fg',       '#1c1c1e'),
  fgMuted:  cssVar('--fg-muted', '#6e6e73'),
  sep:      cssVar('--separator','rgba(60,60,67,0.12)'),
};

// ---------- charts ----------
function commonChartOpts() {
  return {
    animation: false,
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { labels: { color: C.fgMuted, font: { size: 11 }, boxWidth: 10 } },
      tooltip: {
        backgroundColor: '#000',
        titleColor: '#fff',
        bodyColor: '#fff',
        borderWidth: 0,
        cornerRadius: 8,
      },
    },
    elements: { point: { radius: 0 }, line: { borderWidth: 2 } },
  };
}

const envChart = new Chart(document.getElementById('envChart'), {
  type: 'line',
  data: {
    labels: bedsideLabels,
    datasets: [
      {
        label: 'Pressure',
        data: pressureData,
        borderColor: C.pressure,
        backgroundColor: hexAlpha(C.pressure, 0.14),
        tension: 0.35,
        fill: true,
        yAxisID: 'p',
      },
    ],
  },
  options: {
    ...commonChartOpts(),
    scales: {
      x: { ticks: { color: C.fgMuted, maxTicksLimit: 6 }, grid: { color: C.sep } },
      p: {
        ticks: { color: C.pressure },
        grid: { color: C.sep },
        title: { display: true, text: 'hPa', color: C.pressure },
      },
    },
  },
});

const soundChart = new Chart(document.getElementById('soundChart'), {
  type: 'line',
  data: {
    labels: bedsideLabels,
    datasets: [{
      label: 'Sound',
      data: soundData,
      borderColor: C.sound,
      backgroundColor: hexAlpha(C.sound, 0.18),
      tension: 0.25,
      fill: true,
    }],
  },
  options: {
    ...commonChartOpts(),
    scales: {
      x: { ticks: { color: C.fgMuted, maxTicksLimit: 6 }, grid: { color: C.sep } },
      y: { ticks: { color: C.sound }, grid: { color: C.sep }, min: 0 },
    },
  },
});

const vitalsChart = new Chart(document.getElementById('vitalsChart'), {
  type: 'line',
  data: {
    labels: vitalsLabels,
    datasets: [
      {
        label: 'Heart rate',
        data: hrData,
        borderColor: C.hr,
        backgroundColor: hexAlpha(C.hr, 0.14),
        tension: 0.35,
        fill: true,
        yAxisID: 'y',
      },
      {
        label: 'SpO₂',
        data: spo2Data,
        borderColor: C.spo2,
        backgroundColor: 'transparent',
        tension: 0.35,
        fill: false,
        yAxisID: 's',
      },
    ],
  },
  options: {
    ...commonChartOpts(),
    scales: {
      x: { ticks: { color: C.fgMuted, maxTicksLimit: 6 }, grid: { color: C.sep } },
      y: {
        ticks: { color: C.hr }, grid: { color: C.sep },
        title: { display: true, text: 'bpm', color: C.hr },
      },
      s: {
        position: 'right',
        ticks: { color: C.spo2 }, grid: { drawOnChartArea: false },
        min: 70, max: 100,
        title: { display: true, text: '%', color: C.spo2 },
      },
    },
  },
});

// ---------- helpers ----------
function hexAlpha(hex, a) {
  // Accepts #rrggbb; otherwise returns the color unchanged with alpha ignored.
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n>>16)&255},${(n>>8)&255},${n&255},${a})`;
}

function formatTime(ts) {
  if (!Number.isFinite(ts) || ts <= 0) return new Date().toLocaleTimeString();
  return new Date(ts).toLocaleTimeString();
}

function setText(id, txt) {
  const el = document.getElementById(id);
  if (el) el.textContent = txt;
}

function setMetricState(cardId, state /* ok | warn | crit | null */) {
  const el = document.getElementById(cardId);
  if (!el) return;
  if (!state) el.removeAttribute('data-state');
  else el.setAttribute('data-state', state);
}

function setPill(id, text, cls /* ok|warn|crit|'' */) {
  const el = document.getElementById(id);
  if (!el) return;
  if (text !== undefined) el.textContent = text;
  el.className = 'pill' + (cls ? ' ' + cls : '');
}

// ---------- threshold storage ----------
function loadThresholds() {
  try {
    const raw = localStorage.getItem(THRESHOLD_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_THRESHOLDS };
    const parsed = JSON.parse(raw);
    const merged = {
      ...DEFAULT_THRESHOLDS,
      ...parsed,
      hr:    { ...DEFAULT_THRESHOLDS.hr,    ...(parsed.hr    || {}) },
      spo2:  { ...DEFAULT_THRESHOLDS.spo2,  ...(parsed.spo2  || {}) },
      sound: { ...DEFAULT_THRESHOLDS.sound, ...(parsed.sound || {}) },
    };
    delete merged.temp;
    return merged;
  } catch {
    return { ...DEFAULT_THRESHOLDS };
  }
}

function saveThresholds() {
  try {
    localStorage.setItem(THRESHOLD_STORAGE_KEY, JSON.stringify(thresholds));
  } catch {
    /* ignore quota / private-mode errors */
  }
}

function renderThresholdInputs() {
  document.getElementById('thr-hr-min').value  = thresholds.hr.min;
  document.getElementById('thr-hr-max').value  = thresholds.hr.max;
  document.getElementById('thr-hr-on').checked = !!thresholds.hr.on;

  document.getElementById('thr-spo2-min').value = thresholds.spo2.min;
  document.getElementById('thr-spo2-on').checked = !!thresholds.spo2.on;

  document.getElementById('thr-sound-max').value = thresholds.sound.max;
  document.getElementById('thr-sound-on').checked = !!thresholds.sound.on;

  document.getElementById('thr-prone-on').checked = !!thresholds.proneOn;
  document.getElementById('thr-apnea-on').checked = !!thresholds.apneaOn;
  document.getElementById('thr-beep-on').checked  = !!thresholds.beepOn;
}

function readThresholdInputs() {
  const num = (id) => Number(document.getElementById(id).value);
  const on  = (id) => document.getElementById(id).checked;
  return {
    hr:    { min: num('thr-hr-min'),   max: num('thr-hr-max'),  on: on('thr-hr-on') },
    spo2:  { min: num('thr-spo2-min'),                          on: on('thr-spo2-on') },
    sound: { max: num('thr-sound-max'),                          on: on('thr-sound-on') },
    proneOn: on('thr-prone-on'),
    apneaOn: on('thr-apnea-on'),
    beepOn:  on('thr-beep-on'),
  };
}

// ---------- toast system ----------
const toastState = new Map(); // source -> lastShownTs
let toastSeq = 0;

function chimeOnce() {
  if (!thresholds.beepOn) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(880, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(520, ctx.currentTime + 0.3);
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.45);
    o.connect(g); g.connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.5);
  } catch { /* noop */ }
}

function showToast({ title, msg, sev = 'info', source, ttlMs = 7000, force = false }) {
  const now = Date.now();
  if (source && !force) {
    const prev = toastState.get(source);
    if (prev && now - prev < TOAST_COOLDOWN_MS) return;
    toastState.set(source, now);
  }

  const stack = document.getElementById('toast-stack');
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('data-sev', sev);
  el.setAttribute('data-id', String(++toastSeq));

  const icon = sev === 'critical' ? '!' : sev === 'warning' ? '!' : 'i';

  el.innerHTML = `
    <div class="icon" aria-hidden="true">${icon}</div>
    <div class="body">
      <div class="title"></div>
      <div class="msg"></div>
    </div>
    <button class="close" aria-label="Dismiss">&times;</button>
  `;
  el.querySelector('.title').textContent = title;
  el.querySelector('.msg').textContent = msg || '';

  const dismiss = () => {
    if (el.classList.contains('leaving')) return;
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 200);
  };
  el.querySelector('.close').addEventListener('click', dismiss);

  stack.appendChild(el);
  if (sev !== 'critical') setTimeout(dismiss, ttlMs);
  chimeOnce();
}

// ---------- apnea / threshold detection ----------
let prevAlertActive = false;
let prevAlertName = '';

function evaluateAlerts(reading) {
  const isBed  = reading._kind === 'bedside';
  const isBody = reading._kind === 'body';

  if (isBody) {
    const alertActive = !!reading.alertActive;
    const name = reading.alertName || '';
    const roseEdge = alertActive && !prevAlertActive;
    const nameChanged = alertActive && name && name !== prevAlertName;

    if ((roseEdge || nameChanged) && thresholds.apneaOn) {
      const severity = 'critical';
      const title =
        name === 'VITALS'   ? 'Apnea event: vitals' :
        name === 'POSITION' ? 'Apnea risk: prone position' :
        name === 'COMBINED' ? 'Apnea event: combined' :
                              'Apnea event detected';
      const msg =
        name === 'VITALS'   ? 'Low SpO₂ or heart-rate drop detected by the wearable.' :
        name === 'POSITION' ? 'Sleeper has been prone for an extended period.' :
        name === 'COMBINED' ? 'Prone position with abnormal vitals — check on the sleeper.' :
                              'The wearable triggered an apnea alert.';
      showToast({ title, msg, sev: severity, source: 'apnea:' + name, force: true });
    }
    showBanner(alertActive, name);

    prevAlertActive = alertActive;
    prevAlertName   = alertActive ? name : '';

    if (thresholds.hr.on && Number.isFinite(reading.heartRate) && reading.heartRate > 0) {
      if (reading.heartRate < thresholds.hr.min) {
        showToast({ title: 'Low heart rate',
          msg: `HR ${Math.round(reading.heartRate)} bpm is below your minimum of ${thresholds.hr.min} bpm.`,
          sev: 'warning', source: 'hr-low' });
      } else if (reading.heartRate > thresholds.hr.max) {
        showToast({ title: 'High heart rate',
          msg: `HR ${Math.round(reading.heartRate)} bpm exceeds your maximum of ${thresholds.hr.max} bpm.`,
          sev: 'warning', source: 'hr-high' });
      }
    }
    if (thresholds.spo2.on && Number.isFinite(reading.spo2) && reading.spo2 > 0) {
      if (reading.spo2 < thresholds.spo2.min) {
        showToast({ title: 'Low blood oxygen',
          msg: `SpO₂ ${Math.round(reading.spo2)}% is below your minimum of ${thresholds.spo2.min}%.`,
          sev: reading.spo2 < 90 ? 'critical' : 'warning',
          source: 'spo2-low',
          force: reading.spo2 < 88 });
      }
    }
    if (thresholds.proneOn && reading.prone === true) {
      showToast({ title: 'Prone position',
        msg: 'Sleeper is face down. Consider repositioning.',
        sev: 'warning', source: 'prone' });
    }
  }

  if (isBed) {
    if (thresholds.sound.on && Number.isFinite(reading.soundActivity)) {
      if (reading.soundActivity > thresholds.sound.max) {
        showToast({ title: 'Loud sound activity',
          msg: `Sound level ${Math.round(reading.soundActivity)} is above your threshold of ${thresholds.sound.max}. Possible loud snoring.`,
          sev: 'warning', source: 'sound-high' });
      }
    }
  }
}

function showBanner(active, name) {
  const b = document.getElementById('alert-banner');
  const t = document.getElementById('alert-banner-text');
  if (!b || !t) return;
  if (active) {
    t.textContent = name
      ? `${name === 'POSITION' ? 'Prone position' : name === 'VITALS' ? 'Vitals apnea' : name === 'COMBINED' ? 'Combined apnea' : 'Apnea'} event — check on the sleeper`
      : 'Apnea event detected';
    b.classList.add('active');
  } else {
    b.classList.remove('active');
  }
}

// ---------- data ingestion ----------
function pruneBuffer(buf, now) {
  while (buf.length && now - buf[0].t > AVG_WINDOW_MS) buf.shift();
}

function handleBedside(reading) {
  const ts = Number(reading.timestamp);
  const time = Number.isFinite(ts) ? formatTime(ts) : formatTime(Date.now());

  const pressure = Number(reading.pressure);
  const sound    = Number(reading.soundActivity);

  bedsideLabels.push(time);
  pressureData.push(Number.isFinite(pressure) ? pressure : null);
  soundData.push(Number.isFinite(sound) ? sound : null);

  while (bedsideLabels.length > MAX_POINTS) {
    bedsideLabels.shift();
    pressureData.shift();
    soundData.shift();
  }

  // Live values
  setText('pressure-val', Number.isFinite(pressure) ? pressure.toFixed(1) : '--');
  setText('sound-val',    Number.isFinite(sound) ? String(Math.round(sound)) : '--');

  // Sound state
  if (Number.isFinite(sound)) {
    const loud = thresholds.sound.on && sound > thresholds.sound.max;
    setMetricState('card-sound', loud ? 'warn' : null);
    setPill('sound-pill', loud ? 'loud — possible snoring' : 'snoring / breath', loud ? 'warn' : '');
  }

  const now = Number.isFinite(ts) ? ts : Date.now();
  bedsideBuffer.push({ t: now, pressure, sound });
  pruneBuffer(bedsideBuffer, now);

  updateAverages();
  setText('now-updated', 'Updated ' + formatTime(now));

  evaluateAlerts({ ...reading, _kind: 'bedside' });

  envChart.update();
  soundChart.update();
}

function handleBody(reading) {
  const ts = Number(reading.timestamp);
  const time = Number.isFinite(ts) ? formatTime(ts) : formatTime(Date.now());

  const hr    = Number(reading.heartRate);
  const spo2  = Number(reading.spo2);
  const prone = reading.prone;
  const alertActive = !!reading.alertActive;
  const alertName   = reading.alertName;

  // vitals chart
  vitalsLabels.push(time);
  hrData.push(Number.isFinite(hr) && hr > 0 ? hr : null);
  spo2Data.push(Number.isFinite(spo2) && spo2 > 0 ? spo2 : null);
  while (vitalsLabels.length > MAX_POINTS) {
    vitalsLabels.shift();
    hrData.shift();
    spo2Data.shift();
  }
  vitalsChart.update();

  // HR card
  if (Number.isFinite(hr) && hr > 0) {
    setText('hr-val', String(Math.round(hr)));
    const hiA = thresholds.hr.on && hr > thresholds.hr.max;
    const loA = thresholds.hr.on && hr < thresholds.hr.min;
    setMetricState('card-hr', hiA ? 'crit' : loA ? 'warn' : null);
    setPill('hr-pill',
      hiA ? 'high' : loA ? 'low' : hr > 100 ? 'elevated' : 'resting',
      hiA ? 'crit' : loA ? 'warn' : '');
  } else {
    setText('hr-val', '--');
    setMetricState('card-hr', null);
    setPill('hr-pill', 'no signal', '');
  }

  // SpO2 card
  if (Number.isFinite(spo2) && spo2 > 0) {
    setText('spo2-val', String(Math.round(spo2)));
    const below = thresholds.spo2.on && spo2 < thresholds.spo2.min;
    const critBelow = below && spo2 < 90;
    setMetricState('card-spo2', critBelow ? 'crit' : below ? 'warn' : null);
    setPill('spo2-pill',
      critBelow ? 'critical' : below ? 'below target' : 'SpO₂',
      critBelow ? 'crit' : below ? 'warn' : '');
  } else {
    setText('spo2-val', '--');
    setMetricState('card-spo2', null);
    setPill('spo2-pill', 'no signal', '');
  }

  // Position card
  if (prone === true) {
    setText('position-val', 'Prone');
    setMetricState('card-position', thresholds.proneOn ? 'warn' : null);
    setPill('position-pill', 'face down', thresholds.proneOn ? 'warn' : '');
  } else if (prone === false) {
    setText('position-val', 'Supine');
    setMetricState('card-position', null);
    setPill('position-pill', 'face up', 'ok');
  } else {
    setText('position-val', '--');
    setMetricState('card-position', null);
    setPill('position-pill', 'sleep posture', '');
  }

  // Alert card
  if (alertActive) {
    setText('alert-val', alertName || 'ACTIVE');
    setMetricState('card-alert', 'crit');
    setPill('alert-pill', 'apnea event', 'crit');
  } else {
    setText('alert-val', 'All clear');
    setMetricState('card-alert', null);
    setPill('alert-pill', 'device state', 'ok');
  }

  const now = Number.isFinite(ts) ? ts : Date.now();
  bodyBuffer.push({ t: now, hr, spo2, prone });
  pruneBuffer(bodyBuffer, now);

  updateAverages();
  setText('now-updated', 'Updated ' + formatTime(now));
  evaluateAlerts({ ...reading, _kind: 'body' });
}

// ---------- averages ----------
function avgMinMax(vals) {
  const nums = vals.filter((v) => Number.isFinite(v));
  if (!nums.length) return null;
  let sum = 0, min = Infinity, max = -Infinity;
  for (const v of nums) { sum += v; if (v < min) min = v; if (v > max) max = v; }
  return { avg: sum / nums.length, min, max, n: nums.length };
}

function updateAverages() {
  const now = Date.now();
  pruneBuffer(bedsideBuffer, now);
  pruneBuffer(bodyBuffer, now);

  const hr = avgMinMax(bodyBuffer.map((r) => r.hr));
  const sp = avgMinMax(bodyBuffer.map((r) => r.spo2));
  const sn = avgMinMax(bedsideBuffer.map((r) => r.sound));

  setText('avg-hr',   hr ? Math.round(hr.avg) : '--');
  setText('range-hr', hr ? `min ${Math.round(hr.min)} · max ${Math.round(hr.max)}` : 'min -- · max --');

  setText('avg-spo2', sp ? Math.round(sp.avg) : '--');
  setText('range-spo2', sp ? `min ${Math.round(sp.min)} · max ${Math.round(sp.max)}` : 'min -- · max --');

  setText('avg-sound', sn ? Math.round(sn.avg) : '--');
  setText('range-sound', sn ? `min ${Math.round(sn.min)} · max ${Math.round(sn.max)}` : 'min -- · max --');
}

// ---------- dispatch ----------
function pushPoint(reading) {
  if (reading._key) {
    if (seenKeys.has(reading._key)) return;
    seenKeys.add(reading._key);
  }
  const name = (reading.nodeName || '').toUpperCase().trim();
  if (name === 'BEDSIDE') handleBedside(reading);
  else if (name === 'BODY') handleBody(reading);
}

// ---------- gateway ----------
function updateGateway(status) {
  const dot = document.getElementById('gw-dot');
  const label = document.getElementById('gw-status');
  const seen = document.getElementById('gw-last-seen');
  const pkts = document.getElementById('gw-packets');

  if (status && status.online) {
    dot.className = 'gw-dot online';
    label.textContent = 'Online';
    label.style.color = 'var(--ok)';
  } else {
    dot.className = 'gw-dot offline';
    label.textContent = 'Offline';
    label.style.color = 'var(--crit)';
  }
  seen.textContent = status && status.lastSeen
    ? new Date(status.lastSeen).toLocaleTimeString()
    : '--';
  pkts.textContent = String((status && status.packetsRelayed) || 0);
}

// ---------- socket wiring ----------
socket.on('gatewayStatus', updateGateway);
socket.on('newReading',    (data) => pushPoint(data));
socket.on('readingUpdate', (data) => {
  const name = (data.nodeName || '').toUpperCase().trim();
  if (name === 'BEDSIDE') handleBedside(data);
  else if (name === 'BODY') handleBody(data);
});
socket.on('cleared', () => location.reload());

// ---------- clear & test buttons ----------
document.getElementById('clear-btn').addEventListener('click', () => {
  if (!confirm('Clear all readings from the database?')) return;
  fetch('/api/readings', { method: 'DELETE' })
    .then((r) => r.json())
    .then(() => location.reload())
    .catch(() => showToast({
      title: 'Clear failed', msg: 'Could not clear readings.', sev: 'warning',
    }));
});

document.getElementById('test-toast-btn').addEventListener('click', () => {
  showToast({
    title: 'Apnea event detected',
    msg: 'This is a test notification. Real alerts look like this.',
    sev: 'critical',
    force: true,
    source: 'test-' + Date.now(),
  });
});

// ---------- threshold UI wiring ----------
renderThresholdInputs();

document.getElementById('thr-save').addEventListener('click', () => {
  const next = readThresholdInputs();
  if (!(next.hr.min < next.hr.max)) {
    showToast({ title: 'Invalid heart-rate range', msg: 'Min must be less than max.', sev: 'warning' });
    return;
  }
  thresholds = next;
  saveThresholds();
  showToast({ title: 'Thresholds saved', msg: 'Alerts now use your new limits.', sev: 'info', ttlMs: 4000 });
});

document.getElementById('thr-reset').addEventListener('click', () => {
  if (!confirm('Reset thresholds to defaults?')) return;
  thresholds = { ...DEFAULT_THRESHOLDS };
  saveThresholds();
  renderThresholdInputs();
  showToast({ title: 'Thresholds reset', msg: 'Defaults restored.', sev: 'info', ttlMs: 4000 });
});

// ---------- initial load ----------
fetch('/api/readings?limit=100')
  .then((r) => r.json())
  .then((readings) => {
    const sorted = [...readings].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    for (const r of sorted) pushPoint(r);
  })
  .catch(() => {});

fetch('/api/gateway-status')
  .then((r) => r.json())
  .then(updateGateway)
  .catch(() => {});

// ---------- polling fallback ----------
let lastSocketEvent = Date.now();
socket.on('newReading',    () => { lastSocketEvent = Date.now(); });
socket.on('readingUpdate', () => { lastSocketEvent = Date.now(); });

setInterval(() => {
  if (Date.now() - lastSocketEvent < 10000) return;
  fetch('/api/readings?limit=25')
    .then((r) => r.json())
    .then((readings) => {
      for (const row of readings) {
        const name = (row.nodeName || '').toUpperCase().trim();
        if (name === 'BEDSIDE') handleBedside(row);
        else if (name === 'BODY') handleBody(row);
      }
    })
    .catch(() => {});
}, 10000);

// Refresh averages periodically even without new data so the window rolls.
setInterval(updateAverages, 30000);
