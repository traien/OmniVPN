const fs = require('fs');
const path = require('path');

const PROC_ROOT = process.env.HOST_PROC || '/proc';

function readProc(name) {
  return fs.readFileSync(path.join(PROC_ROOT, name), 'utf8');
}

function getSystemMetrics() {
  try {
    const uptimeSeconds = Number.parseFloat(readProc('uptime').split(/\s+/)[0]);
    const loadAverage = Number.parseFloat(readProc('loadavg').split(/\s+/)[0]);
    const mem = Object.fromEntries(readProc('meminfo').split('\n').filter(Boolean).map((line) => {
      const [key, value] = line.split(':');
      return [key, Number.parseInt(value, 10) || 0];
    }));
    const total = mem.MemTotal || 1;
    const available = mem.MemAvailable || mem.MemFree || 0;
    return {
      uptimeSeconds,
      loadAverage: loadAverage.toFixed(2),
      memoryUsagePercent: Math.round(((total - available) / total) * 100),
      scope: PROC_ROOT === '/proc' ? 'container' : 'host'
    };
  } catch {
    return { uptimeSeconds: 0, loadAverage: '0.00', memoryUsagePercent: 0, scope: 'unavailable' };
  }
}

module.exports = { getSystemMetrics, PROC_ROOT };
