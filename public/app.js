const { invoke } = window.__TAURI__?.core ?? {};
const $ = (s, p) => (p || document).querySelector(s);
const $$ = (s, p) => (p || document).querySelectorAll(s);

/* ── State ── */
const state = {
  bridge: false, pid: null, uptime: null,
  zalo: false, tg: false,
  msgsToday: 0, msgLog: [], logs: [],
  chartData: [], chartMax: 20,
  activity: [],
  config: null,
};

/* ── Init ── */
document.addEventListener('DOMContentLoaded', async () => {
  if (!window.__TAURI__) return; // not in Tauri
  setupNav();
  setupControls();
  setupSettings();
  await loadConfig();
  initChart();
  startPolling();
});

/* ── Navigation ── */
function setupNav() {
  $$('.nav-item[data-view]').forEach(item => {
    item.addEventListener('click', () => {
      $$('.nav-item[data-view]').forEach(n => n.classList.remove('active'));
      item.classList.add('active');
      $$('.view').forEach(v => v.classList.remove('active'));
      $(`#view-${item.dataset.view}`).classList.add('active');
    });
  });
}

/* ── Polling ── */
let pollTimer;
function startPolling() { poll(); pollTimer = setInterval(poll, 1500); }
async function poll() {
  try {
    const [status, logs] = await Promise.all([
      invoke('get_bridge_status'),
      invoke('get_logs', { limit: 200 }),
    ]);
    state.logs = logs || [];
    updateStatus(status);
    renderLogs();
  } catch (_) {}
}

/* ── Status ── */
let prevRunning = false;
function updateStatus(s) {
  state.bridge = s.running;
  state.pid = s.pid;
  state.uptime = s.uptime_secs;

  const badge = $('#global-badge');
  badge.textContent = s.running ? '● Running' : '● Stopped';
  badge.className = 'badge ' + (s.running ? 'running' : 'stopped');

  const dot = $('#footer-status');
  dot.textContent = s.running ? '● Running' : '● Stopped';
  dot.className = 'status-dot ' + (s.running ? 'running anim-pulse' : 'stopped');

  $('#footer-uptime').textContent = s.running && s.uptime_secs != null
    ? fmtUptime(s.uptime_secs) : '—';

  // Stat cards
  const bEl = $('#stat-bridge');
  bEl.textContent = s.running ? 'Running' : 'Stopped';
  bEl.style.color = s.running ? 'var(--green)' : 'var(--text-muted)';
  $('.stat-icon .dot-indicator').className = 'dot-indicator ' + (s.running ? 'green' : 'red');

  // Simulate Zalo/TG status from logs
  detectPlatformStatus();

  // Detect new messages for activity & chart
  if (s.running && prevRunning === false) {
    addActivity('Bridge started', 'start');
  } else if (!s.running && prevRunning === true) {
    addActivity('Bridge stopped', 'stop');
  }
  prevRunning = s.running;
}

function detectPlatformStatus() {
  const logs = state.logs;
  const recent = logs.slice(-100);
  const zaloActive = recent.some(l => /zalo|zca/i.test(l.text));
  const tgActive = recent.some(l => /telegram|telegraf|tg/i.test(l.text) && !l.text.includes('ZALO_TG'));

  const zEl = $('#stat-zalo');
  const tEl = $('#stat-tg');

  if (!state.bridge) {
    zEl.textContent = '—'; zEl.style.color = 'var(--text-muted)';
    tEl.textContent = '—'; tEl.style.color = 'var(--text-muted)';
    return;
  }

  const zConnected = zaloActive && !recent.some(l => l.level === 'error' && /zalo/i.test(l.text));
  const tConnected = tgActive && !recent.some(l => l.level === 'error' && /telegram/i.test(l.text));

  zEl.textContent = zConnected ? 'Connected' : 'Waiting…';
  zEl.style.color = zConnected ? 'var(--green)' : 'var(--yellow)';
  tEl.textContent = tConnected ? 'Connected' : 'Waiting…';
  tEl.style.color = tConnected ? 'var(--green)' : 'var(--yellow)';

  const zStatCard = $('#stat-card-zalo .stat-icon');
  zStatCard.style.background = zConnected ? 'var(--green-dim)' : 'var(--bg-surface)';
  const tStatCard = $('#stat-card-tg .stat-icon');
  tStatCard.style.background = tConnected ? 'var(--green-dim)' : 'var(--bg-surface)';
}

/* ── Message Detection ── */
function extractMessages(logs) {
  const msgs = [];
  const seen = new Set();
  for (const l of logs) {
    // Match patterns like "Message from Zalo" or "Bridging message" or "→"
    const match = l.text.match(/(?:Message|Bridging|Forwarding|→|<-|->).{0,60}/i);
    if (!match) continue;
    const key = l.timestamp + l.text.slice(0, 40);
    if (seen.has(key)) continue;
    seen.add(key);
    const dir = /telegram.*zalo|tg.*→|tg.*<-/i.test(l.text) ? 'tz' :
                /zalo.*telegram|zalo.*→|zalo.*->/i.test(l.text) ? 'zt' : null;
    if (!dir) continue;
    msgs.push({ dir, text: match[0], time: l.timestamp });
  }
  return msgs;
}

/* ── Chart ── */
let chartCtx = null;
function initChart() {
  const canvas = $('#msg-chart');
  if (!canvas) return;
  chartCtx = canvas.getContext('2d');
  resizeChart();
  for (let i = 0; i < 60; i++) state.chartData.push(0);
}

function resizeChart() {
  const canvas = $('#msg-chart');
  if (!canvas) return;
  const rect = canvas.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = 160 * dpr;
  canvas.style.width = rect.width + 'px';
  canvas.style.height = '160px';
  chartCtx = canvas.getContext('2d');
  chartCtx.scale(dpr, dpr);
  drawChart();
}

function drawChart() {
  const ctx = chartCtx;
  if (!ctx) return;
  const canvas = ctx.canvas;
  const w = canvas.width / (window.devicePixelRatio || 1);
  const h = 160;
  const data = state.chartData;
  const len = data.length;
  if (len < 2) return;

  ctx.clearRect(0, 0, w, h);

  const pad = { t: 12, r: 12, b: 20, l: 12 };
  const cw = w - pad.l - pad.r;
  const ch = h - pad.t - pad.b;
  const max = Math.max(1, ...data);
  const stepX = cw / (len - 1);

  // Grid lines
  ctx.strokeStyle = 'rgba(38,43,64,0.4)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + (ch / 4) * i;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
  }

  // Gradient fill
  const grad = ctx.createLinearGradient(0, pad.t, 0, h - pad.b);
  grad.addColorStop(0, 'rgba(34,211,238,0.25)');
  grad.addColorStop(0.5, 'rgba(34,211,238,0.08)');
  grad.addColorStop(1, 'rgba(34,211,238,0.01)');

  ctx.beginPath();
  data.forEach((v, i) => {
    const x = pad.l + i * stepX;
    const y = pad.t + ch - (v / max) * ch;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.lineTo(pad.l + (len - 1) * stepX, h - pad.b);
  ctx.lineTo(pad.l, h - pad.b);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Line
  ctx.beginPath();
  data.forEach((v, i) => {
    const x = pad.l + i * stepX;
    const y = pad.t + ch - (v / max) * ch;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.strokeStyle = '#22D3EE';
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // Glow
  ctx.shadowColor = 'rgba(34,211,238,0.3)';
  ctx.shadowBlur = 4;
  ctx.beginPath();
  data.forEach((v, i) => {
    const x = pad.l + i * stepX;
    const y = pad.t + ch - (v / max) * ch;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.strokeStyle = 'rgba(34,211,238,0.4)';
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Dots on latest
  const last = data[len - 1];
  if (last > 0) {
    const lx = pad.l + (len - 1) * stepX;
    const ly = pad.t + ch - (last / max) * ch;
    ctx.beginPath(); ctx.arc(lx, ly, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = '#22D3EE';
    ctx.fill();
    ctx.shadowColor = 'rgba(34,211,238,0.5)';
    ctx.shadowBlur = 6;
    ctx.beginPath(); ctx.arc(lx, ly, 1.5, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  // Y-axis labels
  ctx.fillStyle = '#5c6288';
  ctx.font = '9px -apple-system, sans-serif';
  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const v = Math.round((max / 4) * (4 - i));
    const y = pad.t + (ch / 4) * i;
    ctx.fillText(String(v), pad.l - 4, y + 3);
  }
}

function pushChartPoint(val) {
  state.chartData.push(val);
  if (state.chartData.length > 60) state.chartData.shift();
  drawChart();
}

/* ── Activity ── */
function addActivity(text, type) {
  const now = new Date();
  const time = now.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
  state.activity.unshift({ text, time, type });
  if (state.activity.length > 50) state.activity.pop();
  renderActivity();
}

const ACTIVITY_ICONS = {
  msg: '💬', start: '▶', stop: '■', error: '✕', warn: '⚠', info: '●', default: '·'
};

function renderActivity() {
  const feed = $('#activity-feed');
  if (!feed) return;
  if (state.activity.length === 0) {
    feed.innerHTML = '<div class="empty-state">Waiting for bridge events…</div>';
    return;
  }
  $('#activity-count').textContent = String(state.activity.length);
  feed.innerHTML = state.activity.map(a => {
    const icon = ACTIVITY_ICONS[a.type] || ACTIVITY_ICONS.default;
    return `<div class="activity-item">
      <span class="icon">${icon}</span>
      <span class="text">${esc(a.text)}</span>
      <span class="time">${esc(a.time)}</span>
    </div>`;
  }).join('');
}

/* ── Logs ── */
let lastLogCount = 0;
let logsPaused = false;

function renderLogs() {
  const container = $('#log-container');
  if (!container || !state.logs.length) return;
  if (state.logs.length === lastLogCount) return;
  lastLogCount = state.logs.length;

  const auto = container.scrollTop + container.clientHeight >= container.scrollHeight - 20;
  container.innerHTML = state.logs.slice(-200).map(l =>
    `<div class="log-entry ${l.level}">
      <span class="log-time">${esc(l.timestamp)}</span>
      <span class="log-level ${l.level}">${esc(l.level)}</span>
      <span class="log-text">${esc(l.text)}</span>
    </div>`
  ).join('');
  if (auto) container.scrollTop = container.scrollHeight;

  // Extract messages + activity from logs
  const msgs = extractMessages(state.logs);
  if (msgs.length > state.msgLog.length) {
    for (let i = state.msgLog.length; i < msgs.length; i++) {
      const m = msgs[i];
      state.msgLog.unshift(m);
      addActivity(`${m.dir === 'zt' ? 'Z→T' : 'T→Z'}: ${trunc(m.text, 48)}`, 'msg');
      state.msgsToday++;
      $('#stat-msgs').textContent = String(state.msgsToday);
    }
    state.msgLog = state.msgLog.slice(0, 500);

    // Chart: count messages in last 60s using log timestamps
    const now = Date.now();
    const recentMsgs = state.logs.filter(l => /msg|message|bridging|forward|→|<-|->/i.test(l.text));
    const perMin = Math.min(60, recentMsgs.length);
    pushChartPoint(perMin);
    $('#chart-rate').textContent = perMin + '/min';
  }

  renderMessages();
  updateFooterStats();
}

function updateFooterStats() {
  $('#footer-stats').textContent = state.msgsToday + ' msgs today';
}

/* ── Messages View ── */
function renderMessages() {
  const list = $('#msg-list');
  const total = $('#msg-total');
  const zt = $('#msg-zt');
  const tz = $('#msg-tz');
  if (!list) return;

  const filterZt = $('#filter-zt')?.checked ?? true;
  const filterTz = $('#filter-tz')?.checked ?? true;
  const query = ($('#msg-search')?.value || '').toLowerCase();

  let filtered = state.msgLog.filter(m => {
    if (m.dir === 'zt' && !filterZt) return false;
    if (m.dir === 'tz' && !filterTz) return false;
    if (query && !m.text.toLowerCase().includes(query)) return false;
    return true;
  });

  total.textContent = String(state.msgLog.length);
  zt.textContent = String(state.msgLog.filter(m => m.dir === 'zt').length);
  tz.textContent = String(state.msgLog.filter(m => m.dir === 'tz').length);

  if (filtered.length === 0) {
    list.innerHTML = '<div class="empty-state">No messages match your filters</div>';
    return;
  }

  list.innerHTML = filtered.slice(0, 100).map(m =>
    `<div class="msg-item anim-fade-in">
      <span class="msg-direction ${m.dir}">${m.dir === 'zt' ? 'Z→T' : 'T→Z'}</span>
      <div class="msg-body">
        <div class="msg-text">${esc(m.text)}</div>
        <div class="msg-meta"><span>${esc(m.time)}</span></div>
      </div>
    </div>`
  ).join('');
}

// Re-render messages on filter/search change
document.addEventListener('change', e => {
  if (e.target.id === 'filter-zt' || e.target.id === 'filter-tz') renderMessages();
});
document.addEventListener('input', e => {
  if (e.target.id === 'msg-search') renderMessages();
});

/* ── Controls ── */
function setupControls() {
  $('#btn-start')?.addEventListener('click', startBridge);
  $('#btn-stop')?.addEventListener('click', stopBridge);
  $('#btn-clear-logs')?.addEventListener('click', () => { state.logs = []; lastLogCount = 0; $('#log-container').innerHTML = ''; });
  $('#btn-toggle-tray')?.addEventListener('click', async () => {
    try { await invoke('toggle_window'); } catch (_) {}
  });

  // Log scroll pause
  const logContainer = $('#log-container');
  if (logContainer) {
    logContainer.addEventListener('scroll', () => {
      const el = logContainer;
      logsPaused = el.scrollTop + el.clientHeight < el.scrollHeight - 20;
    });
  }
}

async function startBridge() {
  try {
    await invoke('start_bridge');
    addActivity('Starting bridge…', 'info');
  } catch (e) { addActivity('Start failed: ' + e, 'error'); }
}

async function stopBridge() {
  try {
    await invoke('stop_bridge');
    addActivity('Stopping bridge…', 'info');
  } catch (e) { addActivity('Stop failed: ' + e, 'error'); }
}

/* ── Settings ── */
function setupSettings() {
  // Theme picker
  $$('.theme-opt').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.theme-opt').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  $('#btn-save-settings')?.addEventListener('click', saveSettings);
}

async function loadConfig() {
  try {
    const cfg = await invoke('get_config');
    state.config = cfg;
    const vars = cfg.vars || {};

    const setVal = (id, key) => {
      const el = document.getElementById(id);
      if (el) el.value = vars[key] || '';
    };
    setVal('set-tg-token', 'TG_TOKEN');
    setVal('set-tg-group', 'TG_GROUP_ID');
    setVal('set-zalo-qr', 'ZALO_QR_CODE_PATH');

  } catch (e) { console.error('load config:', e); }
}

async function saveSettings() {
  if (!state.config) return;
  const vars = { ...state.config.vars };

  const getVal = (id) => {
    const el = document.getElementById(id);
    return el ? el.value : '';
  };
  if (getVal('set-tg-token')) vars['TG_TOKEN'] = getVal('set-tg-token');
  if (getVal('set-tg-group')) vars['TG_GROUP_ID'] = getVal('set-tg-group');
  if (getVal('set-zalo-qr')) vars['ZALO_QR_CODE_PATH'] = getVal('set-zalo-qr');

  try {
    await invoke('save_config', { vars });
    addActivity('Settings saved', 'info');
  } catch (e) {
    addActivity('Save failed: ' + e, 'error');
  }
}

/* ── Helpers ── */
function fmtUptime(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function trunc(str, n) {
  return str.length > n ? str.slice(0, n) + '…' : str;
}

/* ── Window Resize ── */
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(resizeChart, 100);
});

/* ── Polyfill for __TAURI__ check (for dev mode) ── */
if (!window.__TAURI__) {
  document.getElementById('app').innerHTML = '<div style="padding:40px;text-align:center;color:#5c6288">zalo-tg Bridge — run with <code>npm run tauri:dev</code></div>';
}
