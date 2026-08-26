const https = require('https');
const net = require('net');

const geoCache = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const GEOIP_ENABLED = process.env.GEOIP_ENABLED === 'true';

function countryCodeToFlag(countryCode) {
  if (!countryCode || countryCode.length !== 2 || countryCode === 'LAN') {
    return '🌐';
  }
  const codePoints = countryCode
    .toUpperCase()
    .split('')
    .map(char => 127397 + char.charCodeAt(0));
  return String.fromCodePoint(...codePoints);
}

function isPrivateIp(ip) {
  if (!ip) return true;
  if (ip === 'localhost') return true;
  const version = net.isIP(ip);
  if (version === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 0;
  }
  if (version === 6) {
    const normalized = ip.toLowerCase();
    return normalized === '::1' || normalized === '::' || normalized.startsWith('fc') ||
      normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') ||
      normalized.startsWith('fea') || normalized.startsWith('feb');
  }
  return true;
}

async function lookupIp(ip) {
  if (!ip || isPrivateIp(ip) || !GEOIP_ENABLED) {
    return {
      country: GEOIP_ENABLED ? 'Private Network' : 'Location private',
      countryCode: 'LAN',
      city: 'Local Tunnel',
      org: 'VPN Subnet',
      flag: '🔒'
    };
  }

  // Check cache
  if (geoCache.has(ip)) {
    const cached = geoCache.get(ip);
    if (cached.expiresAt > Date.now()) return cached.value;
    geoCache.delete(ip);
  }

  return new Promise((resolve) => {
    const request = https.get(`https://ipwho.is/${encodeURIComponent(ip)}?fields=success,country,country_code,city,connection`, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.success) {
            const result = {
              country: json.country || 'Unknown',
              countryCode: json.country_code || '',
              city: json.city || '',
              org: json.connection?.org || '',
              flag: countryCodeToFlag(json.country_code)
            };
            geoCache.set(ip, { value: result, expiresAt: Date.now() + CACHE_TTL_MS });
            return resolve(result);
          }
        } catch (e) {}
        resolve({
          country: 'Unknown',
          countryCode: '',
          city: '',
          org: '',
          flag: '🌐'
        });
      });
    });
    request.setTimeout(2500, () => request.destroy());
    request.on('error', () => {
      resolve({
        country: 'Unknown',
        countryCode: '',
        city: '',
        org: '',
        flag: '🌐'
      });
    });
  });
}

module.exports = {
  lookupIp,
  countryCodeToFlag,
  isPrivateIp
};
