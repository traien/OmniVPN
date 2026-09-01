const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('client removal revokes and deletes the IKEv2 certificate', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /'--revokeclient', username, '--yes'/);
  assert.match(server, /'--deleteclient', username, '--yes'/);
  assert.match(server, /omnivpn-clean-configs/);
});

test('generated connection material includes required passwords and forwarding', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const protocols = fs.readFileSync(path.join(__dirname, '..', 'protocols.js'), 'utf8');
  assert.equal((server.match(/\. \/etc\/ipsec\.d\/\.vpnconfig/g) || []).length, 2);
  assert.doesNotMatch(server, /\. \/etc\/ipsec\.d\/ikev2\.conf/);
  assert.match(server, /certutil\.exe -f -p \$p12Password -importpfx \$p12Path NoExport/);
  assert.match(server, /if \(\$LASTEXITCODE -ne 0\) \{ throw 'Windows could not import the P12 certificate\.'/);
  assert.match(server, /VPN profile '\$profileName' installed successfully/);
  assert.match(server, /archive\.file\(`\$\{tmpExport\}\/install_windows_ikev2\.ps1`/);
  assert.match(server, /const profileName = username/);
  assert.match(server, /Add-VpnConnection -ServerAddress \$serverAddress -Name \$profileName/);
  assert.match(server, /X509Store\('My', 'LocalMachine'\)[\s\S]*?\$machineStore\.Remove\(\$_\)/);
  assert.match(server, /X509Store\('Root', 'LocalMachine'\)[\s\S]*?\$rootStore\.Remove\(\$_\)/);
  assert.match(server, /remainingClients\.Count -ne 0 -or \$remainingRoots\.Count -ne 0/);
  assert.match(server, /clientCertificates\.Count -ne 1/);
  assert.match(server, /trustedRoots\.Count -ne 1/);
  assert.match(protocols, /PostUp = iptables -A FORWARD/);
  assert.match(protocols, /PostDown = iptables -D FORWARD/);
  assert.match(protocols, /method: 'aes-128-gcm', password: u\.xrayPass/);
  assert.match(protocols, /const stored = getDb\(\);[\s\S]*syncWg\(stored\);[\s\S]*syncXray\(stored\);/);
});

test('Windows guide offers only the ZIP installer and Kick removes the parent IKE state', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.doesNotMatch(html, /guide-powershell-cmd|Copy Command/);
  assert.doesNotMatch(app, /powershellCmd|ikev2-config-password/);
  assert.match(server, /findParentIkeStateId/);
  assert.match(server, /disconnectIpsecState/);
  assert.match(server, /if \(result\.success\) invalidateDevicesCache\(\)/);
});

test('connection center avoids stale assets and copies only the requested artifact', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(server, /express\.static\(path\.join\(__dirname, 'public'\), \{ etag: true, maxAge: 0 \}\)/);
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /app\.js\?v=connection-center-6/);
  assert.match(html, /style\.css\?v=connection-center-6/);
  assert.match(server, /const requiredExtensions = type === 'windows-zip' \? \['p12'\] : \[type\]/);
  assert.doesNotMatch(server, /Promise\.all\(\['p12', 'mobileconfig', 'sswan'\]/);
  assert.doesNotMatch(app, /openExtraConfigsModal/);
  assert.doesNotMatch(app, /href="\/api\/users\/\$\{user\.name\}\/download/);
  assert.match(server, /type === 'wireguard'/);
  assert.match(server, /filename="\$\{username\}\.conf"/);
  assert.match(server, /ANDROID_CERTIFICATE_PASSWORD = 'omnivpn'/);
  assert.match(server, /openssl pkcs12 -legacy -export/);
  assert.match(server, /profile\.name = username/);
  assert.match(server, /profile\.local\.p12 = androidP12\.output/);
  assert.match(server, /application\/vnd\.strongswan\.profile/);
});

test('browsing history is disabled when client attribution is unreliable', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const dnsProxy = fs.readFileSync(path.join(__dirname, '..', 'dns-proxy.js'), 'utf8');
  assert.doesNotMatch(server, /app\.(?:get|delete)\('\/api\/logs/);
  assert.doesNotMatch(dnsProxy, /db\.logQuery|DNS_LOGGING_ENABLED/);
});
