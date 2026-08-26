const fs = require('fs');
const path = require('path');
const { PROC_ROOT } = require('./system-metrics');

let prevRx = 0;
let prevTx = 0;
let prevTime = Date.now();
const MAX_HISTORY = 30;
const history = [];

let currentStats = {
  rxSpeedMbps: 0,
  txSpeedMbps: 0,
  rxFormatted: '0 Mbps',
  txFormatted: '0 Mbps'
};

function formatSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec < 0) return '0 KB/s';
  const bitsPerSec = bytesPerSec * 8;
  if (bitsPerSec >= 1000000) {
    return (bitsPerSec / 1000000).toFixed(2) + ' Mbps';
  }
  return (bytesPerSec / 1024).toFixed(1) + ' KB/s';
}

function readNetworkBytes() {
  try {
    const data = fs.readFileSync(path.join(PROC_ROOT, 'net/dev'), 'utf8');
    const lines = data.split('\n');
    let totalRx = 0;
    let totalTx = 0;

    for (const line of lines) {
      if (!line.includes(':') || line.includes('lo:')) continue;
      const parts = line.split(':')[1].trim().split(/\s+/);
      if (parts.length >= 9) {
        totalRx += parseInt(parts[0], 10) || 0;
        totalTx += parseInt(parts[8], 10) || 0;
      }
    }
    return { rx: totalRx, tx: totalTx };
  } catch (err) {
    return { rx: 0, tx: 0 };
  }
}

function sample() {
  const now = Date.now();
  const bytes = readNetworkBytes();
  const timeDiff = (now - prevTime) / 1000;

  if (prevRx > 0 && prevTx > 0 && timeDiff > 0.5) {
    const rxDiff = Math.max(0, bytes.rx - prevRx);
    const txDiff = Math.max(0, bytes.tx - prevTx);

    const rxBytesPerSec = rxDiff / timeDiff;
    const txBytesPerSec = txDiff / timeDiff;

    const rxMbps = parseFloat(((rxBytesPerSec * 8) / 1000000).toFixed(2));
    const txMbps = parseFloat(((txBytesPerSec * 8) / 1000000).toFixed(2));

    currentStats = {
      rxSpeedMbps: rxMbps,
      txSpeedMbps: txMbps,
      rxFormatted: formatSpeed(rxBytesPerSec),
      txFormatted: formatSpeed(txBytesPerSec)
    };

    const d = new Date(now);
    const timeLabel = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    history.push({
      time: timeLabel,
      rxMbps,
      txMbps,
      rxFormatted: currentStats.rxFormatted,
      txFormatted: currentStats.txFormatted
    });

    if (history.length > MAX_HISTORY) {
      history.shift();
    }
  }

  prevRx = bytes.rx;
  prevTx = bytes.tx;
  prevTime = now;
}

// Initial sample
const initialBytes = readNetworkBytes();
prevRx = initialBytes.rx;
prevTx = initialBytes.tx;

// Sample every 2 seconds
setInterval(sample, 2000);

function getBandwidthData() {
  return {
    current: currentStats,
    history
  };
}

module.exports = {
  getBandwidthData
};
