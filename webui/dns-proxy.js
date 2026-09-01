const dns2 = require('dns2');
const db = require('./db');
const adblock = require('./adblock');

const UPSTREAM_DNS = process.env.UPSTREAM_DNS || '1.1.1.1';
const DNS_PORT = parseInt(process.env.DNS_PORT || '53', 10);

// In-memory mapping of IP -> Username for quick lookup
const clientIpMap = new Map();

function updateClientIpMap(ip, username) {
  if (ip && username) {
    clientIpMap.set(ip, username);
  }
}

function startDnsProxy() {
  const { Packet } = dns2;

  // Upstream recursive resolver client
  const upstream = new dns2({
    dns: UPSTREAM_DNS
  });

  const server = dns2.createServer({
    udp: true,
    tcp: true,
    handle: async (request, send, client) => {
      const response = Packet.createResponseFromRequest(request);
      const clientIp = (client && client.address) ? client.address : '127.0.0.1';
      const clientName = clientIpMap.get(clientIp) || 'VPN Client';

      // Check if client has AdBlock enabled
      const adblockActive = db.isClientAdblockEnabled(clientName);

      for (const question of request.questions) {
        const domain = question.name;
        const qtype = Packet.TYPE[question.type] || 'A';

        // Check Ad & Malware Blocklist
        if (adblockActive && adblock.isBlocked(domain)) {
          // Return 0.0.0.0 for A query or empty for others
          if (question.type === Packet.TYPE.A) {
            response.answers.push({
              name: domain,
              type: Packet.TYPE.A,
              class: Packet.CLASS.IN,
              ttl: 60,
              address: '0.0.0.0'
            });
          }
          continue;
        }

        try {
          // Resolve with upstream DNS
          const result = await upstream.resolve(domain, qtype);
          if (result && result.answers) {
            response.answers.push(...result.answers);
          }
          if (result && result.authorities) {
            response.authorities.push(...result.authorities);
          }
        } catch (err) {
          // Upstream resolution timeout/error
        }
      }

      send(response);
    }
  });

  server.on('listening', () => {
    console.log(`[DNS Proxy] Listening on UDP/TCP port ${DNS_PORT} (AdBlock: ${adblock.getBlocklistSize()} rules)`);
  });

  server.on('error', (err) => {
    console.error(`[DNS Proxy] Error:`, err.message);
  });

  server.listen({
    udp: { port: DNS_PORT, address: '0.0.0.0' },
    tcp: { port: DNS_PORT, address: '0.0.0.0' }
  });

  return server;
}

module.exports = {
  startDnsProxy,
  updateClientIpMap
};
