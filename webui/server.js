const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const { exec, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const os = require('os');
const db = require('./db');
const adblock = require('./adblock');
const protocols = require("./protocols");

const { startDnsProxy, updateClientIpMap } = require('./dns-proxy');
const { lookupIp } = require('./geoip');
const { getBandwidthData } = require('./bandwidth');

const app = express();
const PORT = process.env.WEBUI_PORT || 8080;
const ADMIN_PASSWORD = process.env.WEBUI_PASSWORD || 'OmniVPNAdmin2026!';
const VPN_CONTAINER = process.env.VPN_CONTAINER || 'ipsec-vpn-server';
const SERVER_IP = process.env.VPN_PUBLIC_IP || '37.27.11.96';
const VPN_PSK = process.env.VPN_IPSEC_PSK || 'OmniVPNSecurePSK2026!Key';

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize DB, AdBlock, and WG/SS Protocols
try {
  protocols.initProtocols();
} catch (e) {
  console.error("Failed to init extra protocols:", e);
}

// Simple secure session token
const SESSION_SECRET = 'ms_vps_' + Math.random().toString(36).substring(2);

function authMiddleware(req, res, next) {
  const token = req.cookies.vps_auth;
  if (token === SESSION_SECRET) {
    return next();
  }
  res.status(401).json({ error: 'Unauthorized' });
}

// Execute command inside VPN container
function runDockerExec(cmd) {
  return new Promise((resolve, reject) => {
    exec(`docker exec ${VPN_CONTAINER} ${cmd}`, (err, stdout, stderr) => {
      if (err) {
        return resolve({ success: false, output: stderr || err.message, raw: '' });
      }
      resolve({ success: true, output: stdout.trim(), raw: stdout });
    });
  });
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// -----------------------------------------------------------------------------
// Live Connected Devices Discovery & GeoIP Telemetry
// -----------------------------------------------------------------------------
async function getConnectedDevices() {
  const devices = [];
  try {
    const trafficRes = await runDockerExec('ipsec whack --trafficstatus');
    const statusRes = await runDockerExec('ipsec status');
    const pppRes = await runDockerExec("bash -c 'ip -o -4 addr show 2>/dev/null || true'");

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
          const username = idMatch ? idMatch[1] : (connNameMatch ? connNameMatch[1] : 'Unknown');
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

          const geo = await lookupIp(remoteIp);

          devices.push({
            id: 'sa_' + (addTime || Math.random().toString(36).substring(7)),
            stateId,
            username,
            remoteIp,
            virtualIp,
            protocol: proto,
            geo,
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
              const geo = await lookupIp(remoteIp);
              devices.push({
                id: 'sa_' + Math.random().toString(36).substring(7),
                username: connName.includes('l2tp') ? 'L2TP Client' : (connName.includes('ikev2') ? 'IKEv2 Client' : 'Connected Peer'),
                remoteIp,
                virtualIp: 'Tunnel Active',
                protocol: proto,
                geo,
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

  } catch (e) {
    console.error('Error discovering connected devices:', e);
  }
  return devices;
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
    const result = await runDockerExec(`ipsec whack --deletestate ${stateId}`);
    if (result.success) {
      res.json({ success: true });
    } else {
      res.status(500).json({ error: 'Failed to disconnect client. They may have already disconnected.' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// -----------------------------------------------------------------------------
// Authentication Endpoints
// -----------------------------------------------------------------------------
app.post('/api/auth/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    res.cookie('vps_auth', SESSION_SECRET, {
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      sameSite: 'strict'
    });
    return res.json({ success: true });
  }
  res.status(401).json({ error: 'Invalid admin credentials' });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('vps_auth');
  res.json({ success: true });
});

app.get('/api/auth/check', (req, res) => {
  const token = req.cookies.vps_auth;
  res.json({ authenticated: token === SESSION_SECRET });
});

// -----------------------------------------------------------------------------
// Server Status, Bandwidth & Live Telemetry
// -----------------------------------------------------------------------------
app.get('/api/status', authMiddleware, async (req, res) => {
  try {
    const ipsecStatus = await runDockerExec('ipsec status');
    const connectedDevices = await getConnectedDevices();
    const bandwidth = getBandwidthData();

    // System uptime & load
    const uptimeSeconds = os.uptime();
    const loadAvg = os.loadavg();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMemPercent = Math.round(((totalMem - freeMem) / totalMem) * 100);

    res.json({
      serverIp: SERVER_IP,
      psk: VPN_PSK,
      vpnStatus: ipsecStatus.success ? 'online' : 'degraded',
      activeConnections: connectedDevices.length,
      devices: connectedDevices,
      bandwidth,
      uptimeSeconds,
      loadAverage: loadAvg[0].toFixed(2),
      memoryUsagePercent: usedMemPercent,
      ipsecDetails: ipsecStatus.output
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/bandwidth', authMiddleware, (req, res) => {
  res.json(getBandwidthData());
});

app.get('/api/devices', authMiddleware, async (req, res) => {
  try {
    const devices = await getConnectedDevices();
    res.json({ devices });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -----------------------------------------------------------------------------
// Browsing Activity & DNS Logs Endpoints
// -----------------------------------------------------------------------------
app.get('/api/logs', authMiddleware, async (req, res) => {
  try {
    const { limit = 50, offset = 0, search = '', client = '', domain = '', status = '' } = req.query;
    const data = await db.getLogs({ limit, offset, search, client, domain, status });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/logs/stats', authMiddleware, async (req, res) => {
  try {
    const stats = await db.getStats();
    stats.adblockRules = adblock.getBlocklistSize();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/logs/export/csv', authMiddleware, async (req, res) => {
  try {
    const { client, status } = req.query;
    const rows = await db.getAllLogsForExport({ client, status });
    
    let csv = 'Timestamp,Client Name,Client IP,Domain Visited,Query Type,Status\r\n';
    for (const row of rows) {
      const ts = `"${row.created_at}"`;
      const name = `"${(row.client_name || 'VPN Client').replace(/"/g, '""')}"`;
      const ip = `"${row.client_ip}"`;
      const domain = `"${(row.domain || '').replace(/"/g, '""')}"`;
      const qtype = `"${row.qtype || 'A'}"`;
      const st = `"${row.status || 'RESOLVED'}"`;
      csv += `${ts},${name},${ip},${domain},${qtype},${st}\r\n`;
    }

    const filename = `vpn_browsing_history_${new Date().toISOString().slice(0,10)}.csv`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/logs/clear', authMiddleware, async (req, res) => {
  try {
    const count = await db.clearLogs();
    res.json({ success: true, count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -----------------------------------------------------------------------------
// Per-Client AdBlock Management
// -----------------------------------------------------------------------------
app.post('/api/adblock/toggle', authMiddleware, async (req, res) => {
  const { username, enabled } = req.body;
  if (!username) {
    return res.status(400).json({ error: 'Username is required' });
  }

  try {
    const result = await db.setClientAdblock(username, enabled);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -----------------------------------------------------------------------------
// User Management
// -----------------------------------------------------------------------------
app.get('/api/users', authMiddleware, async (req, res) => {
  try {
    const listRes = await runDockerExec('ikev2.sh --listclients');
    const pppRes = await runDockerExec("bash -c 'cat /etc/ppp/chap-secrets 2>/dev/null || true'");
    const connectedDevices = await getConnectedDevices();

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
        u.xrayPass = allProtos[name].xrayPass;
        u.serverWgPub = serverWgPub;
        u.wgPsk = allProtos[name].wgPsk;
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
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/users', authMiddleware, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !/^[a-zA-Z0-9_-]+$/.test(username)) {
    return res.status(400).json({ error: 'Invalid username. Use alphanumeric characters, dashes, or underscores.' });
  }

  const vpnPass = password || Math.random().toString(36).slice(-10) + 'A1!';

  try {
    // 1. Generate IKEv2 client certificate
    const ikeRes = await runDockerExec(`ikev2.sh --addclient "${username}"`);
    
    // 2. Add L2TP / PPP credentials
    await runDockerExec(`bash -c "
      if grep -q '^\\\\\\"${username}\\\\\\"' /etc/ppp/chap-secrets 2>/dev/null; then
        sed -i '/^\\\\\\"${username}\\\\\\"/d' /etc/ppp/chap-secrets
      fi
      echo '\\\\\\"${username}\\\\\\" * \\\\\\"${vpnPass}\\\\\\" *' >> /etc/ppp/chap-secrets
    "`);

    // 3. Add WireGuard and Shadowsocks
    let extraProtos = null;
    try {
      extraProtos = protocols.addUserProtocols(username);
    } catch (e) {
      console.error("Failed to add WG/SS protocols", e);
    }

    res.json({
      success: true,
      user: {
        name: username,
        password: vpnPass,
        ikev2Output: ikeRes.output,
        extra: extraProtos
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/users/:username', authMiddleware, async (req, res) => {
  const username = req.params.username;
  if (!username || !/^[a-zA-Z0-9_-]+$/.test(username)) {
    return res.status(400).json({ error: 'Invalid username.' });
  }

  try {
    // 0. Force disconnect any active sessions for this user
    try {
      const devices = await getConnectedDevices();
      for (const dev of devices) {
        if (dev.username === username && dev.stateId) {
          await runDockerExec(`ipsec whack --deletestate ${dev.stateId}`);
        }
      }
    } catch(e) {}

    // 1. Revoke IKEv2 client (non-interactive)
    await runDockerExec(`bash -c 'echo y | ikev2.sh --revokeclient "${username}" || true'`);

    // 2. Remove L2TP credentials
    await runDockerExec(`bash -c "
      if grep -q '^\\\\\\"${username}\\\\\\"' /etc/ppp/chap-secrets 2>/dev/null; then
        sed -i '/^\\\\\\"${username}\\\\\\"/d' /etc/ppp/chap-secrets
      fi
    "`);

    // 3. Remove WG/SS credentials
    try {
      protocols.removeUserProtocols(username);
    } catch(e) {
      console.error("Failed to remove WG/SS protocols", e);
    }

    db.removeClientAdblock(username);
    res.json({ success: true, username });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -----------------------------------------------------------------------------
// Download Packages (Single File & Complete Windows 1-Click ZIP)
// -----------------------------------------------------------------------------
app.get('/api/users/:username/download/:type', authMiddleware, async (req, res) => {
  const { username, type } = req.params;
  if (!username || !/^[a-zA-Z0-9_-]+$/.test(username)) {
    return res.status(400).json({ error: 'Invalid username.' });
  }

  const tmpExport = `/tmp/export_${username}_${Date.now()}`;
  try {
    execSync(`mkdir -p ${tmpExport}`);
    execSync(`docker cp ${VPN_CONTAINER}:/etc/ipsec.d/${username}.p12 ${tmpExport}/ 2>/dev/null || true`);
    execSync(`docker cp ${VPN_CONTAINER}:/etc/ipsec.d/${username}.mobileconfig ${tmpExport}/ 2>/dev/null || true`);
    execSync(`docker cp ${VPN_CONTAINER}:/etc/ipsec.d/${username}.sswan ${tmpExport}/ 2>/dev/null || true`);

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
      return res.download(filePath, `${username}.sswan`, () => fs.rmSync(tmpExport, { recursive: true, force: true }));
    }

    if (type === 'windows-zip') {
      const p12Path = `${tmpExport}/${username}.p12`;
      if (!fs.existsSync(p12Path)) throw new Error('Client certificate not found');

      // Generate Windows 1-Click Batch Script
      const batContent = `@echo off
:: Windows 1-Click IKEv2 Setup for ${username}
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Requesting Administrator Privileges...
    powershell -Command "Start-Process cmd -ArgumentList '/c \"\"%~dpnx0\"\"' -Verb RunAs"
    exit /b
)

cd /d "%~dp0"
echo ========================================================
echo   Setting up IKEv2 VPN: My IKEv2 VPN (${username})
echo ========================================================

echo [1/4] Cleaning up old VPN certificates for ${username}...
powershell -Command "Get-ChildItem -Path Cert:\\LocalMachine\\My | Where-Object { $_.Subject -match 'CN=${username}' } | Remove-Item -Force -ErrorAction SilentlyContinue"

echo [2/4] Importing ${username}.p12 certificate into Machine Store...
certutil -f -p "" -importpfx "%~dp0${username}.p12" NoExport

echo [3/4] Configuring Windows IPsec registry parameters...
REG ADD HKLM\\SYSTEM\\CurrentControlSet\\Services\\RasMan\\Parameters /v NegotiateDH2048_AES256 /t REG_DWORD /d 0x1 /f

echo [4/4] Creating Windows IKEv2 VPN profile...
powershell -Command "Remove-VpnConnection -Name 'My IKEv2 VPN' -Force -ErrorAction SilentlyContinue; Add-VpnConnection -ServerAddress '${SERVER_IP}' -Name 'My IKEv2 VPN' -TunnelType IKEv2 -AuthenticationMethod MachineCertificate -EncryptionLevel Required -PassThru; Set-VpnConnectionIPsecConfiguration -ConnectionName 'My IKEv2 VPN' -AuthenticationTransformConstants GCMAES128 -CipherTransformConstants GCMAES128 -EncryptionMethod AES256 -IntegrityCheckMethod SHA256 -PfsGroup None -DHGroup Group14 -PassThru -Force"

echo.
echo ========================================================
echo Setup Complete! 
echo Click the Wi-Fi/Network icon in your taskbar and click Connect on 'My IKEv2 VPN'.
echo ========================================================
pause
`;
      fs.writeFileSync(`${tmpExport}/install_windows_ikev2.bat`, batContent);

      const readmeContent = `=== IKEv2 VPN Setup Instructions for ${username} ===

Server Address: ${SERVER_IP}
Client Name:    ${username}

WINDOWS 10 / 11 SETUP (Easiest):
1. Extract all files in this ZIP archive to a folder on your Windows PC.
2. Right-click on "install_windows_ikev2.bat" and choose "Run as administrator".
3. Click your network tray icon -> Select "My IKEv2 VPN" -> Click Connect!

MANUAL POWERSHELL SETUP:
1. Open PowerShell as Administrator.
2. Run:
   certutil -f -p "" -importpfx "${username}.p12" NoExport
   REG ADD HKLM\\SYSTEM\\CurrentControlSet\\Services\\RasMan\\Parameters /v NegotiateDH2048_AES256 /t REG_DWORD /d 0x1 /f
   Add-VpnConnection -ServerAddress '${SERVER_IP}' -Name 'My IKEv2 VPN' -TunnelType IKEv2 -AuthenticationMethod MachineCertificate -EncryptionLevel Required -PassThru
   Set-VpnConnectionIPsecConfiguration -ConnectionName 'My IKEv2 VPN' -AuthenticationTransformConstants GCMAES128 -CipherTransformConstants GCMAES128 -EncryptionMethod AES256 -IntegrityCheckMethod SHA256 -PfsGroup None -DHGroup Group14 -PassThru -Force
`;
      fs.writeFileSync(`${tmpExport}/README.txt`, readmeContent);

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${username}_windows_ikev2.zip"`);

      const archive = archiver('zip', { zlib: { level: 9 } });
      archive.on('end', () => fs.rmSync(tmpExport, { recursive: true, force: true }));
      archive.on('error', (err) => res.status(500).send({ error: err.message }));

      archive.pipe(res);
      archive.file(`${tmpExport}/install_windows_ikev2.bat`, { name: 'install_windows_ikev2.bat' });
      archive.file(`${tmpExport}/${username}.p12`, { name: `${username}.p12` });
      archive.file(`${tmpExport}/README.txt`, { name: 'README.txt' });
      archive.finalize();
      return;
    }

    res.status(400).json({ error: 'Invalid download type.' });
  } catch (err) {
    if (fs.existsSync(tmpExport)) fs.rmSync(tmpExport, { recursive: true, force: true });
    res.status(500).json({ error: err.message });
  }
});

// -----------------------------------------------------------------------------
// Backup Export & Import (Server Migration)
// -----------------------------------------------------------------------------
const upload = multer({
  dest: '/tmp/vpn-uploads/',
  limits: { fileSize: 500 * 1024 * 1024 } // 500MB max
});

app.get('/api/backup/export', authMiddleware, async (req, res) => {
  const tmpDir = `/tmp/vpn_backup_${Date.now()}`;
  try {
    execSync(`mkdir -p ${tmpDir}/ipsec.d ${tmpDir}/ppp ${tmpDir}/data ${tmpDir}/wireguard ${tmpDir}/xray`);

    // 1. Copy IPsec certificates & keys from VPN container
    execSync(`docker cp ${VPN_CONTAINER}:/etc/ipsec.d/. ${tmpDir}/ipsec.d/ 2>/dev/null || true`);

    // 2. Copy L2TP/PPP credentials
    execSync(`docker cp ${VPN_CONTAINER}:/etc/ppp/. ${tmpDir}/ppp/ 2>/dev/null || true`);

    // 3. Copy WG and Xray
    execSync(`cp -r /etc/wireguard/* ${tmpDir}/wireguard/ 2>/dev/null || true`);
    execSync(`cp -r /etc/xray/* ${tmpDir}/xray/ 2>/dev/null || true`);

    // 4. Copy SQLite activity DB & JSON settings
    const dbSource = path.join(__dirname, 'data', 'vpn_activity.db');
    if (fs.existsSync(dbSource)) {
      execSync(`cp "${dbSource}" "${tmpDir}/data/vpn_activity.db"`);
    }
    const jsonDb = path.join(__dirname, 'data', 'users.json');
    if (fs.existsSync(jsonDb)) {
      execSync(`cp "${jsonDb}" "${tmpDir}/data/users.json"`);
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
      version: 1,
      exportedAt: new Date().toISOString(),
      serverIp: SERVER_IP,
      contents: ['ipsec.d/', 'ppp/', 'data/', 'vpn.env']
    };
    fs.writeFileSync(`${tmpDir}/manifest.json`, JSON.stringify(manifest, null, 2));

    // Stream as .tar.gz
    const dateStr = new Date().toISOString().slice(0, 10);
    const filename = `vpn_backup_${dateStr}.tar.gz`;

    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const archive = archiver('tar', { gzip: true, gzipOptions: { level: 9 } });
    archive.on('error', (err) => {
      console.error('[Backup] Archive error:', err);
      if (!res.headersSent) res.status(500).json({ error: err.message });
    });
    archive.on('end', () => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    archive.pipe(res);
    archive.directory(`${tmpDir}/ipsec.d`, 'ipsec.d');
    archive.directory(`${tmpDir}/ppp`, 'ppp');
    archive.directory(`${tmpDir}/wireguard`, 'wireguard');
    archive.directory(`${tmpDir}/xray`, 'xray');
    archive.directory(`${tmpDir}/data`, 'data');
    archive.file(`${tmpDir}/vpn.env`, { name: 'vpn.env' });
    archive.file(`${tmpDir}/manifest.json`, { name: 'manifest.json' });
    archive.finalize();
  } catch (err) {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/backup/import', authMiddleware, upload.single('backup'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No backup file uploaded.' });
  }

  const uploadedPath = req.file.path;
  const extractDir = `/tmp/vpn_restore_${Date.now()}`;

  try {
    // Extract the tar.gz
    execSync(`mkdir -p "${extractDir}"`);
    execSync(`tar -xzf "${uploadedPath}" -C "${extractDir}"`);

    // Validate manifest
    const manifestPath = path.join(extractDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      throw new Error('Invalid backup: missing manifest.json. This does not appear to be a valid VPN backup archive.');
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!manifest.version || !manifest.exportedAt) {
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
      execSync(`docker cp "${ipsecDir}/." ${VPN_CONTAINER}:/etc/ipsec.d/`);
      restored.push('IPsec certificates & keys');
    }

    // 2. Restore L2TP/PPP credentials
    if (fs.existsSync(pppDir)) {
      execSync(`docker cp "${pppDir}/." ${VPN_CONTAINER}:/etc/ppp/`);
      restored.push('L2TP credentials');
    }
    
    // 2.5 Restore WireGuard & Xray
    if (fs.existsSync(wgDir)) {
      execSync(`mkdir -p /etc/wireguard && cp -r "${wgDir}/"* /etc/wireguard/ || true`);
      restored.push('WireGuard configuration');
    }
    if (fs.existsSync(xrayDir)) {
      execSync(`mkdir -p /etc/xray && cp -r "${xrayDir}/"* /etc/xray/ || true`);
      restored.push('Shadowsocks configuration');
    }

    // 3. Restore SQLite activity DB & users.json
    if (fs.existsSync(dataDir)) {
      const targetDir = path.join(__dirname, 'data');
      if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
      execSync(`cp -r "${dataDir}/"* "${targetDir}/" || true`);
      restored.push('Activity logs & Users JSON');
    }

    // 4. Log the vpn.env info (user should update their host vpn.env manually)
    const envBackup = path.join(extractDir, 'vpn.env');
    let envNote = '';
    if (fs.existsSync(envBackup)) {
      restored.push('vpn.env configuration (included in archive)');
      envNote = 'Your vpn.env configuration is included in the backup. Update your host vpn.env with these values if migrating to a new server.';
    }

    // 5. Restart VPN container to pick up restored certs
    exec(`docker restart ${VPN_CONTAINER}`, (err) => {
      if (err) console.error('[Backup] VPN container restart error:', err.message);
      else console.log('[Backup] VPN container restarted after import.');
    });

    // Cleanup
    fs.unlinkSync(uploadedPath);
    // 5. Restart VPN services
    execSync(`docker restart ${VPN_CONTAINER}`);
    try {
      execSync(`docker restart wireguard xray`);
    } catch (e) {
      console.error("Failed to restart WG/SS containers", e.message);
    }

    fs.rmSync(extractDir, { recursive: true, force: true });
    if (fs.existsSync(uploadedPath)) fs.rmSync(uploadedPath, { force: true });

    res.json({ success: true, restored });
  } catch (err) {
    if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true });
    if (fs.existsSync(uploadedPath)) fs.rmSync(uploadedPath, { force: true });
    res.status(500).json({ error: err.message });
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
