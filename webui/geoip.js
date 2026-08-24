const http = require('http');

const geoCache = new Map();

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
  if (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') return true;
  if (ip.startsWith('10.') || ip.startsWith('192.168.') || ip.startsWith('172.16.') || ip.startsWith('172.17.') || ip.startsWith('172.18.') || ip.startsWith('172.19.') || ip.startsWith('172.20.')) {
    return true;
  }
  return false;
}

async function lookupIp(ip) {
  if (!ip || isPrivateIp(ip)) {
    return {
      country: 'Private Network',
      countryCode: 'LAN',
      city: 'Local Tunnel',
      org: 'VPN Subnet',
      flag: '🔒'
    };
  }

  // Check cache
  if (geoCache.has(ip)) {
    return geoCache.get(ip);
  }

  return new Promise((resolve) => {
    const url = `http://ip-api.com/json/${ip}?fields=status,country,countryCode,city,org`;
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.status === 'success') {
            const result = {
              country: json.country || 'Unknown',
              countryCode: json.countryCode || '',
              city: json.city || '',
              org: json.org || '',
              flag: countryCodeToFlag(json.countryCode)
            };
            geoCache.set(ip, result);
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
    }).on('error', () => {
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
  countryCodeToFlag
};
