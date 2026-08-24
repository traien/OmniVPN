const fs = require('fs');
const { execSync } = require('child_process');
const crypto = require('crypto');

const USERS_DB = '/app/data/users.json';
const WG_CONF = '/etc/wireguard/wg0.conf';
const XRAY_CONF = '/etc/xray/config.json';
const SERVER_IP = process.env.VPN_PUBLIC_IP || '127.0.0.1';

function initProtocols() {
  if (!fs.existsSync('/app/data')) fs.mkdirSync('/app/data', { recursive: true });
  if (!fs.existsSync('/etc/wireguard')) fs.mkdirSync('/etc/wireguard', { recursive: true });
  if (!fs.existsSync('/etc/xray')) fs.mkdirSync('/etc/xray', { recursive: true });

  // Init WG
  if (!fs.existsSync(WG_CONF) || !fs.readFileSync(WG_CONF, 'utf8').includes('PrivateKey')) {
    try {
      const priv = execSync('wg genkey').toString().trim();
      const conf = `[Interface]\nAddress = 10.8.0.1\nListenPort = 51820\nPrivateKey = ${priv}\n`;
      fs.writeFileSync(WG_CONF, conf);
    } catch(e) { console.error("WG genkey failed", e); }
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
    fs.writeFileSync(XRAY_CONF, JSON.stringify(conf, null, 2));
  }
}

function getDb() {
  if (fs.existsSync(USERS_DB)) {
    return JSON.parse(fs.readFileSync(USERS_DB, 'utf8'));
  }
  return { users: {}, lastWgIp: 1 };
}

function saveDb(db) {
  fs.writeFileSync(USERS_DB, JSON.stringify(db, null, 2));
  syncWg(db);
  syncXray(db);
}

function generateWgKeys() {
  const priv = execSync('wg genkey').toString().trim();
  const pub = execSync(`echo "${priv}" | wg pubkey`).toString().trim();
  const psk = execSync('wg genpsk').toString().trim();
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
  fs.writeFileSync(WG_CONF, newConf);
  try {
    execSync('docker restart wireguard');
  } catch(e) { console.error('Failed to restart wireguard', e.message); }
}

function syncXray(db) {
  if (!fs.existsSync(XRAY_CONF)) return;
  let conf = JSON.parse(fs.readFileSync(XRAY_CONF, 'utf8'));
  let clients = [];
  for (const [name, u] of Object.entries(db.users)) {
    if (u.xrayPass) {
      clients.push({ password: u.xrayPass, email: name });
    }
  }
  if (conf.inbounds && conf.inbounds[0] && conf.inbounds[0].settings) {
    conf.inbounds[0].settings.clients = clients;
  }
  fs.writeFileSync(XRAY_CONF, JSON.stringify(conf, null, 2));
  try {
    execSync('docker restart xray');
  } catch(e) { console.error('Failed to restart xray', e.message); }
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
    db.lastWgIp++;
    if(db.lastWgIp > 254) db.lastWgIp = 2; // naive wrap
    u.wgIp = db.lastWgIp;
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
    return execSync(`echo "${m[1].trim()}" | wg pubkey`).toString().trim();
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
