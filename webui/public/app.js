// ==============================================================================
// VPN Control Panel: Client-side Application Controller
// ==============================================================================

let serverState = {
  activeTab: 'overview',
  serverIp: '37.27.11.96',
  psk: '',
  pskVisible: false,
  users: [],
  devices: [],
  rawTelemetry: '',
  bandwidth: { current: {}, history: [] }
};

// -----------------------------------------------------------------------------
// Initialization & Authentication
// -----------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  checkAuth();

  document.getElementById('login-form').addEventListener('submit', handleLogin);
  document.getElementById('form-add-user').addEventListener('submit', handleCreateUser);
  document.getElementById('user-search').addEventListener('input', handleSearch);

});

async function checkAuth() {
  try {
    const res = await fetch('/api/auth/check');
    const data = await res.json();
    if (data.authenticated) {
      document.getElementById('login-screen').classList.add('hidden');
      document.getElementById('app-container').classList.remove('hidden');
      fetchDashboardData();

      // Real-time telemetry interval
      setInterval(fetchDashboardData, 3000);
    } else {
      document.getElementById('login-screen').classList.remove('hidden');
      document.getElementById('app-container').classList.add('hidden');
    }
  } catch (err) {
    showToast('Failed to check authentication status', 'error');
  }
}

async function handleLogin(e) {
  e.preventDefault();
  const password = document.getElementById('login-password').value;
  const errorEl = document.getElementById('login-error');
  errorEl.classList.add('hidden');

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    const data = await res.json();
    if (data.success) {
      checkAuth();
    } else {
      errorEl.textContent = data.error || 'Authentication failed';
      errorEl.classList.remove('hidden');
    }
  } catch (err) {
    errorEl.textContent = 'Server connection error';
    errorEl.classList.remove('hidden');
  }
}

async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  location.reload();
}

// -----------------------------------------------------------------------------
// Data Fetching & Dashboard Rendering
// -----------------------------------------------------------------------------
async function fetchDashboardData() {
  try {
    const [statusRes, usersRes] = await Promise.all([
      fetch('/api/status'),
      fetch('/api/users')
    ]);

    if (statusRes.status === 401 || usersRes.status === 401) {
      return checkAuth();
    }

    const statusData = await statusRes.json();
    const usersData = await usersRes.json();

    serverState.serverIp = statusData.serverIp;
    serverState.psk = statusData.psk;
    serverState.rawTelemetry = statusData.ipsecDetails;
    serverState.devices = statusData.devices || [];
    serverState.bandwidth = statusData.bandwidth || { current: {}, history: [] };
    serverState.users = usersData.users || [];

    renderHeaderStats(statusData);
    renderBandwidthChart(serverState.bandwidth);
    renderConnectedDevices(serverState.devices);
    renderUsersList(serverState.users);
  } catch (err) {
    console.error('Fetch error:', err);
  }
}

async function kickDevice(stateId) {
  if (!confirm('Are you sure you want to forcibly disconnect this client?')) return;

  try {
    const res = await fetch('/api/connections/kick', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stateId })
    });

    const data = await res.json();
    if (data.error) {
      alert(data.error);
    } else {
      showToast('Client disconnected.', 'success');
      await fetchDashboardData();
    }
  } catch (err) {
    alert('Network error disconnecting client');
  }
}

function renderHeaderStats(data) {
  document.getElementById('stat-ip').textContent = data.serverIp;
  document.getElementById('stat-tunnels').textContent = data.activeConnections;

  // Format uptime
  const uptimeMins = Math.floor(data.uptimeSeconds / 60);
  const uptimeHours = Math.floor(uptimeMins / 60);
  const uptimeDays = Math.floor(uptimeHours / 24);
  let uptimeStr = `${uptimeMins}m`;
  if (uptimeHours > 0) uptimeStr = `${uptimeHours % 24}h ${uptimeMins % 60}m`;
  if (uptimeDays > 0) uptimeStr = `${uptimeDays}d ${uptimeHours % 24}h`;

  document.getElementById('stat-uptime').textContent = uptimeStr;
  document.getElementById('card-ip').textContent = data.serverIp;
  document.getElementById('card-tunnels').textContent = `${data.activeConnections} Active`;
  document.getElementById('card-load').textContent = `${data.loadAverage} / ${data.memoryUsagePercent}%`;

  if (serverState.pskVisible) {
    document.getElementById('card-psk').textContent = data.psk;
  }
}

function togglePSK() {
  serverState.pskVisible = !serverState.pskVisible;
  const pskEl = document.getElementById('card-psk');
  pskEl.textContent = serverState.pskVisible ? serverState.psk : '••••••••••••';
}

// -----------------------------------------------------------------------------
// Live Bandwidth SVG Chart Renderer
// -----------------------------------------------------------------------------
function renderBandwidthChart(bw) {
  const current = bw.current || {};
  const history = bw.history || [];

  document.getElementById('bw-rx-current').textContent = current.rxFormatted || '0.0 Mbps';
  document.getElementById('bw-tx-current').textContent = current.txFormatted || '0.0 Mbps';

  const emptyEl = document.getElementById('bw-chart-empty');
  if (history.length < 2) {
    emptyEl.classList.remove('hidden');
    return;
  }
  emptyEl.classList.add('hidden');

  const width = 300;
  const height = 80;
  const maxVal = Math.max(...history.map(h => Math.max(h.rxMbps, h.txMbps)), 1);

  const rxPoints = [];
  const txPoints = [];

  const step = width / (history.length - 1);
  history.forEach((pt, idx) => {
    const x = (idx * step).toFixed(1);
    const rxY = (height - (pt.rxMbps / maxVal) * (height - 10) - 5).toFixed(1);
    const txY = (height - (pt.txMbps / maxVal) * (height - 10) - 5).toFixed(1);

    rxPoints.push(`${x},${rxY}`);
    txPoints.push(`${x},${txY}`);
  });

  const rxPoly = rxPoints.join(' ');
  const txPoly = txPoints.join(' ');

  document.getElementById('bw-rx-line').setAttribute('points', rxPoly);
  document.getElementById('bw-tx-line').setAttribute('points', txPoly);

  const rxArea = `0,${height} ${rxPoly} ${width},${height}`;
  const txArea = `0,${height} ${txPoly} ${width},${height}`;

  document.getElementById('bw-rx-area').setAttribute('points', rxArea);
  document.getElementById('bw-tx-area').setAttribute('points', txArea);
}

function renderConnectedDevices(devices) {
  const tbody = document.getElementById('devices-tbody');
  const emptyEl = document.getElementById('devices-empty');
  const badgeEl = document.getElementById('devices-badge');

  badgeEl.textContent = `${devices.length} Online`;

  if (!devices || devices.length === 0) {
    tbody.innerHTML = '';
    emptyEl.classList.remove('hidden');
    return;
  }

  emptyEl.classList.add('hidden');
  tbody.innerHTML = devices.map(device => {
    const geo = device.geo || { flag: '🌐', country: 'Unknown', city: '' };
    const locStr = geo.city ? `${geo.city}, ${geo.country}` : geo.country;

    return `
      <tr class="hover:bg-[#181d26]/60 transition-colors">
        <td class="py-3 font-semibold text-white flex items-center gap-2">
          <span class="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_6px_#10b981]"></span>
          <span>${device.username}</span>
        </td>
        <td class="py-3 text-slate-300">
          <span class="text-sm mr-1">${geo.flag}</span>
          <span class="text-slate-300 font-sans text-xs">${locStr}</span>
        </td>
        <td class="py-3 text-slate-300">
          <span class="badge badge-emerald font-sans">${device.protocol}</span>
        </td>
        <td class="py-3 text-slate-400 font-mono text-[11px]">${device.remoteIp}</td>
        <td class="py-3 text-blue-400 font-semibold font-mono">${device.virtualIp}</td>
        <td class="py-3 text-slate-300 font-mono text-[11px]">↓ ${device.inBytesFormatted} / ↑ ${device.outBytesFormatted}</td>
        <td class="py-3 text-slate-400 font-mono text-[11px]">${device.duration}</td>
        <td class="py-3 text-right">
          ${device.stateId ? `
            <button onclick="kickDevice('${device.stateId}')" class="btn btn-danger py-1 px-2 text-[10px] flex items-center justify-end w-full" title="Disconnect Client">
              <svg class="w-3 h-3 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"></path></svg> KICK
            </button>
          ` : `
            <span class="text-[11px] font-bold text-emerald-400">CONNECTED</span>
          `}
        </td>
      </tr>
    `;
  }).join('');
}

function renderUsersList(users) {
  const grid = document.getElementById('users-grid');
  const emptyState = document.getElementById('users-empty');

  if (!users || users.length === 0) {
    grid.innerHTML = '';
    emptyState.classList.remove('hidden');
    return;
  }

  emptyState.classList.add('hidden');
  grid.innerHTML = users.map(user => `
    <div class="surface-card p-4 flex flex-col justify-between space-y-4">
      <div>
        <div class="flex items-center justify-between mb-2">
          <div class="flex items-center gap-2.5">
            <div class="w-8 h-8 rounded bg-[#1f2532] border border-[#242b38] flex items-center justify-center font-bold text-xs ${user.isOnline ? 'text-emerald-400 border-emerald-500/40 shadow-[0_0_8px_rgba(16,185,129,0.15)]' : 'text-blue-400'}">
              ${user.name.slice(0, 2).toUpperCase()}
            </div>
            <div>
              <div class="flex items-center gap-1.5">
                <span class="font-bold text-sm text-white font-mono leading-tight">${user.name}</span>
                ${user.isOnline ? '<span class="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_6px_#10b981]" title="Device Connected"></span>' : ''}
              </div>
              <div class="flex items-center gap-1.5 mt-1">
                ${user.isOnline ? '<span class="badge badge-emerald">ONLINE</span>' : ''}
                ${user.hasIkev2 ? '<span class="badge badge-cobalt">IKEv2</span>' : ''}
                ${user.hasL2tp ? '<span class="badge badge-amber">L2TP</span>' : ''}
                ${user.hasWg ? '<span class="badge bg-blue-500/10 text-blue-400 border border-blue-500/20">WG</span>' : ''}
                ${user.hasSs ? '<span class="badge bg-purple-500/10 text-purple-400 border border-purple-500/20">SS</span>' : ''}
              </div>
            </div>
          </div>

          <button onclick="deleteUser('${user.name}')" class="text-slate-500 hover:text-rose-400 p-1.5 transition-colors rounded hover:bg-[#1f2532]" title="Revoke Client">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
          </button>
        </div>

        <!-- Per-Client AdBlock Switch -->
        <div class="mt-3 pt-2.5 border-t border-[#242b38]/60 flex items-center justify-between">
          <div class="flex items-center gap-1.5 text-xs text-slate-300">
            <span>🛡️ Ad & Malware Block</span>
            ${user.adblockEnabled ? '<span class="text-[10px] text-emerald-400 font-bold font-mono">ON</span>' : '<span class="text-[10px] text-slate-500 font-mono">OFF</span>'}
          </div>
          <label class="toggle-switch">
            <input type="checkbox" ${user.adblockEnabled ? 'checked' : ''} onchange="toggleClientAdblock('${user.name}', this.checked)">
            <span class="slider"></span>
          </label>
        </div>
      </div>

      <div class="pt-3 border-t border-[#242b38] flex items-center justify-end">
        <button onclick="openGuideModal('${user.name}')" class="btn-primary text-[11px] py-1.5 px-3">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
          <span>Connect device</span>
        </button>
      </div>
    </div>
  `).join('');
}

async function toggleClientAdblock(username, enabled) {
  try {
    const res = await fetch('/api/adblock/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, enabled })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`AdBlock ${enabled ? 'Enabled' : 'Disabled'} for '${username}'`, 'success');
      fetchDashboardData();
    } else {
      showToast(data.error || 'Failed to update AdBlock setting', 'error');
    }
  } catch (err) {
    showToast('Failed to communicate with server', 'error');
  }
}

function updateClientFilterDropdown(users) {
  const select = document.getElementById('log-filter-client');
  if (!select) return;
  const currentVal = select.value;
  let options = '<option value="">All Clients</option>';
  for (const u of users) {
    options += `<option value="${u.name}" ${currentVal === u.name ? 'selected' : ''}>${u.name}</option>`;
  }
  select.innerHTML = options;
}

function handleSearch(e) {
  const query = e.target.value.toLowerCase();
  const filtered = serverState.users.filter(u => u.name.toLowerCase().includes(query));
  renderUsersList(filtered);
}

// -----------------------------------------------------------------------------
// Browsing Activity & DNS Logs Controller
// -----------------------------------------------------------------------------
async function fetchLogsData() {
  try {
    const offset = serverState.logsPage * serverState.logsLimit;
    const url = `/api/logs?limit=${serverState.logsLimit}&offset=${offset}&search=${encodeURIComponent(serverState.logsSearch)}&client=${encodeURIComponent(serverState.logsClient)}&status=${encodeURIComponent(serverState.logsStatus)}`;

    const [logsRes, statsRes] = await Promise.all([
      fetch(url),
      fetch('/api/logs/stats')
    ]);

    if (logsRes.status === 401) return checkAuth();

    const logsData = await logsRes.json();
    const statsData = await statsRes.json();

    serverState.logs = logsData.logs || [];
    serverState.logsTotal = logsData.total || 0;

    renderLogsStats(statsData);
    renderLogsTable(serverState.logs, serverState.logsTotal);
  } catch (err) {
    console.error('Logs fetch error:', err);
  }
}

function renderLogsStats(stats) {
  document.getElementById('stat-log-today').textContent = (stats.totalToday || 0).toLocaleString();
  document.getElementById('stat-log-blocked').textContent = (stats.blockedToday || 0).toLocaleString();

  const chipsContainer = document.getElementById('top-domains-chips');
  if (!stats.topDomains || stats.topDomains.length === 0) {
    chipsContainer.innerHTML = '<span class="text-xs text-slate-500 italic">No queries recorded yet today</span>';
    return;
  }

  chipsContainer.innerHTML = stats.topDomains.map(d => `
    <button onclick="filterByDomain('${d.domain}')" class="domain-chip">
      <span>${d.domain}</span>
      <span class="text-[10px] text-blue-400 bg-[#0a0c10] px-1.5 py-0.5 rounded">${d.query_count}</span>
    </button>
  `).join('');
}

function renderLogsTable(logs, total) {
  const tbody = document.getElementById('logs-tbody');
  const emptyEl = document.getElementById('logs-empty');
  const paginationInfo = document.getElementById('logs-pagination-info');
  const btnPrev = document.getElementById('btn-prev-page');
  const btnNext = document.getElementById('btn-next-page');

  if (!logs || logs.length === 0) {
    tbody.innerHTML = '';
    emptyEl.classList.remove('hidden');
    paginationInfo.textContent = 'Showing 0-0 of 0';
    btnPrev.disabled = true;
    btnNext.disabled = true;
    return;
  }

  emptyEl.classList.add('hidden');
  tbody.innerHTML = logs.map(log => {
    const d = new Date(log.timestamp);
    const timeFormatted = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const dateFormatted = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    const isBlocked = log.status === 'BLOCKED';

    return `
      <tr class="hover:bg-[#181d26]/60 transition-colors">
        <td class="py-2.5 text-slate-400">
          <div>${timeFormatted}</div>
          <div class="text-[10px] text-slate-500 font-sans">${dateFormatted}</div>
        </td>
        <td class="py-2.5 font-bold text-white flex items-center gap-2">
          <div class="w-5 h-5 rounded bg-[#1f2532] text-blue-400 flex items-center justify-center text-[10px]">
            ${log.client_name.slice(0, 1).toUpperCase()}
          </div>
          <span>${log.client_name}</span>
        </td>
        <td class="py-2.5 text-slate-400 font-mono text-[11px]">${log.client_ip}</td>
        <td class="py-2.5">
          <a href="https://${log.domain}" target="_blank" rel="noopener noreferrer" class="text-blue-400 hover:underline font-semibold flex items-center gap-1.5 ${isBlocked ? 'line-through text-slate-400' : ''}">
            <svg class="w-3 h-3 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"></path></svg>
            <span>${log.domain}</span>
          </a>
        </td>
        <td class="py-2.5 text-center">
          ${isBlocked ? '<span class="badge badge-rose">🛡️ BLOCKED</span>' : '<span class="badge badge-emerald">RESOLVED</span>'}
        </td>
        <td class="py-2.5 text-right">
          <span class="badge badge-cobalt text-[10px]">${log.qtype || 'A'}</span>
        </td>
      </tr>
    `;
  }).join('');

  const startIdx = serverState.logsPage * serverState.logsLimit + 1;
  const endIdx = Math.min(startIdx + logs.length - 1, total);
  paginationInfo.textContent = `Showing ${startIdx}-${endIdx} of ${total.toLocaleString()}`;

  btnPrev.disabled = serverState.logsPage === 0;
  btnNext.disabled = endIdx >= total;
}

function changeLogPage(delta) {
  serverState.logsPage = Math.max(0, serverState.logsPage + delta);
  fetchLogsData();
}

function filterByDomain(domain) {
  serverState.logsSearch = domain;
  const searchInput = document.getElementById('log-search');
  if (searchInput) searchInput.value = domain;
  serverState.logsPage = 0;
  fetchLogsData();
}

function exportLogsCsv() {
  const client = serverState.logsClient;
  const status = serverState.logsStatus;
  window.location.href = `/api/logs/export/csv?client=${encodeURIComponent(client)}&status=${encodeURIComponent(status)}`;
}

async function clearAllLogs() {
  if (!confirm('Are you sure you want to delete all stored browsing history logs? This action cannot be undone.')) {
    return;
  }

  try {
    const res = await fetch('/api/logs/clear', { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      showToast('All browsing history logs cleared', 'success');
      fetchLogsData();
    } else {
      showToast(data.error || 'Failed to clear logs', 'error');
    }
  } catch (err) {
    showToast('Failed to communicate with server', 'error');
  }
}

// -----------------------------------------------------------------------------
// User Creation & Actions
// -----------------------------------------------------------------------------
function openAddUserModal() {
  document.getElementById('new-username').value = '';
  document.getElementById('new-password').value = '';
  document.getElementById('modal-add-user').classList.add('active');
}

async function handleCreateUser(e) {
  e.preventDefault();
  const username = document.getElementById('new-username').value.trim();
  const password = document.getElementById('new-password').value.trim();
  const submitBtn = document.getElementById('btn-create-submit');

  if (!username) return;

  submitBtn.disabled = true;
  submitBtn.innerHTML = `
    <svg class="animate-spin -ml-1 mr-2 h-4 w-4 text-white" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
    Generating Certificates...
  `;

  try {
    const res = await fetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (data.success) {
      closeModal('modal-add-user');
      showToast(`Client '${username}' created successfully!`, 'success');
      if (!password && data.user && data.user.password) {
        window.prompt('Copy the generated L2TP password:', data.user.password);
      }
      await fetchDashboardData();
      openGuideModal(username);
    } else {
      showToast(data.error || 'Failed to create user', 'error');
    }
  } catch (err) {
    showToast('Failed to communicate with server', 'error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = '<span>Generate Client</span>';
  }
}

async function deleteUser(username) {
  if (!confirm(`Are you sure you want to revoke and delete client '${username}'?`)) {
    return;
  }

  try {
    const res = await fetch(`/api/users/${username}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      showToast(`Client '${username}' deleted.`, 'success');
      fetchDashboardData();
    } else {
      showToast(data.error || 'Failed to delete client', 'error');
    }
  } catch (err) {
    showToast('Server error while deleting user', 'error');
  }
}

// -----------------------------------------------------------------------------
// Modals & Helper Views
// -----------------------------------------------------------------------------
function renderConnectionConfig(containerId, textId, qrId, value) {
  const container = document.getElementById(containerId);
  container.classList.toggle('hidden', !value);
  if (!value) return;

  const normalizedValue = `${value.replace(/\r\n/g, '\n').trim()}\n`;
  document.getElementById(textId).textContent = normalizedValue;
  const qr = document.getElementById(qrId);
  qr.innerHTML = '';
  if (typeof QRCode !== 'undefined') {
    new QRCode(qr, {
      text: normalizedValue,
      width: 512,
      height: 512,
      colorDark: '#000000',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.L
    });
  }
}

async function downloadClientArtifact(username, type, button) {
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = 'Preparing…';
  try {
    const response = await fetch(`/api/users/${encodeURIComponent(username)}/download/${type}`);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || 'Download could not be prepared.');
    }

    const blob = await response.blob();
    const disposition = response.headers.get('Content-Disposition') || '';
    const filenameMatch = disposition.match(/filename="?([^";]+)"?/i);
    const fallbackNames = {
      'windows-zip': `${username}_windows_ikev2.zip`,
      mobileconfig: `${username}.mobileconfig`,
      sswan: `${username}.sswan`,
      wireguard: `${username}.conf`,
      p12: `${username}.p12`
    };
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filenameMatch ? filenameMatch[1] : fallbackNames[type];
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    showToast(`${link.download} downloaded.`, 'success');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
  }
}

async function openGuideModal(username) {
  const user = serverState.users.find((item) => item.name === username);
  if (!user) {
    showToast('Client details are still loading. Try again.', 'error');
    return;
  }

  document.getElementById('guide-username').textContent = username;
  const downloads = [
    ['guide-btn-win-zip', 'windows-zip'],
    ['guide-btn-apple', 'mobileconfig'],
    ['guide-btn-android', 'sswan'],
    ['guide-btn-wireguard', 'wireguard'],
    ['guide-btn-p12', 'p12']
  ];
  for (const [buttonId, type] of downloads) {
    const button = document.getElementById(buttonId);
    button.onclick = () => downloadClientArtifact(username, type, button);
  }

  try {
    const response = await fetch(`/api/users/${encodeURIComponent(username)}/configs`);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || 'Connection configuration could not be loaded.');
    }
    const { wgConfig = '', ssUri = '', androidCertificatePassword = '' } = await response.json();
    document.getElementById('guide-android-password').textContent = androidCertificatePassword;
    renderConnectionConfig('guide-wireguard', 'guide-wg-config', 'guide-wg-qrcode', wgConfig);
    renderConnectionConfig('guide-shadowsocks', 'guide-ss-config', 'guide-ss-qrcode', ssUri);
    document.getElementById('guide-modern-protocols').classList.toggle('hidden', !wgConfig && !ssUri);
    document.getElementById('modal-guide').classList.add('active');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function showDiagnostics() {
  document.getElementById('diag-raw-output').textContent = serverState.rawTelemetry || 'No daemon output available.';
  document.getElementById('modal-diag').classList.add('active');
}

// -----------------------------------------------------------------------------
// Backup Export & Import
// -----------------------------------------------------------------------------
function exportBackup() {
  showToast('Preparing backup archive...', 'info');
  window.location.href = '/api/backup/export';
}

function openImportModal() {
  const fileInput = document.getElementById('import-file');
  if (fileInput) fileInput.value = '';
  document.getElementById('import-progress').classList.add('hidden');
  document.getElementById('btn-import-submit').disabled = false;
  document.getElementById('modal-import').classList.add('active');
}

async function importBackup() {
  const fileInput = document.getElementById('import-file');
  if (!fileInput.files || fileInput.files.length === 0) {
    showToast('Please select a backup file first.', 'error');
    return;
  }

  if (!confirm('This will overwrite ALL current certificates, user accounts, and credentials. The VPN server will restart. Are you sure?')) {
    return;
  }

  const submitBtn = document.getElementById('btn-import-submit');
  const progressEl = document.getElementById('import-progress');
  submitBtn.disabled = true;
  progressEl.classList.remove('hidden');

  const formData = new FormData();
  formData.append('backup', fileInput.files[0]);

  try {
    const res = await fetch('/api/backup/import', {
      method: 'POST',
      body: formData
    });
    const data = await res.json();

    if (data.success) {
      closeModal('modal-import');
      showToast('Backup imported! VPN is restarting...', 'success');

      if (data.restored && data.restored.length > 0) {
        setTimeout(() => {
          showToast(`Restored: ${data.restored.join(', ')}`, 'success');
        }, 1500);
      }

      // Reload data after a brief delay for VPN restart
      setTimeout(() => fetchDashboardData(), 5000);
    } else {
      showToast(data.error || 'Import failed.', 'error');
    }
  } catch (err) {
    showToast('Failed to upload backup: ' + err.message, 'error');
  } finally {
    submitBtn.disabled = false;
    progressEl.classList.add('hidden');
  }
}

function closeModal(modalId) {
  document.getElementById(modalId).classList.remove('active');
}

function copyElementText(elementId) {
  const text = document.getElementById(elementId).textContent;
  navigator.clipboard.writeText(text);
  showToast('Copied to clipboard!', 'success');
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = 'toast';

  let icon = 'ℹ️';
  if (type === 'success') icon = '✅';
  if (type === 'error') icon = '⚠️';

  toast.innerHTML = `<span>${icon}</span><span>${message}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(20px)';
    toast.style.transition = 'all 0.2s ease';
    setTimeout(() => toast.remove(), 200);
  }, 3000);
}
