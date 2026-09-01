const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');
const { ZipArchive } = require('archiver');
const db = require('./db');
const adblock = require('./adblock');
const protocols = require('./protocols');
const { VPN_CONTAINER, restartContainer, runDockerExec, runFile } = require('./command');
const { getSystemMetrics } = require('./system-metrics');
const { createEncryptedArchive, decryptArchive, validateAndExtract } = require('./backup');
const {
  authMiddleware,
  clearSessionCookie,
  createRateLimiter,
  isAuthenticated,
  passwordMatches,
  sameOriginMiddleware,
  securityHeaders,
  setSessionCookie
} = require('./security');

const { startDnsProxy, updateClientIpMap } = require('./dns-proxy');
const { lookupIp } = require('./geoip');
const { getBandwidthData } = require('./bandwidth');

const app = express();
const PORT = process.env.WEBUI_PORT || 8080;
const SERVER_IP = process.env.VPN_PUBLIC_IP || '';
const VPN_PSK = process.env.VPN_IPSEC_PSK || '';
const ANDROID_CERTIFICATE_PASSWORD = 'omnivpn';

if (!SERVER_IP || !VPN_PSK) {
  throw new Error('VPN_PUBLIC_IP and VPN_IPSEC_PSK are required. Refusing to start with embedded defaults.');
}

if (process.env.WEBUI_TRUST_PROXY === 'true') app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(securityHeaders);
app.use(express.json({ limit: '32kb', strict: true }));
app.use(cookieParser());
app.use(sameOriginMiddleware);
app.use(express.static(path.join(__dirname, 'public'), { etag: true, maxAge: 0 }));
app.use('/vendor/qrcode', express.static(path.join(__dirname, 'node_modules', 'qrcodejs'), { maxAge: '7d' }));

app.get('/healthz', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ status: 'ok' });
});

// Initialize DB, AdBlock, and WG/SS Protocols
try {
  protocols.initProtocols();
} catch (e) {
  console.error("Failed to init extra protocols:", e);
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function sendServerError(res, err, message = 'The operation could not be completed.') {
  console.error('[API]', err);
  if (!res.headersSent) res.status(500).json({ error: message });
}

function copyDirectoryContents(source, destination) {
  if (!fs.existsSync(source)) return;
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const entry of fs.readdirSync(source)) {
    fs.cpSync(path.join(source, entry), path.join(destination, entry), {
      recursive: true,
      force: true,
      preserveTimestamps: true
    });
  }
}

// -----------------------------------------------------------------------------
// Live Connected Devices Discovery & GeoIP Telemetry
// -----------------------------------------------------------------------------
async function discoverConnectedDevices() {
  const devices = [];
  try {
    const [trafficRes, statusRes, pppRes, wireguardRes] = await Promise.all([
      runDockerExec(['ipsec', 'whack', '--trafficstatus']),
      runDockerExec(['ipsec', 'status']),
      runDockerExec(['sh', '-c', 'ip -o -4 addr show 2>/dev/null || true']),
      runFile('docker', ['exec', 'wireguard', 'wg', 'show', 'wg0', 'dump'])
    ]);

    // 1. Parse trafficstatus (IKEv2 & IPsec Child SAs)
    if (trafficRes.success && trafficRes.output) {
      const lines = trafficRes.output.split('\n');
      for (const line of lines) {
        if (!line.trim() || line.startsWith('000')) continue;
        
        const remoteIpMatch = line.match(/"[^"]+"(?:\[\d+\])?\s+([0-9.]+)/);
        const idMatch = line.match(/id='([^']+)'/);
        const leaseMatch = line.match(/lease=([0-9.]+)/);
        const inBytesMatch = line.match(/inBytes=(\d+)/);
        const outBytesMatch = line.match(/outBytes=(\d+)/);
        const addTimeMatch = line.match(/add_time=(\d+)/);
        const connNameMatch = line.match(/"([^"]+)"/);
        const stateMatch = line.match(/#(\d+):/);

        if (remoteIpMatch) {
          const remoteIp = remoteIpMatch[1];
          let username = idMatch ? idMatch[1] : (connNameMatch ? connNameMatch[1] : 'Unknown');
          
          if (username.startsWith('CN=')) {
            const cnMatch = username.match(/CN=([^,]+)/);
            if (cnMatch) username = cnMatch[1];
          }

          const virtualIp = leaseMatch ? leaseMatch[1] : 'Assigned';
          const inBytes = inBytesMatch ? parseInt(inBytesMatch[1], 10) : 0;
          const outBytes = outBytesMatch ? parseInt(outBytesMatch[1], 10) : 0;
          const addTime = addTimeMatch ? parseInt(addTimeMatch[1], 10) : null;
          const stateId = stateMatch ? stateMatch[1] : null;
          
          if (virtualIp && virtualIp !== 'Assigned') {
            updateClientIpMap(virtualIp, username);
          }

          let duration = 'Active';
          if (addTime) {
            const diffSeconds = Math.floor(Date.now() / 1000) - addTime;
            const mins = Math.floor(diffSeconds / 60);
            const hrs = Math.floor(mins / 60);
            duration = hrs > 0 ? `${hrs}h ${mins % 60}m` : `${mins}m ${diffSeconds % 60}s`;
          }

          let proto = 'IPsec';
          if (line.includes('ikev2')) proto = 'IKEv2';
          else if (line.includes('l2tp')) proto = 'L2TP/IPsec';
          else if (line.includes('xauth')) proto = 'IPsec/XAuth';

          devices.push({
            id: 'sa_' + (addTime || randomUUID()),
            stateId,
            username,
            remoteIp,
            virtualIp,
            protocol: proto,
            geo: null,
            inBytesFormatted: formatBytes(inBytes),
            outBytesFormatted: formatBytes(outBytes),
            duration,
            connectedAt: addTime ? new Date(addTime * 1000).toISOString() : new Date().toISOString()
          });
        }
      }
    }

    // 2. Fallback: Parse active SAs from ipsec status
    if (devices.length === 0 && statusRes.success) {
      const lines = statusRes.output.split('\n');
      for (const line of lines) {
        if (line.startsWith('#') && (line.includes('ISAKMP SA established') || line.includes('IPsec SA established') || line.includes('STATE_V2_ESTABLISHED'))) {
          const saMatch = line.match(/#\d+:\s+"([^"]+)"(?:\[\d+\])?\s+([0-9.]+)(?::\d+)?\s+STATE_([^\s;]+)/);
          if (saMatch) {
            const connName = saMatch[1];
            const remoteIp = saMatch[2];
            let proto = 'IPsec';
            if (connName.includes('ikev2')) proto = 'IKEv2';
            else if (connName.includes('l2tp')) proto = 'L2TP/IPsec';
            else if (connName.includes('xauth')) proto = 'IPsec/XAuth';

            if (!devices.some(d => d.remoteIp === remoteIp)) {
              devices.push({
                id: 'sa_' + randomUUID(),
                username: connName.includes('l2tp') ? 'L2TP Client' : (connName.includes('ikev2') ? 'IKEv2 Client' : 'Connected Peer'),
                remoteIp,
                virtualIp: 'Tunnel Active',
                protocol: proto,
                geo: null,
                inBytesFormatted: '0 B',
                outBytesFormatted: '0 B',
                duration: 'Active',
                connectedAt: new Date().toISOString()
              });
            }
          }
        }
      }
    }

    // 3. Check active PPP interfaces
    if (pppRes.success && pppRes.output) {
      const pppLines = pppRes.output.split('\n');
      for (const pLine of pppLines) {
        if (pLine.includes('ppp') && pLine.includes('peer')) {
          const m = pLine.match(/inet\s+([0-9.]+)\s+peer\s+([0-9.]+)/);
          if (m) {
            const peerIp = m[2];
            if (!devices.some(d => d.virtualIp === peerIp)) {
              devices.push({
                id: 'ppp_' + peerIp,
                username: 'L2TP User',
                remoteIp: 'Direct Tunnel',
                virtualIp: peerIp,
                protocol: 'L2TP/IPsec',
                geo: { country: 'Local Tunnel', countryCode: 'LAN', city: '', flag: '🔒' },
                inBytesFormatted: '0 B',
                outBytesFormatted: '0 B',
                duration: 'Active',
                connectedAt: new Date().toISOString()
              });
            }
          }
        }
      }
    }

    // 4. WireGuard is connectionless; treat a handshake in the last three minutes as active.
    if (wireguardRes.success && wireguardRes.output) {
      const protocolUsers = protocols.getAllProtocols();
      const userByPublicKey = new Map(Object.entries(protocolUsers).map(([name, user]) => [user.wgPub, name]));
      const nowSeconds = Math.floor(Date.now() / 1000);
      for (const line of wireguardRes.output.split('\n').slice(1)) {
        const [publicKey, , endpoint, allowedIps, handshakeText, receivedText, sentText] = line.split('\t');
        const handshake = Number.parseInt(handshakeText, 10) || 0;
        if (!publicKey || handshake === 0 || nowSeconds - handshake > 180) continue;
        const username = userByPublicKey.get(publicKey) || 'WireGuard peer';
        const virtualIp = (allowedIps || '').split(',')[0].replace(/\/\d+$/, '') || 'Tunnel active';
        const endpointValue = endpoint || '';
        const ipv6Endpoint = endpointValue.match(/^\[([^\]]+)\]:\d+$/);
        const endpointIp = (ipv6Endpoint ? ipv6Endpoint[1] : endpointValue.replace(/:\d+$/, '')) || 'Direct tunnel';
        updateClientIpMap(virtualIp, username);
        devices.push({
          id: `wg_${publicKey.slice(0, 12)}`,
          stateId: null,
          username,
          remoteIp: endpointIp,
          virtualIp,
          protocol: 'WireGuard',
          geo: null,
          inBytesFormatted: formatBytes(Number.parseInt(receivedText, 10) || 0),
          outBytesFormatted: formatBytes(Number.parseInt(sentText, 10) || 0),
          duration: `Handshake ${Math.max(0, nowSeconds - handshake)}s ago`,
          connectedAt: new Date(handshake * 1000).toISOString()
        });
      }
    }

  } catch (e) {
    console.error('Error discovering connected devices:', e);
  }
  await Promise.all(devices.map(async (device) => {
    if (!device.geo) device.geo = await lookupIp(device.remoteIp);
  }));
  return devices;
}

let devicesCache = { expiresAt: 0, value: [] };
let devicesRequest = null;

function invalidateDevicesCache() {
  devicesCache = { expiresAt: 0, value: [] };
  devicesRequest = null;
}

function findParentIkeStateId(statusOutput, childStateId) {
  const lines = String(statusOutput || '').split('\n');
  const targetLine = lines.find((line) => line.includes(`#${childStateId}:`));
  if (!targetLine) return null;

  const instanceMatch = targetLine.match(/"[^"]+"(?:\[\d+\])?/);
  if (!instanceMatch) return null;

  const parentLine = lines.find((line) =>
    line.includes(instanceMatch[0]) &&
    /(?:ESTABLISHED_IKE_SA|IKE SA established|ISAKMP SA established)/.test(line) &&
    !/CHILD_SA/.test(line)
  );
  const parentMatch = parentLine && parentLine.match(/#(\d+):/);
  return parentMatch ? parentMatch[1] : null;
}

async function disconnectIpsecState(stateId) {
  const statusResult = await runDockerExec(['ipsec', 'status']);
  const parentStateId = statusResult.success
    ? findParentIkeStateId(statusResult.output, stateId)
    : null;
  const result = await runDockerExec(['ipsec', 'whack', '--deletestate', parentStateId || stateId]);
  if (result.success) invalidateDevicesCache();
  return result;
}

async function getConnectedDevices() {
  if (devicesCache.expiresAt > Date.now()) return devicesCache.value;
  if (devicesRequest) return devicesRequest;
  devicesRequest = discoverConnectedDevices()
    .then((value) => {
      devicesCache = { value, expiresAt: Date.now() + 2_500 };
      return value;
    })
    .finally(() => { devicesRequest = null; });
  return devicesRequest;
}

// -----------------------------------------------------------------------------
// Disconnect Connection
// -----------------------------------------------------------------------------
app.post('/api/connections/kick', authMiddleware, async (req, res) => {
  const { stateId } = req.body;
  if (!stateId || !/^\d+$/.test(stateId)) {
    return res.status(400).json({ error: 'Invalid connection state ID' });
  }

  try {
    const result = await disconnectIpsecState(stateId);
    if (result.success) {
      res.json({ success: true });
    } else {
      res.status(500).json({ error: 'Failed to disconnect client. They may have already disconnected.' });
    }
  } catch (e) {
    sendServerError(res, e, 'The tunnel could not be disconnected.');
  }
});

// -----------------------------------------------------------------------------
// Authentication Endpoints
// -----------------------------------------------------------------------------
const loginLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 8,
  message: 'Too many sign-in attempts. Wait 15 minutes and try again.'
});

app.post('/api/auth/login', loginLimiter, (req, res) => {
  const { password } = req.body;
  if (typeof password === 'string' && passwordMatches(password)) {
    setSessionCookie(req, res);
    return res.json({ success: true });
  }
  res.status(401).json({ error: 'Invalid admin credentials' });
});

app.post('/api/auth/logout', (req, res) => {
  clearSessionCookie(req, res);
  res.json({ success: true });
});

app.get('/api/auth/check', (req, res) => {
  res.json({ authenticated: isAuthenticated(req) });
});

// -----------------------------------------------------------------------------
// Server Status, Bandwidth & Live Telemetry
// -----------------------------------------------------------------------------
app.get('/api/status', authMiddleware, async (req, res) => {
  try {
    const ipsecStatus = await runDockerExec(['ipsec', 'status']);
    const connectedDevices = await getConnectedDevices();
    const bandwidth = getBandwidthData();

    const system = getSystemMetrics();

    res.json({
      serverIp: SERVER_IP,
      pskConfigured: Boolean(VPN_PSK),
      vpnStatus: ipsecStatus.success ? 'online' : 'degraded',
      activeConnections: connectedDevices.length,
      devices: connectedDevices,
      bandwidth,
      uptimeSeconds: system.uptimeSeconds,
      loadAverage: system.loadAverage,
      memoryUsagePercent: system.memoryUsagePercent,
      metricScope: system.scope,
      ipsecDetails: ipsecStatus.output
    });
  } catch (err) {
    sendServerError(res, err, 'Server status is temporarily unavailable.');
  }
});

app.get('/api/secrets/ipsec-psk', authMiddleware, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ psk: VPN_PSK });
});

app.get('/api/bandwidth', authMiddleware, (req, res) => {
  res.json(getBandwidthData());
});

app.get('/api/devices', authMiddleware, async (req, res) => {
  try {
    const devices = await getConnectedDevices();
    res.json({ devices });
  } catch (err) {
    sendServerError(res, err, 'Connected clients are temporarily unavailable.');
  }
});

// -----------------------------------------------------------------------------
// Per-Client AdBlock Management
// -----------------------------------------------------------------------------
app.post('/api/adblock/toggle', authMiddleware, async (req, res) => {
  const { username, enabled } = req.body;
  if (typeof username !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(username) || typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'Client name or ad-block setting is invalid.' });
  }

  try {
    const result = await db.setClientAdblock(username, enabled);
    res.json({ success: true, ...result });
  } catch (err) {
    sendServerError(res, err, 'The ad-block setting could not be saved.');
  }
});

// -----------------------------------------------------------------------------
// User Management
// -----------------------------------------------------------------------------
app.get('/api/users', authMiddleware, async (req, res) => {
  try {
    const [listRes, pppRes, connectedDevices] = await Promise.all([
      runDockerExec(['ikev2.sh', '--listclients']),
      runDockerExec(['sh', '-c', 'cat /etc/ppp/chap-secrets 2>/dev/null || true']),
      getConnectedDevices()
    ]);

    const clientMap = new Map();

    // Parse IKEv2 clients table
    if (listRes.success) {
      const lines = listRes.output.split('\n');
      let inTable = false;
      for (const line of lines) {
        if (line.includes('Client Name') && line.includes('Certificate Status')) {
          inTable = true;
          continue;
        }
        if (inTable && line.startsWith('---')) continue;
        if (inTable && line.startsWith('Total:')) break;
        if (inTable && line.trim()) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 2) {
            const name = parts[0];
            const status = parts[1];
            const isOnline = connectedDevices.some(d => d.username.toLowerCase() === name.toLowerCase());
            const adblockEnabled = db.isClientAdblockEnabled(name);
            clientMap.set(name, {
              name,
              status,
              isOnline,
              adblockEnabled,
              hasIkev2: true,
              hasL2tp: false,
              createdAt: new Date().toISOString()
            });
          }
        }
      }
    }

    // Parse L2TP / PPP users
    if (pppRes.success) {
      const pppLines = pppRes.output.split('\n');
      for (const line of pppLines) {
        if (line.startsWith('#') || !line.trim()) continue;
        const match = line.match(/^"([^"]+)"\s+\*\s+"([^"]+)"/);
        if (match) {
          const name = match[1];
          const isOnline = connectedDevices.some(d => d.username.toLowerCase() === name.toLowerCase());
          const adblockEnabled = db.isClientAdblockEnabled(name);
          if (clientMap.has(name)) {
            const u = clientMap.get(name);
            u.hasL2tp = true;
            if (isOnline) u.isOnline = true;
          } else {
            clientMap.set(name, {
              name,
              status: 'valid',
              isOnline,
              adblockEnabled,
              hasIkev2: false,
              hasL2tp: true,
              createdAt: new Date().toISOString()
            });
          }
        }
      }
    }

    const allProtos = protocols.getAllProtocols();
    const serverWgPub = protocols.getServerWgPub();
    
    // Merge extra protocols
    for (const [name, u] of clientMap.entries()) {
      if (allProtos[name]) {
        u.hasWg = true;
        u.hasSs = true;
        u.wgPriv = allProtos[name].wgPriv;
        u.wgIp = allProtos[name].wgIp;
        u.wgPsk = allProtos[name].wgPsk;
        u.xrayPass = allProtos[name].xrayPass;
        u.serverWgPub = serverWgPub;
      }
    }

    // Add users that ONLY have WG/SS (e.g. failed IPsec generation but exists in DB)
    for (const [name, p] of Object.entries(allProtos)) {
      if (!clientMap.has(name)) {
        clientMap.set(name, {
          name,
          status: 'valid',
          isOnline: false,
          adblockEnabled: db.isClientAdblockEnabled(name),
          hasIkev2: false,
          hasL2tp: false,
          hasWg: true,
          hasSs: true,
          wgPriv: p.wgPriv,
          wgIp: p.wgIp,
          wgPsk: p.wgPsk,
          xrayPass: p.xrayPass,
          serverWgPub,
          createdAt: new Date().toISOString()
        });
      }
    }

    res.json({ users: Array.from(clientMap.values()), serverIp: process.env.VPN_PUBLIC_IP || '127.0.0.1' });
  } catch (err) {
    sendServerError(res, err, 'The client list is temporarily unavailable.');
  }
});

function buildClientConnectionConfigs(username) {
  const user = protocols.getAllProtocols()[username];
  if (!user) return null;

  const serverWgPub = protocols.getServerWgPub();
  const wgConfig = user.wgPriv && user.wgIp && serverWgPub
    ? `[Interface]\nPrivateKey = ${user.wgPriv}\nAddress = 10.8.0.${user.wgIp}/32\nDNS = 172.20.0.3\n\n[Peer]\nPublicKey = ${serverWgPub}\nPresharedKey = ${user.wgPsk}\nEndpoint = ${SERVER_IP}:51820\nAllowedIPs = 0.0.0.0/0\nPersistentKeepalive = 25`
    : '';
  const ssToken = user.xrayPass ? Buffer.from(`aes-128-gcm:${user.xrayPass}`).toString('base64url') : '';
  const ssUri = ssToken ? `ss://${ssToken}@${SERVER_IP}:8388#OmniVPN-${encodeURIComponent(username)}` : '';
  return { wgConfig, ssUri, androidCertificatePassword: ANDROID_CERTIFICATE_PASSWORD };
}

app.get('/api/users/:username/configs', authMiddleware, (req, res) => {
  const { username } = req.params;
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(username)) {
    return res.status(400).json({ error: 'Invalid client name.' });
  }
  const configs = buildClientConnectionConfigs(username);
  if (!configs) return res.status(404).json({ error: 'Client protocol configuration was not found.' });
  res.setHeader('Cache-Control', 'no-store');
  return res.json(configs);
});

app.post('/api/users', authMiddleware, async (req, res) => {
  const { username, password } = req.body;
  if (typeof username !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(username)) {
    return res.status(400).json({ error: 'Client name must contain 1–64 letters, numbers, dashes, or underscores.' });
  }
  if (password && (typeof password !== 'string' || password.length > 128 || /[\r\n\0]/.test(password))) {
    return res.status(400).json({ error: 'Password cannot exceed 128 characters or contain line breaks.' });
  }

  const vpnPass = password || require('crypto').randomBytes(18).toString('base64url');
  const writePppScript = [
    'set -eu',
    'tmp="$(mktemp)"',
    'awk -v user="$1" \'$1 != "\\\"" user "\\\"" { print }\' /etc/ppp/chap-secrets 2>/dev/null > "$tmp" || true',
    'printf \'"%s" * "%s" *\\n\' "$1" "$2" >> "$tmp"',
    'cat "$tmp" > /etc/ppp/chap-secrets',
    'chmod 600 /etc/ppp/chap-secrets',
    'rm -f "$tmp"'
  ].join('\n');

  try {
    const ikeRes = await runDockerExec(['ikev2.sh', '--addclient', username], { timeout: 60_000 });
    if (!ikeRes.success) throw new Error(`IKEv2 certificate generation failed: ${ikeRes.error}`);

    const pppRes = await runDockerExec(['sh', '-c', writePppScript, 'omnivpn-ppp', username, vpnPass]);
    if (!pppRes.success) {
      await runDockerExec(['sh', '-c', 'printf "y\\n" | ikev2.sh --revokeclient "$1" || true', 'omnivpn-revoke', username]);
      throw new Error(`L2TP credential creation failed: ${pppRes.error}`);
    }

    // 3. Add WireGuard and Shadowsocks
    let extraProtos = null;
    try {
      extraProtos = protocols.addUserProtocols(username);
    } catch (e) {
      await runDockerExec(['sh', '-c', 'tmp="$(mktemp)"; awk -v user="$1" \'$1 != "\\\"" user "\\\"" { print }\' /etc/ppp/chap-secrets > "$tmp"; cat "$tmp" > /etc/ppp/chap-secrets; rm -f "$tmp"', 'omnivpn-rollback', username]);
      await runDockerExec(['sh', '-c', 'printf "y\\n" | ikev2.sh --revokeclient "$1" || true', 'omnivpn-revoke', username]);
      throw e;
    }

    res.json({
      success: true,
      user: {
        name: username,
        password: vpnPass,
        protectedConfig: /Password for client config files:/i.test(ikeRes.output),
        extra: Boolean(extraProtos)
      }
    });
  } catch (err) {
    console.error('[Users] Create failed:', err.message);
    res.status(500).json({ error: 'Client creation did not complete. No partial client was retained.' });
  }
});

app.delete('/api/users/:username', authMiddleware, async (req, res) => {
  const username = req.params.username;
  if (!username || !/^[a-zA-Z0-9_-]{1,64}$/.test(username)) {
    return res.status(400).json({ error: 'Invalid username.' });
  }

  try {
    // 0. Force disconnect any active sessions for this user
    try {
      const devices = await getConnectedDevices();
      for (const dev of devices) {
        if (dev.username === username && dev.stateId) {
          await disconnectIpsecState(dev.stateId);
        }
      }
    } catch(e) {}

    // 1. Revoke the certificate so it cannot connect, then remove its database record and files.
    await runDockerExec(['ikev2.sh', '--revokeclient', username, '--yes'], { timeout: 60_000 });
    const deleteIkev2 = await runDockerExec(['ikev2.sh', '--deleteclient', username, '--yes'], { timeout: 60_000 });
    if (!deleteIkev2.success && !/does not exist|invalid client name/i.test(deleteIkev2.error)) {
      throw new Error(deleteIkev2.error);
    }
    await runDockerExec([
      'sh', '-c',
      'rm -f "/etc/ipsec.d/$1.p12" "/etc/ipsec.d/$1.mobileconfig" "/etc/ipsec.d/$1.sswan" "/etc/ipsec.d/$1.enc.p12"',
      'omnivpn-clean-configs', username
    ]);

    // 2. Remove L2TP credentials
    const removePpp = await runDockerExec([
      'sh', '-c',
      'tmp="$(mktemp)"; awk -v user="$1" \'$1 != "\\\"" user "\\\"" { print }\' /etc/ppp/chap-secrets 2>/dev/null > "$tmp" || true; cat "$tmp" > /etc/ppp/chap-secrets; chmod 600 /etc/ppp/chap-secrets; rm -f "$tmp"',
      'omnivpn-delete', username
    ]);
    if (!removePpp.success) throw new Error(removePpp.error);

    // 3. Remove WG/SS credentials
    try {
      protocols.removeUserProtocols(username);
    } catch(e) {
      console.error("Failed to remove WG/SS protocols", e);
    }

    await db.removeClientAdblock(username);
    res.json({ success: true, username });
  } catch (err) {
    sendServerError(res, err, 'The client could not be removed completely.');
  }
});

// -----------------------------------------------------------------------------
// Download Packages (Single File & Complete Windows 1-Click ZIP)
// -----------------------------------------------------------------------------
app.get('/api/users/:username/download/:type', authMiddleware, async (req, res) => {
  const { username, type } = req.params;
  if (!username || !/^[a-zA-Z0-9_-]{1,64}$/.test(username)) {
    return res.status(400).json({ error: 'Invalid username.' });
  }
  if (!['p12', 'mobileconfig', 'sswan', 'wireguard', 'windows-zip'].includes(type)) {
    return res.status(400).json({ error: 'Invalid download type.' });
  }

  if (type === 'wireguard') {
    const configs = buildClientConnectionConfigs(username);
    if (!configs || !configs.wgConfig) {
      return res.status(404).json({ error: 'WireGuard configuration was not found.' });
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${username}.conf"`);
    return res.send(`${configs.wgConfig}\n`);
  }

  const tmpExport = fs.mkdtempSync('/tmp/omnivpn-export-');
  try {
    const requiredExtensions = type === 'windows-zip' ? ['p12'] : [type];
    await Promise.all(requiredExtensions.map((extension) =>
      runFile('docker', ['cp', '-L', `${VPN_CONTAINER}:/etc/ipsec.d/${username}.${extension}`, tmpExport], { timeout: 30_000 })
    ));

    if (type === 'p12') {
      const filePath = `${tmpExport}/${username}.p12`;
      if (!fs.existsSync(filePath)) throw new Error('File not found');
      return res.download(filePath, `${username}.p12`, () => fs.rmSync(tmpExport, { recursive: true, force: true }));
    }

    if (type === 'mobileconfig') {
      const filePath = `${tmpExport}/${username}.mobileconfig`;
      if (!fs.existsSync(filePath)) throw new Error('File not found');
      return res.download(filePath, `${username}.mobileconfig`, () => fs.rmSync(tmpExport, { recursive: true, force: true }));
    }

    if (type === 'sswan') {
      const filePath = `${tmpExport}/${username}.sswan`;
      if (!fs.existsSync(filePath)) throw new Error('File not found');
      const androidP12 = await runDockerExec([
        'sh', '-c',
        'set -e; . /etc/ipsec.d/.vpnconfig; dir="$(mktemp -d /tmp/omnivpn-android-XXXXXX)"; trap \'rm -rf "$dir"\' EXIT; umask 077; openssl pkcs12 -legacy -in "/etc/ipsec.d/$1.p12" -passin "pass:$IKEV2_CONFIG_PASSWORD" -nodes -out "$dir/bundle.pem" >/dev/null 2>&1; openssl pkcs12 -legacy -export -in "$dir/bundle.pem" -out "$dir/android.p12" -passout "pass:$2" -name "$1" >/dev/null 2>&1; base64 "$dir/android.p12" | tr -d "\\n"',
        'omnivpn-android-export', username, ANDROID_CERTIFICATE_PASSWORD
      ], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
      if (!androidP12.success || !androidP12.output) {
        throw new Error(androidP12.error || 'Android certificate export failed');
      }

      const profile = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      profile.name = username;
      profile.local = profile.local || {};
      profile.local.p12 = androidP12.output;
      fs.writeFileSync(filePath, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
      res.setHeader('Content-Type', 'application/vnd.strongswan.profile');
      return res.download(filePath, `${username}.sswan`, () => fs.rmSync(tmpExport, { recursive: true, force: true }));
    }

    if (type === 'windows-zip') {
      const p12Path = `${tmpExport}/${username}.p12`;
      if (!fs.existsSync(p12Path)) throw new Error('Client certificate not found');

      const passwordResult = await runDockerExec(['sh', '-c', '. /etc/ipsec.d/.vpnconfig 2>/dev/null || true; printf %s "$IKEV2_CONFIG_PASSWORD"']);
      const p12Password = passwordResult.success ? passwordResult.output : '';
      if (!p12Password) throw new Error('IKEv2 client configuration password is unavailable');

      const psPassword = p12Password.replace(/'/g, "''");
      const profileName = username;

      // Generate a small elevation wrapper and a validated PowerShell installer.
      const batContent = `@echo off
:: OmniVPN Windows installer for ${username}
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Requesting administrator privileges...
    powershell.exe -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install_windows_ikev2.ps1"
exit /b %errorlevel%
`;
      fs.writeFileSync(`${tmpExport}/install_windows_ikev2.bat`, batContent);

      const psContent = `$ErrorActionPreference = 'Stop'
$profileName = '${profileName}'
$serverAddress = '${SERVER_IP}'
$p12Path = Join-Path $PSScriptRoot '${username}.p12'
$p12Password = '${psPassword}'
$caName = 'IKEv2 VPN CA'

function Write-Step([string] $Message) {
  Write-Host "\`n==> $Message" -ForegroundColor Cyan
}

try {
  if (-not (Test-Path -LiteralPath $p12Path)) {
    throw "Certificate file not found: $p12Path"
  }

  Write-Step 'Removing older OmniVPN profiles and certificates'
  Get-VpnConnection -ErrorAction SilentlyContinue |
    Where-Object { $_.ServerAddress -eq $serverAddress -or $_.Name -in @('My IKEv2 VPN', $profileName) } |
    ForEach-Object { Remove-VpnConnection -Name $_.Name -Force -ErrorAction SilentlyContinue }

  $machineStore = New-Object System.Security.Cryptography.X509Certificates.X509Store('My', 'LocalMachine')
  $machineStore.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
  try {
    @($machineStore.Certificates) |
      Where-Object { $_.Issuer -like "*CN=$caName*" } |
      ForEach-Object { $machineStore.Remove($_) }
  } finally {
    $machineStore.Close()
  }

  $rootStore = New-Object System.Security.Cryptography.X509Certificates.X509Store('Root', 'LocalMachine')
  $rootStore.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
  try {
    @($rootStore.Certificates) |
      Where-Object { $_.Subject -like "*CN=$caName*" } |
      ForEach-Object { $rootStore.Remove($_) }
  } finally {
    $rootStore.Close()
  }

  $remainingClients = @(Get-ChildItem Cert:\\LocalMachine\\My |
    Where-Object { $_.Issuer -like "*CN=$caName*" })
  $remainingRoots = @(Get-ChildItem Cert:\\LocalMachine\\Root |
    Where-Object { $_.Subject -like "*CN=$caName*" })
  if ($remainingClients.Count -ne 0 -or $remainingRoots.Count -ne 0) {
    throw 'Windows could not remove the previous OmniVPN certificates.'
  }

  Write-Step 'Importing and validating the client certificate'
  & certutil.exe -f -p $p12Password -importpfx $p12Path NoExport | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'Windows could not import the P12 certificate.' }

  $clientCertificates = @(Get-ChildItem Cert:\\LocalMachine\\My |
    Where-Object { $_.GetNameInfo('SimpleName', $false) -eq $profileName -and $_.Issuer -like "*CN=$caName*" -and $_.HasPrivateKey })
  if ($clientCertificates.Count -ne 1) { throw 'Windows did not import exactly one matching client certificate with a private key.' }

  $trustedCa = Get-ChildItem Cert:\\LocalMachine\\Root |
    Where-Object { $_.Subject -like "*CN=$caName*" } |
    Select-Object -First 1
  if (-not $trustedCa) {
    $certificates = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2Collection
    $certificates.Import($p12Path, $p12Password, [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::DefaultKeySet)
    $rootCertificate = $certificates | Where-Object { $_.Subject -eq $_.Issuer } | Select-Object -First 1
    if (-not $rootCertificate) { throw 'The trusted CA certificate was not found in the P12 archive.' }
    $rootStore = New-Object System.Security.Cryptography.X509Certificates.X509Store('Root', 'LocalMachine')
    $rootStore.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
    try { $rootStore.Add($rootCertificate) } finally { $rootStore.Close() }
  }

  $trustedRoots = @(Get-ChildItem Cert:\\LocalMachine\\Root |
    Where-Object { $_.Subject -like "*CN=$caName*" })
  if ($trustedRoots.Count -ne 1) { throw 'Windows did not install exactly one trusted OmniVPN root certificate.' }

  Write-Step "Creating VPN profile '$profileName'"
  New-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\RasMan\\Parameters' -Name 'NegotiateDH2048_AES256' -PropertyType DWord -Value 1 -Force | Out-Null
  New-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\PolicyAgent' -Name 'AssumeUDPEncapsulationContextOnSendRule' -PropertyType DWord -Value 2 -Force | Out-Null
  Add-VpnConnection -ServerAddress $serverAddress -Name $profileName -TunnelType IKEv2 -AuthenticationMethod MachineCertificate -EncryptionLevel Required -PassThru | Out-Host
  Set-VpnConnectionIPsecConfiguration -ConnectionName $profileName -AuthenticationTransformConstants GCMAES128 -CipherTransformConstants GCMAES128 -EncryptionMethod AES256 -IntegrityCheckMethod SHA256 -PfsGroup None -DHGroup Group14 -PassThru -Force | Out-Host

  Write-Host "\`nVPN profile '$profileName' installed successfully." -ForegroundColor Green
  Write-Host 'Restart Windows before connecting so the IPsec changes take effect.' -ForegroundColor Yellow
  Read-Host 'Press Enter to close'
  exit 0
} catch {
  Write-Host "\`nINSTALLATION FAILED: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host 'No working VPN profile was created. Correct the error and run the installer again.' -ForegroundColor Yellow
  Read-Host 'Press Enter to close'
  exit 1
}
`;
      fs.writeFileSync(`${tmpExport}/install_windows_ikev2.ps1`, psContent);

      const readmeContent = `=== IKEv2 VPN Setup Instructions for ${username} ===

Server Address: ${SERVER_IP}
Client Name:    ${username}
VPN Profile:    ${profileName}

WINDOWS 10 / 11 SETUP (Easiest):
1. Extract all files in this ZIP archive to a folder on your Windows PC.
2. Right-click on "install_windows_ikev2.bat" and choose "Run as administrator".
3. Confirm that the installer says the VPN profile was installed successfully.
4. Restart Windows.
5. Open VPN settings, select "${profileName}", and click Connect.

The installer replaces older OmniVPN certificates and profiles for this server so
Windows selects the correct client certificate. If installation fails, keep the
error window open and use its exact message for troubleshooting.
`;
      fs.writeFileSync(`${tmpExport}/README.txt`, readmeContent);

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${username}_windows_ikev2.zip"`);

      const archive = new ZipArchive({ zlib: { level: 9 } });
      archive.on('end', () => fs.rmSync(tmpExport, { recursive: true, force: true }));
      archive.on('error', (err) => {
        fs.rmSync(tmpExport, { recursive: true, force: true });
        sendServerError(res, err, 'The client package could not be created.');
      });

      archive.pipe(res);
      archive.file(`${tmpExport}/install_windows_ikev2.bat`, { name: 'install_windows_ikev2.bat' });
      archive.file(`${tmpExport}/install_windows_ikev2.ps1`, { name: 'install_windows_ikev2.ps1' });
      archive.file(`${tmpExport}/${username}.p12`, { name: `${username}.p12` });
      archive.file(`${tmpExport}/README.txt`, { name: 'README.txt' });
      archive.finalize();
      return;
    }

    fs.rmSync(tmpExport, { recursive: true, force: true });
    return res.status(400).json({ error: 'Invalid download type.' });
  } catch (err) {
    if (fs.existsSync(tmpExport)) fs.rmSync(tmpExport, { recursive: true, force: true });
    sendServerError(res, err, 'The requested client package is unavailable.');
  }
});

// -----------------------------------------------------------------------------
// Backup Export & Import (Server Migration)
// -----------------------------------------------------------------------------
const upload = multer({
  dest: '/tmp/vpn-uploads/',
  limits: { files: 1, fields: 0, fileSize: 100 * 1024 * 1024, fieldNestingDepth: 1 }
});

app.get('/api/backup/export', authMiddleware, async (req, res) => {
  const tmpDir = fs.mkdtempSync('/tmp/omnivpn-backup-');
  const encryptedPath = `${tmpDir}.ovpnbackup`;
  try {
    for (const directory of ['ipsec.d', 'ppp', 'data', 'wireguard', 'xray']) {
      fs.mkdirSync(path.join(tmpDir, directory), { recursive: true, mode: 0o700 });
    }

    // 1. Copy IPsec certificates & keys from VPN container
    await runFile('docker', ['cp', '-L', `${VPN_CONTAINER}:/etc/ipsec.d/.`, path.join(tmpDir, 'ipsec.d')], { timeout: 60_000 });

    // 2. Copy L2TP/PPP credentials
    await runFile('docker', ['cp', '-L', `${VPN_CONTAINER}:/etc/ppp/.`, path.join(tmpDir, 'ppp')], { timeout: 60_000 });

    // 3. Copy WG and Xray
    copyDirectoryContents('/etc/wireguard', path.join(tmpDir, 'wireguard'));
    copyDirectoryContents('/etc/xray', path.join(tmpDir, 'xray'));

    // 4. Copy SQLite activity DB & JSON settings
    const dbSource = path.join(__dirname, 'data', 'vpn_activity.db');
    if (fs.existsSync(dbSource)) {
      fs.copyFileSync(dbSource, path.join(tmpDir, 'data', 'vpn_activity.db'));
    }
    const jsonDb = path.join(__dirname, 'data', 'users.json');
    if (fs.existsSync(jsonDb)) {
      fs.copyFileSync(jsonDb, path.join(tmpDir, 'data', 'users.json'));
    }

    // 4. Copy vpn.env from the running environment (reconstruct from env vars)
    const envContent = [
      `# VPN Configuration Backup - ${new Date().toISOString()}`,
      `VPN_IPSEC_PSK="${process.env.VPN_IPSEC_PSK || ''}"`,
      `VPN_USER="${process.env.VPN_USER || 'admin'}"`,
      `VPN_PASSWORD="${process.env.VPN_PASSWORD || ''}"`,
      `VPN_PUBLIC_IP="${process.env.VPN_PUBLIC_IP || SERVER_IP}"`,
      `VPN_DNS_SRV1="${process.env.VPN_DNS_SRV1 || '172.20.0.3'}"`,
      `VPN_DNS_SRV2="${process.env.VPN_DNS_SRV2 || '1.1.1.1'}"`,
      `WEBUI_PORT="${process.env.WEBUI_PORT || '8080'}"`,
      `WEBUI_PASSWORD="${process.env.WEBUI_PASSWORD || ''}"`,
      ''
    ].join('\n');
    fs.writeFileSync(`${tmpDir}/vpn.env`, envContent);

    // 5. Write a manifest for verification on import
    const manifest = {
      version: 2,
      exportedAt: new Date().toISOString(),
      serverIp: SERVER_IP,
      contents: ['ipsec.d/', 'ppp/', 'wireguard/', 'xray/', 'data/', 'vpn.env']
    };
    fs.writeFileSync(`${tmpDir}/manifest.json`, JSON.stringify(manifest, null, 2));

    await createEncryptedArchive(tmpDir, encryptedPath);
    const dateStr = new Date().toISOString().slice(0, 10);
    const filename = `omnivpn_backup_${dateStr}.ovpnbackup`;
    return res.download(encryptedPath, filename, () => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(encryptedPath, { force: true });
    });
  } catch (err) {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(encryptedPath, { force: true });
    console.error('[Backup] Export failed:', err.message);
    sendServerError(res, err, 'The encrypted backup could not be created.');
  }
});

app.post('/api/backup/import', authMiddleware, upload.single('backup'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No backup file uploaded.' });
  }

  const uploadedPath = req.file.path;
  const extractDir = fs.mkdtempSync('/tmp/omnivpn-restore-');
  const tarPath = `${extractDir}.tar.gz`;

  try {
    await decryptArchive(uploadedPath, tarPath);
    await validateAndExtract(tarPath, extractDir);

    // Validate manifest
    const manifestPath = path.join(extractDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      throw new Error('Invalid backup: missing manifest.json. This does not appear to be a valid VPN backup archive.');
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.version !== 2 || typeof manifest.exportedAt !== 'string') {
      throw new Error('Invalid backup: corrupt manifest.');
    }

    const ipsecDir = path.join(extractDir, 'ipsec.d');
    const pppDir = path.join(extractDir, 'ppp');
    const wgDir = path.join(extractDir, 'wireguard');
    const xrayDir = path.join(extractDir, 'xray');
    const dataDir = path.join(extractDir, 'data');

    let restored = [];

    // 1. Restore IPsec certificates & keys
    if (fs.existsSync(ipsecDir)) {
      const result = await runFile('docker', ['cp', `${ipsecDir}/.`, `${VPN_CONTAINER}:/etc/ipsec.d/`], { timeout: 60_000 });
      if (!result.success) throw new Error(`IPsec restore failed: ${result.error}`);
      restored.push('IPsec certificates & keys');
    }

    // 2. Restore L2TP/PPP credentials
    if (fs.existsSync(pppDir)) {
      const result = await runFile('docker', ['cp', `${pppDir}/.`, `${VPN_CONTAINER}:/etc/ppp/`], { timeout: 60_000 });
      if (!result.success) throw new Error(`PPP restore failed: ${result.error}`);
      restored.push('L2TP credentials');
    }
    
    // 2.5 Restore WireGuard & Xray
    if (fs.existsSync(wgDir)) {
      copyDirectoryContents(wgDir, '/etc/wireguard');
      restored.push('WireGuard configuration');
    }
    if (fs.existsSync(xrayDir)) {
      copyDirectoryContents(xrayDir, '/etc/xray');
      restored.push('Shadowsocks configuration');
    }

    // 3. Restore SQLite activity DB & users.json
    if (fs.existsSync(dataDir)) {
      const targetDir = path.join(__dirname, 'data');
      if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
      copyDirectoryContents(dataDir, targetDir);
      restored.push('Activity logs & Users JSON');
    }

    // 4. Log the vpn.env info (user should update their host vpn.env manually)
    const envBackup = path.join(extractDir, 'vpn.env');
    let envNote = '';
    if (fs.existsSync(envBackup)) {
      restored.push('vpn.env configuration (included in archive)');
      envNote = 'Your vpn.env configuration is included in the backup. Update your host vpn.env with these values if migrating to a new server.';
    }

    const restartResults = await Promise.all([
      restartContainer(VPN_CONTAINER),
      restartContainer('wireguard'),
      restartContainer('xray')
    ]);
    if (restartResults.some((result) => !result.success)) {
      throw new Error('Configuration restored, but one or more VPN services did not restart cleanly.');
    }

    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.rmSync(tarPath, { force: true });
    if (fs.existsSync(uploadedPath)) fs.rmSync(uploadedPath, { force: true });

    res.json({ success: true, restored });
  } catch (err) {
    if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true });
    fs.rmSync(tarPath, { force: true });
    if (fs.existsSync(uploadedPath)) fs.rmSync(uploadedPath, { force: true });
    sendServerError(res, err, 'The backup could not be authenticated or restored.');
  }
});

// Start DNS proxy service
try {
  startDnsProxy();
} catch (e) {
  console.error('[DNS Logger] Failed to start DNS proxy:', e.message);
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[VPN Control Panel] WebUI running at http://0.0.0.0:${PORT}`);
});
