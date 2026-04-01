const socket = io();

const MAX_POINTS = 100;
const labels = [];
const spo2Data = [];
const hrData = [];
const irData = [];

const spo2Chart = new Chart(document.getElementById('spo2Chart'), {
  type: 'line',
  data: {
    labels,
    datasets: [
      {
        label: 'SpO2 (%)',
        data: spo2Data,
        borderColor: '#7eb8f7',
        backgroundColor: 'rgba(126,184,247,0.1)',
        tension: 0.3,
        fill: true,
        yAxisID: 'y',
      },
      {
        label: 'Heart Rate (BPM)',
        data: hrData,
        borderColor: '#f77e7e',
        backgroundColor: 'rgba(247,126,126,0.1)',
        tension: 0.3,
        fill: true,
        yAxisID: 'hr',
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
        min: 85,
        max: 100,
        title: { display: true, text: 'SpO2 %', color: '#7eb8f7' },
      },
      hr: {
        position: 'right',
        ticks: { color: '#f77e7e' },
        grid: { drawOnChartArea: false },
        title: { display: true, text: 'BPM', color: '#f77e7e' },
      },
    },
  },
});

const breathingChart = new Chart(document.getElementById('breathingChart'), {
  type: 'line',
  data: {
    labels,
    datasets: [
      {
        label: 'IR Signal (Breathing)',
        data: irData,
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
      y: { ticks: { color: '#7ef7a0' }, grid: { color: '#2a2d3e' } },
    },
  },
});

socket.on('newReading', (data) => {
  const time = new Date().toLocaleTimeString();
  const spo2 = Number(data.spo2);
  const hr = Number(data.heartRate);
  const ir = Number(data.irValue);

  labels.push(time);
  spo2Data.push(Number.isFinite(spo2) ? spo2 : null);
  hrData.push(Number.isFinite(hr) ? hr : null);
  irData.push(Number.isFinite(ir) ? ir : null);

  if (labels.length > MAX_POINTS) {
    labels.shift();
    spo2Data.shift();
    hrData.shift();
    irData.shift();
  }

  document.getElementById('spo2-val').textContent = Number.isFinite(spo2)
    ? spo2.toFixed(1)
    : '--';
  document.getElementById('hr-val').textContent = Number.isFinite(hr)
    ? hr.toFixed(0)
    : '--';
  document.getElementById('node-val').textContent =
    data.nodeId != null ? `Node ${data.nodeId}` : '--';

  spo2Chart.update();
  breathingChart.update();
});
