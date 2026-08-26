'use strict';

const state = {
  activeTab: 'overview',
  serverIp: '',
  users: [],
  devices: [],
  rawTelemetry: '',
  logsPage: 0,
  logsLimit: 50,
  logsTotal: 0,
  logsSearch: '',
  logsClient: '',
  logsStatus: '',
  pollTimer: null,
  pskTimer: null
};

const $ = (id) => document.getElementById(id);

function node(tag, options = {}, children = []) {
  const element = document.createElement(tag);
  if (options.className) element.className = options.className;
  if (options.text !== undefined) element.textContent = options.text;
  if (options.attrs) {
    for (const [name, value] of Object.entries(options.attrs)) {
      if (value !== undefined && value !== null) element.setAttribute(name, String(value));
    }
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child) element.append(child);
  }
  return element;
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout || 12_000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (response.status === 401) {
      showLogin();
      throw new Error('Your session expired. Sign in again.');
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed with status ${response.status}.`);
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('The gateway did not respond in time. Try again.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  bindEvents();
  checkAuth();
});

function bindEvents() {
  $('login-form').addEventListener('submit', handleLogin);
  $('form-add-user').addEventListener('submit', handleCreateUser);
  $('user-search').addEventListener('input', (event) => renderUsers(state.users.filter((user) => user.name.toLowerCase().includes(event.target.value.trim().toLowerCase()))));
  $('log-filter-client').addEventListener('change', (event) => { state.logsClient = event.target.value; state.logsPage = 0; fetchLogs(); });
  $('log-filter-status').addEventListener('change', (event) => { state.logsStatus = event.target.value; state.logsPage = 0; fetchLogs(); });
  let searchTimer;
  $('log-search').addEventListener('input', (event) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.logsSearch = event.target.value.trim(); state.logsPage = 0; fetchLogs(); }, 300);
  });

  document.addEventListener('click', handleClick);
  document.addEventListener('change', handleChange);
  document.addEventListener('keydown', handleKeyboard);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopPolling();
    else if (!$('app-container').hidden) startPolling();
  });
}

async function handleClick(event) {
  const target = event.target.closest('button, a');
  if (!target) return;
  if (target.matches('[data-close-dialog]')) return target.closest('dialog')?.close();
  if (target.dataset.tab) return switchTab(target.dataset.tab);
  if (target.dataset.action === 'kick') return kickDevice(target.dataset.stateId);
  if (target.dataset.action === 'delete') return deleteUser(target.dataset.username);
  if (target.dataset.action === 'guide') return openGuide(target.dataset.username);
  if (target.dataset.action === 'configs') return openConfigs(target.dataset.username);
  if (target.dataset.domain) return filterByDomain(target.dataset.domain);
  if (target.dataset.copy) return copyText(target.dataset.copy);

  const actions = {
    'action-export': exportBackup,
    'action-import': () => openDialog('modal-import'),
    'action-diagnostics': showDiagnostics,
    'action-logout': logout,
    'action-new-client': openCreateClient,
    'action-first-client': openCreateClient,
    'action-toggle-psk': togglePsk,
    'action-export-logs': exportLogs,
    'action-clear-logs': clearLogs,
    'btn-prev-page': () => changeLogPage(-1),
    'btn-next-page': () => changeLogPage(1),
    'btn-import-submit': importBackup
  };
  if (actions[target.id]) actions[target.id]();
}

function handleChange(event) {
  if (event.target.matches('[data-adblock-user]')) {
    toggleAdblock(event.target.dataset.adblockUser, event.target.checked, event.target);
  }
}

function handleKeyboard(event) {
  const tab = event.target.closest('[role="tab"]');
  if (!tab || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  const next = event.key === 'ArrowRight' ? 'logs' : 'overview';
  switchTab(next);
  $(`tab-${next}`).focus();
}

async function checkAuth() {
  try {
    const data = await fetchJson('/api/auth/check');
    if (data.authenticated) showApp();
    else showLogin();
  } catch (error) {
    showLogin(error.message);
  }
}

async function handleLogin(event) {
  event.preventDefault();
  const error = $('login-error');
  error.hidden = true;
  const submit = event.submitter;
  submit.disabled = true;
  submit.textContent = 'Verifying…';
  try {
    await fetchJson('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('login-password').value }) });
    $('login-password').value = '';
    showApp();
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
    $('login-password').focus();
  } finally {
    submit.disabled = false;
    submit.textContent = 'Open command center';
  }
}

function showLogin(message = '') {
  stopPolling();
  $('app-container').hidden = true;
  $('login-screen').hidden = false;
  if (message) { $('login-error').textContent = message; $('login-error').hidden = false; }
}

function showApp() {
  $('login-screen').hidden = true;
  $('app-container').hidden = false;
  refreshDashboard();
  startPolling();
}

function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(refreshDashboard, 5_000);
}

function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
}

async function logout() {
  try { await fetchJson('/api/auth/logout', { method: 'POST' }); } catch {}
  showLogin();
}

function switchTab(tab) {
  state.activeTab = tab;
  for (const name of ['overview', 'logs']) {
    const active = name === tab;
    $(`view-${name}`).hidden = !active;
    $(`tab-${name}`).setAttribute('aria-selected', String(active));
    $(`tab-${name}`).tabIndex = active ? 0 : -1;
  }
  if (tab === 'logs') fetchLogs();
}

async function refreshDashboard() {
  try {
    const [status, users] = await Promise.all([fetchJson('/api/status'), fetchJson('/api/users')]);
    state.serverIp = status.serverIp;
    state.rawTelemetry = status.ipsecDetails;
    state.devices = status.devices || [];
    state.users = users.users || [];
    renderStatus(status);
    renderBandwidth(status.bandwidth || { current: {}, history: [] });
    renderDevices(state.devices);
    renderUsers(state.users);
    renderClientOptions(state.users);
  } catch (error) {
    $('header-health').textContent = 'Gateway unavailable';
    showToast(error.message, 'error');
  }
}

function renderStatus(data) {
  $('header-health').textContent = data.vpnStatus === 'online' ? 'Gateway healthy' : 'Gateway degraded';
  $('stat-ip').textContent = data.serverIp || 'Unconfigured';
  $('stat-tunnels').textContent = String(data.activeConnections || 0);
  $('card-ip').textContent = data.serverIp || 'Unconfigured';
  $('card-tunnels').textContent = String(data.activeConnections || 0);
  $('card-load').textContent = `${data.loadAverage || '0.00'} / ${data.memoryUsagePercent || 0}%`;
  $('stat-scope').textContent = data.metricScope || 'unknown';
  const minutes = Math.max(0, Math.floor((data.uptimeSeconds || 0) / 60));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  $('stat-uptime').textContent = days ? `${days}d ${hours}h` : `${hours}h ${minutes % 60}m`;
}

function renderBandwidth(bandwidth) {
  const current = bandwidth.current || {};
  const history = bandwidth.history || [];
  $('bw-rx-current').textContent = current.rxFormatted || '0 KB/s';
  $('bw-tx-current').textContent = current.txFormatted || '0 KB/s';
  $('bw-chart-empty').hidden = history.length >= 2;
  if (history.length < 2) return;
  const width = 600;
  const height = 180;
  const max = Math.max(1, ...history.flatMap((point) => [point.rxMbps || 0, point.txMbps || 0]));
  const points = (key) => history.map((point, index) => `${(index * width / (history.length - 1)).toFixed(1)},${(height - ((point[key] || 0) / max) * 160 - 10).toFixed(1)}`).join(' ');
  const rx = points('rxMbps');
  $('bw-rx-line').setAttribute('points', rx);
  $('bw-tx-line').setAttribute('points', points('txMbps'));
  $('bw-rx-area').setAttribute('points', `0,${height} ${rx} ${width},${height}`);
}

function renderDevices(devices) {
  const list = $('devices-list');
  list.replaceChildren();
  $('devices-badge').textContent = `${devices.length} online`;
  $('devices-empty').hidden = devices.length > 0;
  for (const device of devices) {
    const location = device.geo?.city ? `${device.geo.city}, ${device.geo.country}` : device.geo?.country || 'Location private';
    const copy = node('div', { className: 'connection-copy' }, [node('strong', { text: device.username || 'Unknown client' }), node('small', { text: `${device.protocol} · ${location} · ${device.duration}` })]);
    const action = device.stateId ? node('button', { className: 'button button-danger', text: 'Disconnect', attrs: { type: 'button', 'data-action': 'kick', 'data-state-id': device.stateId, 'aria-label': `Disconnect ${device.username}` } }) : node('span', { className: 'status-pill', text: 'connected' });
    list.append(node('div', { className: 'connection-item' }, [node('span', { className: 'connection-avatar', text: (device.username || '?').slice(0, 1).toUpperCase() }), copy, action]));
  }
}

function protocolTag(label) { return node('span', { className: 'protocol-tag', text: label }); }

function renderUsers(users) {
  const list = $('users-grid');
  list.replaceChildren();
  $('users-empty').hidden = users.length > 0;
  for (const user of users) {
    const identity = node('div', { className: 'client-identity' }, [node('span', { className: 'client-initials', text: user.name.slice(0, 2).toUpperCase() }), node('div', {}, [node('strong', { text: user.name }), node('small', { text: user.isOnline ? 'Connected now' : 'Offline' })])]);
    const protocols = node('div', { className: 'protocol-list' });
    if (user.hasIkev2) protocols.append(protocolTag('IKEv2'));
    if (user.hasL2tp) protocols.append(protocolTag('L2TP'));
    if (user.hasWg) protocols.append(protocolTag('WireGuard'));
    if (user.hasSs) protocols.append(protocolTag('Shadowsocks'));
    const toggle = node('label', { className: 'toggle-control' }, [node('input', { attrs: { type: 'checkbox', 'data-adblock-user': user.name, 'aria-label': `Ad and malware blocking for ${user.name}` } }), node('span', { text: 'Block ads' })]);
    toggle.querySelector('input').checked = Boolean(user.adblockEnabled);
    const actions = node('div', { className: 'client-actions' }, [toggle, node('button', { className: 'button button-quiet', text: 'Connect', attrs: { type: 'button', 'data-action': 'guide', 'data-username': user.name } })]);
    if (user.hasWg || user.hasSs) actions.append(node('button', { className: 'button button-quiet', text: 'QR configs', attrs: { type: 'button', 'data-action': 'configs', 'data-username': user.name } }));
    actions.append(node('button', { className: 'button button-danger', text: 'Delete', attrs: { type: 'button', 'data-action': 'delete', 'data-username': user.name } }));
    list.append(node('article', { className: 'client-row' }, [identity, protocols, actions]));
  }
}

function renderClientOptions(users) {
  const select = $('log-filter-client');
  const current = select.value;
  select.replaceChildren(node('option', { text: 'All clients', attrs: { value: '' } }));
  users.forEach((user) => select.append(node('option', { text: user.name, attrs: { value: user.name } })));
  select.value = users.some((user) => user.name === current) ? current : '';
}

async function kickDevice(stateId) {
  if (!window.confirm('Disconnect this tunnel now? The client may reconnect automatically.')) return;
  try { await fetchJson('/api/connections/kick', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stateId }) }); await refreshDashboard(); showToast('Tunnel disconnected.'); } catch (error) { showToast(error.message, 'error'); }
}

function openCreateClient() {
  $('form-add-user').reset();
  openDialog('modal-add-user');
  requestAnimationFrame(() => $('new-username').focus());
}

async function handleCreateUser(event) {
  event.preventDefault();
  if (!event.currentTarget.reportValidity()) return;
  const submit = $('btn-create-submit');
  submit.disabled = true;
  submit.textContent = 'Provisioning…';
  try {
    const data = await fetchJson('/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: $('new-username').value.trim(), password: $('new-password').value }) , timeout: 90_000 });
    $('modal-add-user').close();
    if (!$('new-password').value && data.user?.password) {
      try {
        await navigator.clipboard.writeText(data.user.password);
        showToast('Client created. The generated password is copied to your clipboard.');
      } catch {
        window.prompt('Client created. Copy this generated password now; it will not be shown again.', data.user.password);
      }
    } else showToast('Client created across all protocols.');
    await refreshDashboard();
    openGuide(data.user.name);
  } catch (error) { showToast(error.message, 'error'); }
  finally { submit.disabled = false; submit.textContent = 'Create client'; }
}

async function deleteUser(username) {
  if (!window.confirm(`Delete ${username}? Certificates and protocol credentials will be revoked immediately.`)) return;
  try { await fetchJson(`/api/users/${encodeURIComponent(username)}`, { method: 'DELETE', timeout: 90_000 }); showToast(`${username} was deleted.`); await refreshDashboard(); } catch (error) { showToast(error.message, 'error'); }
}

async function toggleAdblock(username, enabled, input) {
  input.disabled = true;
  try { await fetchJson('/api/adblock/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, enabled }) }); showToast(`Ad blocking ${enabled ? 'enabled' : 'disabled'} for ${username}.`); } catch (error) { input.checked = !enabled; showToast(error.message, 'error'); } finally { input.disabled = false; }
}

async function openGuide(username) {
  $('guide-username').textContent = username;
  $('guide-btn-win-zip').onclick = () => { window.location.assign(`/api/users/${encodeURIComponent(username)}/download/windows-zip`); };
  $('guide-link-apple').href = `/api/users/${encodeURIComponent(username)}/download/mobileconfig`;
  $('guide-link-android').href = `/api/users/${encodeURIComponent(username)}/download/sswan`;
  $('guide-powershell-cmd').textContent = `certutil -f -importpfx "${username}.p12" NoExport\nAdd-VpnConnection -ServerAddress '${state.serverIp}' -Name 'OmniVPN' -TunnelType IKEv2 -AuthenticationMethod MachineCertificate -EncryptionLevel Required -PassThru`;
  $('guide-config-password').textContent = 'Unavailable';
  openDialog('modal-guide');
  try {
    const secret = await fetchJson('/api/secrets/ikev2-config-password');
    $('guide-config-password').textContent = secret.password;
  } catch {}
}

async function openConfigs(username) {
  try {
    const data = await fetchJson(`/api/users/${encodeURIComponent(username)}/configs`);
    $('extra-username').textContent = username;
    $('wg-config-text').textContent = data.wgConfig || 'WireGuard configuration unavailable.';
    $('ss-config-text').textContent = data.ssUri || 'Shadowsocks configuration unavailable.';
    const renderQr = (container, text) => {
      container.replaceChildren();
      if (text && window.QRCode) new window.QRCode(container, { text, width: 160, height: 160, colorDark: '#29251f', colorLight: '#ffffff', correctLevel: window.QRCode.CorrectLevel.M });
    };
    renderQr($('wg-qrcode'), data.wgConfig);
    renderQr($('ss-qrcode'), data.ssUri);
    openDialog('modal-extra-configs');
  } catch (error) { showToast(error.message, 'error'); }
}

async function togglePsk() {
  const output = $('card-psk');
  if (output.dataset.revealed === 'true') return hidePsk();
  try {
    const data = await fetchJson('/api/secrets/ipsec-psk');
    output.textContent = data.psk;
    output.dataset.revealed = 'true';
    $('action-toggle-psk').textContent = 'Hide now';
    clearTimeout(state.pskTimer);
    state.pskTimer = setTimeout(hidePsk, 15_000);
  } catch (error) { showToast(error.message, 'error'); }
}

function hidePsk() { $('card-psk').textContent = 'Protected'; $('card-psk').dataset.revealed = 'false'; $('action-toggle-psk').textContent = 'Reveal briefly'; }
function showDiagnostics() { $('diag-raw-output').textContent = state.rawTelemetry || 'No diagnostic output is available.'; openDialog('modal-diag'); }
function openDialog(id) { const dialog = $(id); if (!dialog.open) dialog.showModal(); }

async function fetchLogs() {
  try {
    const query = new URLSearchParams({ limit: state.logsLimit, offset: state.logsPage * state.logsLimit, search: state.logsSearch, client: state.logsClient, status: state.logsStatus });
    const [logs, stats] = await Promise.all([fetchJson(`/api/logs?${query}`), fetchJson('/api/logs/stats')]);
    state.logsTotal = logs.total || 0;
    renderLogStats(stats);
    renderLogs(logs.logs || []);
  } catch (error) { showToast(error.message, 'error'); }
}

function renderLogStats(stats) {
  $('stat-log-today').textContent = Number(stats.totalToday || 0).toLocaleString();
  $('stat-log-blocked').textContent = Number(stats.blockedToday || 0).toLocaleString();
  const domains = $('top-domains-chips');
  domains.replaceChildren();
  if (!stats.topDomains?.length) domains.append(node('span', { text: 'No recorded domains today.' }));
  else stats.topDomains.forEach((domain) => domains.append(node('button', { className: 'domain-chip', text: `${domain.domain} · ${domain.query_count}`, attrs: { type: 'button', 'data-domain': domain.domain } })));
}

function renderLogs(logs) {
  const body = $('logs-tbody');
  body.replaceChildren();
  $('logs-empty').hidden = logs.length > 0;
  logs.forEach((log) => {
    const date = new Date(log.timestamp);
    const domainLink = node('a', { text: log.domain, attrs: { href: `https://${log.domain}`, target: '_blank', rel: 'noopener noreferrer' } });
    body.append(node('tr', {}, [node('td', { text: new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date) }), node('td', { text: log.client_name || 'VPN client' }), node('td', { text: log.client_ip }), node('td', {}, domainLink), node('td', { text: log.status === 'BLOCKED' ? 'Blocked' : 'Resolved' }), node('td', { text: log.qtype || 'A' })]));
  });
  const start = logs.length ? state.logsPage * state.logsLimit + 1 : 0;
  const end = Math.min(start + logs.length - 1, state.logsTotal);
  $('logs-pagination-info').textContent = `Showing ${start}–${Math.max(0, end)} of ${state.logsTotal.toLocaleString()}`;
  $('btn-prev-page').disabled = state.logsPage === 0;
  $('btn-next-page').disabled = end >= state.logsTotal;
}

function filterByDomain(domain) { state.logsSearch = domain; state.logsPage = 0; $('log-search').value = domain; fetchLogs(); }
function changeLogPage(delta) { state.logsPage = Math.max(0, state.logsPage + delta); fetchLogs(); }
function exportLogs() { window.location.assign(`/api/logs/export/csv?client=${encodeURIComponent(state.logsClient)}&status=${encodeURIComponent(state.logsStatus)}`); }

async function clearLogs() {
  if (!window.confirm('Permanently clear all recorded DNS activity?')) return;
  try { await fetchJson('/api/logs/clear', { method: 'DELETE' }); state.logsPage = 0; await fetchLogs(); showToast('DNS history cleared.'); } catch (error) { showToast(error.message, 'error'); }
}

function exportBackup() { showToast('Preparing an encrypted backup…'); window.location.assign('/api/backup/export'); }

async function importBackup() {
  const file = $('import-file').files?.[0];
  if (!file) return showToast('Choose an OmniVPN backup first.', 'error');
  if (!window.confirm('Restore this backup and restart every VPN service? Current credentials will be replaced.')) return;
  const button = $('btn-import-submit');
  button.disabled = true;
  $('import-progress').hidden = false;
  const body = new FormData();
  body.append('backup', file);
  try { await fetchJson('/api/backup/import', { method: 'POST', body, timeout: 180_000 }); $('modal-import').close(); showToast('Backup restored. VPN services are restarting.'); setTimeout(refreshDashboard, 5_000); } catch (error) { showToast(error.message, 'error'); } finally { button.disabled = false; $('import-progress').hidden = true; }
}

async function copyText(id) {
  try { await navigator.clipboard.writeText($(id).textContent); showToast('Copied to clipboard.'); } catch { showToast('Clipboard access was denied. Select and copy the text manually.', 'error'); }
}

function showToast(message, type = 'info') {
  const toast = node('div', { className: 'toast', text: message, attrs: { 'data-type': type } });
  $('toast-container').replaceChildren(toast);
  setTimeout(() => toast.remove(), 4_500);
}
