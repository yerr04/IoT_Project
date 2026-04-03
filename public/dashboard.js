const socket = io();

const MAX_POINTS = 100;
const seenKeys = new Set();

const bedsideLabels = [];
const tempData = [];
const pressureData = [];
const soundData = [];
let bedsideSeq = 0;

const envChart = new Chart(document.getElementById('envChart'), {
  type: 'line',
  data: {
    labels: bedsideLabels,
    datasets: [
      {
        label: 'Temperature (\u00B0C)',
        data: tempData,
        borderColor: '#7eb8f7',
        backgroundColor: 'rgba(126,184,247,0.1)',
        tension: 0.3,
        fill: true,
        yAxisID: 'y',
      },
      {
        label: 'Pressure (hPa)',
        data: pressureData,
        borderColor: '#f7c77e',
        backgroundColor: 'rgba(247,199,126,0.08)',
        tension: 0.3,
        fill: true,
        yAxisID: 'p',
      },
    ],
  },
  options: {
    animation: false,
    plugins: { legend: { labels: { color: '#ccc' } } },
    scales: {
      x: { ticks: { color: '#888' }, grid: { color: '#2a2d3e' } },
      y: {
        ticks: { color: '#7eb8f7' },
        grid: { color: '#2a2d3e' },
        title: { display: true, text: '\u00B0C', color: '#7eb8f7' },
      },
      p: {
        position: 'right',
        ticks: { color: '#f7c77e' },
        grid: { drawOnChartArea: false },
        title: { display: true, text: 'hPa', color: '#f7c77e' },
      },
    },
  },
});

const soundChart = new Chart(document.getElementById('soundChart'), {
  type: 'line',
  data: {
    labels: bedsideLabels,
    datasets: [
      {
        label: 'Sound activity (mic range)',
        data: soundData,
        borderColor: '#7ef7a0',
        backgroundColor: 'rgba(126,247,160,0.05)',
        tension: 0.2,
        fill: true,
        pointRadius: 0,
      },
    ],
  },
  options: {
    animation: false,
    plugins: { legend: { labels: { color: '#ccc' } } },
    scales: {
      x: { ticks: { color: '#888' }, grid: { color: '#2a2d3e' } },
      y: { ticks: { color: '#7ef7a0' }, grid: { color: '#2a2d3e' }, min: 0 },
    },
  },
});

function formatTime(ts) {
  if (!Number.isFinite(ts) || ts <= 0) return new Date().toLocaleTimeString();
  return new Date(ts).toLocaleTimeString();
}

function handleBedside(reading) {
  bedsideSeq++;
  const ts = Number(reading.timestamp);
  const time = Number.isFinite(ts) ? formatTime(ts) : formatTime(Date.now());

  const temp = Number(reading.temp);
  const pressure = Number(reading.pressure);
  const sound = Number(reading.soundActivity);

  bedsideLabels.push(time);
  tempData.push(Number.isFinite(temp) ? temp : null);
  pressureData.push(Number.isFinite(pressure) ? pressure : null);
  soundData.push(Number.isFinite(sound) ? sound : null);

  if (bedsideLabels.length > MAX_POINTS) {
    bedsideLabels.shift();
    tempData.shift();
    pressureData.shift();
    soundData.shift();
  }

  document.getElementById('temp-val').textContent = Number.isFinite(temp)
    ? temp.toFixed(1)
    : '--';
  document.getElementById('pressure-val').textContent = Number.isFinite(
    pressure
  )
    ? pressure.toFixed(1)
    : '--';
  document.getElementById('sound-val').textContent = Number.isFinite(sound)
    ? String(Math.round(sound))
    : '--';

  envChart.update();
  soundChart.update();
}

function handleBody(reading) {
  const hr = Number(reading.heartRate);
  const spo2 = Number(reading.spo2);
  const prone = reading.prone;
  const alertActive = reading.alertActive;
  const alertName = reading.alertName;

  const hrEl = document.getElementById('hr-val');
  hrEl.textContent = Number.isFinite(hr) && hr > 0 ? String(Math.round(hr)) : '--';
  hrEl.className = '';

  const spo2El = document.getElementById('spo2-val');
  if (Number.isFinite(spo2) && spo2 >= 0) {
    spo2El.textContent = String(Math.round(spo2));
    spo2El.className = spo2 < 90 ? 'alert' : spo2 < 95 ? 'warn' : '';
  } else {
    spo2El.textContent = '--';
    spo2El.className = '';
  }

  const posEl = document.getElementById('position-val');
  if (prone === true) {
    posEl.textContent = 'Prone';
    posEl.className = 'warn';
  } else if (prone === false) {
    posEl.textContent = 'Supine';
    posEl.className = '';
  } else {
    posEl.textContent = '--';
    posEl.className = '';
  }

  const alertEl = document.getElementById('alert-val');
  if (alertActive) {
    alertEl.textContent = alertName || 'ACTIVE';
    alertEl.className = 'alert';
  } else {
    alertEl.textContent = 'None';
    alertEl.className = '';
  }
}

function pushPoint(reading) {
  if (reading._key) {
    if (seenKeys.has(reading._key)) return;
    seenKeys.add(reading._key);
  }

  const name = (reading.nodeName || '').toUpperCase().trim();
  if (name === 'BEDSIDE') {
    handleBedside(reading);
  } else if (name === 'BODY') {
    handleBody(reading);
  }
}

// --- Gateway status ---
function updateGateway(status) {
  const dot = document.getElementById('gw-dot');
  const label = document.getElementById('gw-status');
  const seen = document.getElementById('gw-last-seen');
  const pkts = document.getElementById('gw-packets');

  if (status.online) {
    dot.className = 'gw-dot online';
    label.textContent = 'Online';
    label.style.color = '#4caf50';
  } else {
    dot.className = 'gw-dot offline';
    label.textContent = 'Offline';
    label.style.color = '#f44336';
  }
  seen.textContent = status.lastSeen
    ? new Date(status.lastSeen).toLocaleTimeString()
    : '--';
  pkts.textContent = String(status.packetsRelayed || 0);
}

socket.on('gatewayStatus', updateGateway);

socket.on('newReading', (data) => {
  pushPoint(data);
});

socket.on('readingUpdate', (data) => {
  const name = (data.nodeName || '').toUpperCase().trim();
  if (name === 'BEDSIDE') handleBedside(data);
  else if (name === 'BODY') handleBody(data);
});

socket.on('cleared', () => {
  location.reload();
});

// --- Clear button ---
document.getElementById('clear-btn').addEventListener('click', () => {
  if (!confirm('Clear all readings from the database?')) return;
  fetch('/api/readings', { method: 'DELETE' })
    .then((r) => r.json())
    .then(() => location.reload())
    .catch(() => alert('Failed to clear readings'));
});

// --- Initial data load ---
fetch('/api/readings?limit=100')
  .then((r) => r.json())
  .then((readings) => {
    const sorted = [...readings].sort(
      (a, b) => (a.timestamp || 0) - (b.timestamp || 0)
    );
    for (const r of sorted) {
      pushPoint(r);
    }
  })
  .catch(() => {});

fetch('/api/gateway-status')
  .then((r) => r.json())
  .then(updateGateway)
  .catch(() => {});

// Polling fallback: only fires when the socket hasn't delivered data recently
let lastSocketEvent = Date.now();
socket.on('newReading', () => { lastSocketEvent = Date.now(); });
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
