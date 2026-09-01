const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { restartContainer, runFileSync } = require('./command');

const USERS_DB = '/app/data/users.json';
const WG_CONF = '/etc/wireguard/wg_confs/wg0.conf';
const XRAY_CONF = '/etc/xray/config.json';
const SERVER_IP = process.env.VPN_PUBLIC_IP || '127.0.0.1';
const WG_POST_UP = 'PostUp = iptables -A FORWARD -i %i -j ACCEPT; iptables -A FORWARD -o %i -j ACCEPT; iptables -t nat -A POSTROUTING -o eth+ -j MASQUERADE';
const WG_POST_DOWN = 'PostDown = iptables -D FORWARD -i %i -j ACCEPT; iptables -D FORWARD -o %i -j ACCEPT; iptables -t nat -D POSTROUTING -o eth+ -j MASQUERADE';

function initProtocols() {
  if (!fs.existsSync('/app/data')) fs.mkdirSync('/app/data', { recursive: true });
  if (!fs.existsSync(path.dirname(WG_CONF))) fs.mkdirSync(path.dirname(WG_CONF), { recursive: true });
  if (!fs.existsSync('/etc/xray')) fs.mkdirSync('/etc/xray', { recursive: true });

  // Init WG
  if (!fs.existsSync(WG_CONF) || !fs.readFileSync(WG_CONF, 'utf8').includes('PrivateKey')) {
    try {
      const priv = runFileSync('wg', ['genkey']).trim();
      const conf = `[Interface]\nAddress = 10.8.0.1\nListenPort = 51820\nPrivateKey = ${priv}\n${WG_POST_UP}\n${WG_POST_DOWN}\n`;
      writeSecretFile(WG_CONF, conf);
    } catch(e) { console.error("WG genkey failed", e); }
  } else {
    const current = fs.readFileSync(WG_CONF, 'utf8');
    if (!current.includes('PostUp =')) {
      const migrated = current.replace(/(PrivateKey\s*=\s*[^\n]+\n)/, `$1${WG_POST_UP}\n${WG_POST_DOWN}\n`);
      writeSecretFile(WG_CONF, migrated);
    }
  }

  // Init Xray
  let needsXrayConf = false;
  if (!fs.existsSync(XRAY_CONF)) {
    needsXrayConf = true;
  } else {
    try {
      const xconf = JSON.parse(fs.readFileSync(XRAY_CONF, 'utf8'));
      if (!xconf.inbounds || !xconf.inbounds[0] || xconf.inbounds[0].protocol !== 'shadowsocks') {
        needsXrayConf = true;
      }
    } catch(e) {
      needsXrayConf = true; // Invalid JSON
    }
  }

  if (needsXrayConf) {
    const conf = {
      inbounds: [{
        port: 8388,
        protocol: "shadowsocks",
        settings: {
          method: "aes-128-gcm",
          password: crypto.randomBytes(16).toString('hex'),
          network: "tcp,udp",
          clients: []
        }
      }],
      outbounds: [{ protocol: "freedom" }]
    };
    writeSecretFile(XRAY_CONF, JSON.stringify(conf, null, 2));
  }

  // Rebuild runtime configs on startup so existing clients receive format migrations too.
  const stored = getDb();
  syncWg(stored);
  syncXray(stored);
}

function getDb() {
  if (fs.existsSync(USERS_DB)) {
    return JSON.parse(fs.readFileSync(USERS_DB, 'utf8'));
  }
  return { users: {}, lastWgIp: 1 };
}

function saveDb(db) {
  writeSecretFile(USERS_DB, JSON.stringify(db, null, 2));
  syncWg(db);
  syncXray(db);
}

function writeSecretFile(filePath, content) {
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, content, { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
  fs.chmodSync(filePath, 0o600);
}

function generateWgKeys() {
  const priv = runFileSync('wg', ['genkey']).trim();
  const pub = runFileSync('wg', ['pubkey'], { input: `${priv}\n` }).trim();
  const psk = runFileSync('wg', ['genpsk']).trim();
  return { priv, pub, psk };
}

function syncWg(db) {
  if (!fs.existsSync(WG_CONF)) return;
  let currentConf = fs.readFileSync(WG_CONF, 'utf8');
  let interfaceBlock = currentConf.split('[Peer]')[0].trim();
  
  let newConf = interfaceBlock + '\n\n';
  for (const [name, u] of Object.entries(db.users)) {
    if (u.wgPub && u.wgIp) {
      newConf += `# USER: ${name}\n`;
      newConf += `[Peer]\nPublicKey = ${u.wgPub}\n`;
      if (u.wgPsk) newConf += `PresharedKey = ${u.wgPsk}\n`;
      newConf += `AllowedIPs = 10.8.0.${u.wgIp}/32\n\n`;
    }
  }
  writeSecretFile(WG_CONF, newConf);
  restartContainer('wireguard').then((result) => {
    if (!result.success) console.error('Failed to restart wireguard:', result.error);
  });
}

function syncXray(db) {
  if (!fs.existsSync(XRAY_CONF)) return;
  let conf = JSON.parse(fs.readFileSync(XRAY_CONF, 'utf8'));
  let clients = [];
  for (const [name, u] of Object.entries(db.users)) {
    if (u.xrayPass) {
      clients.push({ method: 'aes-128-gcm', password: u.xrayPass, email: name });
    }
  }
  if (conf.inbounds && conf.inbounds[0] && conf.inbounds[0].settings) {
    conf.inbounds[0].settings.clients = clients;
  }
  writeSecretFile(XRAY_CONF, JSON.stringify(conf, null, 2));
  restartContainer('xray').then((result) => {
    if (!result.success) console.error('Failed to restart xray:', result.error);
  });
}

function addUserProtocols(name) {
  const db = getDb();
  if (!db.users[name]) db.users[name] = {};
  const u = db.users[name];
  
  if (!u.wgPub) {
    const keys = generateWgKeys();
    u.wgPriv = keys.priv;
    u.wgPub = keys.pub;
    u.wgPsk = keys.psk;
    const used = new Set(Object.values(db.users).map((user) => Number(user.wgIp)).filter(Boolean));
    const nextIp = Array.from({ length: 253 }, (_, index) => index + 2).find((candidate) => !used.has(candidate));
    if (!nextIp) throw new Error('WireGuard address pool is exhausted.');
    u.wgIp = nextIp;
    db.lastWgIp = nextIp;
  }
  if (!u.xrayPass) {
    u.xrayPass = crypto.randomBytes(16).toString('hex');
  }
  
  saveDb(db);
  return u;
}

function removeUserProtocols(name) {
  const db = getDb();
  if (db.users[name]) {
    delete db.users[name];
    saveDb(db);
  }
}

function getServerWgPub() {
  if (!fs.existsSync(WG_CONF)) return '';
  const conf = fs.readFileSync(WG_CONF, 'utf8');
  const m = conf.match(/PrivateKey\s*=\s*(.*)/);
  if (m && m[1]) {
    return runFileSync('wg', ['pubkey'], { input: `${m[1].trim()}\n` }).trim();
  }
  return '';
}

function getAllProtocols() {
  return getDb().users;
}

module.exports = {
  initProtocols,
  addUserProtocols,
  removeUserProtocols,
  getServerWgPub,
  getAllProtocols
};
