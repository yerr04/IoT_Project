const socket = io();

const MAX_POINTS = 100;
const labels = [];
const tempData = [];
const pressureData = [];
const soundData = [];

let lastTimestamp = 0;

const envChart = new Chart(document.getElementById('envChart'), {
  type: 'line',
  data: {
    labels,
    datasets: [
      {
        label: 'Temperature (°C)',
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
        title: { display: true, text: '°C', color: '#7eb8f7' },
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
    labels,
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

function pushPoint(reading) {
  const ts = Number(reading.timestamp);
  if (Number.isFinite(ts) && ts <= lastTimestamp) return;
  if (Number.isFinite(ts)) lastTimestamp = ts;

  const time = formatTime(ts);
  const temp = Number(reading.temp);
  const pressure = Number(reading.pressure);
  const sound = Number(reading.soundActivity);

  labels.push(time);
  tempData.push(Number.isFinite(temp) ? temp : null);
  pressureData.push(Number.isFinite(pressure) ? pressure : null);
  soundData.push(Number.isFinite(sound) ? sound : null);

  if (labels.length > MAX_POINTS) {
    labels.shift();
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
  document.getElementById('node-val').textContent =
    reading.nodeName && String(reading.nodeName).trim()
      ? String(reading.nodeName).trim()
      : '--';

  envChart.update();
  soundChart.update();
}

function applyHistory(readings) {
  labels.length = 0;
  tempData.length = 0;
  pressureData.length = 0;
  soundData.length = 0;
  lastTimestamp = 0;

  const sorted = [...readings].sort(
    (a, b) => (a.timestamp || 0) - (b.timestamp || 0)
  );
  const slice = sorted.slice(-MAX_POINTS);
  for (const r of slice) {
    lastTimestamp = Math.max(lastTimestamp, Number(r.timestamp) || 0);
    const time = formatTime(Number(r.timestamp));
    labels.push(time);
    tempData.push(Number.isFinite(Number(r.temp)) ? Number(r.temp) : null);
    pressureData.push(
      Number.isFinite(Number(r.pressure)) ? Number(r.pressure) : null
    );
    soundData.push(
      Number.isFinite(Number(r.soundActivity))
        ? Number(r.soundActivity)
        : null
    );
  }

  if (slice.length) {
    const last = slice[slice.length - 1];
    const temp = Number(last.temp);
    const pressure = Number(last.pressure);
    const sound = Number(last.soundActivity);
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
    document.getElementById('node-val').textContent =
      last.nodeName && String(last.nodeName).trim()
        ? String(last.nodeName).trim()
        : '--';
  }

  envChart.update();
  soundChart.update();
}

fetch('/api/readings?limit=100')
  .then((r) => r.json())
  .then(applyHistory)
  .catch(() => {});

socket.on('newReading', (data) => {
  pushPoint(data);
});
