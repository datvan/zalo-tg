/* ═══════════════════════════════════════════════════════════
   zalo-tg Bridge — Frontend Controller
   ═══════════════════════════════════════════════════════════ */

const invoke = window.__TAURI__?.core?.invoke;
const $ = (s, p = document) => p.querySelector(s);
const $$ = (s, p = document) => Array.from(p.querySelectorAll(s));

const state = {
  bridge: false,
  uptime: null,
  msgsToday: 0,
  msgLog: [],
  logs: [],
  chartData: new Array(60).fill(0),
  activity: [],
  config: null,
  contacts: { friends: [], groups: [] },
  contactTab: 'friends',
  prevRunning: false,
  logPaused: false,
  lastLogCount: 0,
};

/* ── Boot ─────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', async () => {
  if (!invoke) { showFallback(); return; }
  setupNav();
  setupControls();
  setupSettings();
  setupContacts();
  await loadConfig();
  setupDragDrop();
  initChart();
  startPolling();
});

function showFallback() {
  $('#app').innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-muted)">Tauri API not available. Run in Tauri context.</div>';
}

/* ── Navigation ───────────────────────────────────────────── */
function setupNav() {
  const views = ['dashboard', 'messages', 'contacts', 'settings'];
  $$('.nav-item[data-view]').forEach(item => {
    item.addEventListener('click', () => {
      const v = item.dataset.view;
      if (!views.includes(v)) return;
      switchView(v);
    });
  });
}

function switchView(name) {
  $$('.nav-item[data-view]').forEach(n => n.classList.toggle('active', n.dataset.view === name));
  $$('.view').forEach(v => v.classList.remove('active'));
  const view = $(`#view-${name}`);
  if (!view) return;
  view.classList.add('active');
  view.querySelectorAll('.reveal').forEach(el => {
    el.style.animation = 'none';
    el.offsetHeight;
    el.style.animation = '';
  });
}

/* ── Polling ──────────────────────────────────────────────── */
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

/* ── Status Update ────────────────────────────────────────── */
function updateStatus(s) {
  state.bridge = s.running;
  state.uptime = s.uptime_secs;

  const isRunning = s.running;
  const stateLabel = isRunning ? 'running' : (s.state === 'Starting' ? 'starting' : 'stopped');

  const badge = $('#global-badge');
  badge.textContent = isRunning ? 'Running' : 'Stopped';
  badge.className = 'pill ' + (isRunning ? 'pill-running' : 'pill-stopped');

  const footStatus = $('#footer-status');
  footStatus.textContent = isRunning ? 'Running' : 'Stopped';
  footStatus.className = 'footer-status ' + (isRunning ? 'footer-running' : 'footer-stopped');

  $('#footer-uptime').textContent = isRunning && state.uptime != null ? fmtUptime(state.uptime) : '—';

  const miniDot = $('#mini-dot');
  miniDot.className = 'mini-dot mini-' + stateLabel;

  const bEl = $('#stat-bridge');
  bEl.textContent = isRunning ? 'Running' : 'Stopped';

  const bridgePulse = $('#stat-pulse-bridge');
  bridgePulse.className = 'stat-pulse ' + (isRunning ? 'green' : '');

  const dashSub = $('#dash-subtitle');
  dashSub.textContent = isRunning
    ? 'Bridge is live — forwarding messages'
    : 'Bridge offline — press Start to connect';

  detectPlatform();

  if (isRunning && !state.prevRunning) {
    addActivity('Bridge started', 'start');
    showToast('Bridge started successfully', 'success');
    loadContacts();
  } else if (!isRunning && state.prevRunning) {
    addActivity('Bridge stopped', 'stop');
    showToast('Bridge stopped', 'info');
  }
  state.prevRunning = isRunning;
}

function detectPlatform() {
  const logs = state.logs;
  const recent = logs.slice(-80);
  const zaloActive = recent.some(l => /zalo|zca/i.test(l.text));
  const tgActive = recent.some(l => /telegram|telegraf|tg/i.test(l.text) && !/ZALO_TG/.test(l.text));
  const zEl = $('#stat-zalo');
  const tEl = $('#stat-tg');
  const zPulse = $('#stat-pulse-zalo');
  const tPulse = $('#stat-pulse-tg');

  if (!state.bridge) {
    zEl.textContent = '—'; tEl.textContent = '—';
    zPulse.className = 'stat-pulse'; tPulse.className = 'stat-pulse';
    return;
  }
  const zConnected = zaloActive && !recent.some(l => l.level === 'error' && /zalo/i.test(l.text));
  const tConnected = tgActive && !recent.some(l => l.level === 'error' && /telegram/i.test(l.text));
  zEl.textContent = zConnected ? 'Connected' : 'Waiting…';
  tEl.textContent = tConnected ? 'Connected' : 'Waiting…';
  zPulse.className = 'stat-pulse ' + (zConnected ? 'green' : 'amber');
  tPulse.className = 'stat-pulse ' + (tConnected ? 'green' : 'amber');
}

/* ── Chart ────────────────────────────────────────────────── */
let chartCtx = null;
function initChart() {
  const canvas = $('#msg-chart');
  if (!canvas) return;
  resizeChart();
  setInterval(updateChartTick, 1000);
}

function resizeChart() {
  const canvas = $('#msg-chart');
  if (!canvas || !canvas.parentElement) return;
  const rect = canvas.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = rect.width;
  if (w < 10) return;
  canvas.width = w * dpr;
  canvas.height = 160 * dpr;
  canvas.style.width = w + 'px';
  canvas.style.height = '160px';
  chartCtx = canvas.getContext('2d');
  chartCtx.scale(dpr, dpr);
  drawChart();
}

let chartTickAccum = 0;
function updateChartTick() {
  chartTickAccum++;
  if (chartTickAccum < 1) return;
  chartTickAccum = 0;
  drawChart();
}

function drawChart() {
  const ctx = chartCtx;
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const w = ctx.canvas.width / dpr;
  const h = 160;
  const data = state.chartData;
  const len = data.length;
  if (len < 2) return;

  ctx.clearRect(0, 0, w, h);
  const pad = { t: 12, r: 12, b: 20, l: 28 };
  const cw = w - pad.l - pad.r;
  const ch = h - pad.t - pad.b;
  const max = Math.max(1, ...data);
  const stepX = cw / (len - 1);

  /* Grid lines */
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + (ch / 4) * i;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
  }

  const pts = data.map((v, i) => ({
    x: pad.l + i * stepX,
    y: pad.t + ch - (v / max) * ch
  }));

  /* Fill gradient */
  const grad = ctx.createLinearGradient(0, pad.t, 0, h - pad.b);
  grad.addColorStop(0, 'rgba(99,102,241,0.3)');
  grad.addColorStop(0.5, 'rgba(139,92,246,0.1)');
  grad.addColorStop(1, 'rgba(99,102,241,0.01)');
  ctx.beginPath();
  pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
  ctx.lineTo(pad.l + (len - 1) * stepX, h - pad.b);
  ctx.lineTo(pad.l, h - pad.b);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  /* Glow stroke */
  ctx.shadowColor = 'rgba(99,102,241,0.4)';
  ctx.shadowBlur = 8;
  ctx.beginPath();
  pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
  ctx.strokeStyle = 'rgba(99,102,241,0.3)';
  ctx.lineWidth = 4;
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.shadowBlur = 0;

  /* Crisp stroke */
  ctx.beginPath();
  pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
  ctx.strokeStyle = '#818cf8';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  /* Last point indicator */
  const last = data[len - 1];
  if (last > 0) {
    const p = pts[len - 1];
    ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
    ctx.fillStyle = '#818cf8'; ctx.fill();
    ctx.shadowColor = 'rgba(129,140,248,0.6)';
    ctx.shadowBlur = 8;
    ctx.beginPath(); ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
    ctx.fillStyle = '#c7d2fe'; ctx.fill();
    ctx.shadowBlur = 0;
  }

  /* Y-axis labels */
  ctx.fillStyle = 'rgba(255,255,255,0.2)';
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
}

/* ── Activity Feed ────────────────────────────────────────── */
const ACTIVITY_COLORS = {
  msg: '#818cf8', start: '#34d399', stop: '#fb7185',
  error: '#fb7185', warn: '#fbbf24', info: '#38bdf8', default: '#6b6c7e'
};

function addActivity(text, type = 'info') {
  const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  state.activity.unshift({ text, time, type });
  if (state.activity.length > 50) state.activity.pop();
  renderActivity();
}

function renderActivity() {
  const feed = $('#activity-feed');
  if (!feed) return;
  if (state.activity.length === 0) {
    feed.innerHTML = makeEmptyState('Waiting for bridge events…');
    $('#activity-count').textContent = '0';
    return;
  }
  $('#activity-count').textContent = String(state.activity.length);
  feed.innerHTML = state.activity.map(a => {
    const color = ACTIVITY_COLORS[a.type] || ACTIVITY_COLORS.default;
    return `<div class="activity-item">
      <span class="activity-icon" style="background:${color};box-shadow:0 0 6px ${color}"></span>
      <span class="text">${esc(a.text)}</span>
      <span class="activity-time">${a.time}</span>
    </div>`;
  }).join('');
}

/* ── Log Rendering ────────────────────────────────────────── */
function renderLogs() {
  const container = $('#log-container');
  if (!container || !state.logs.length) return;
  if (state.logs.length === state.lastLogCount) return;
  state.lastLogCount = state.logs.length;

  const auto = !state.logPaused;
  container.innerHTML = state.logs.slice(-200).map(l =>
    `<div class="log-line">
      <span class="log-time">${esc(l.timestamp)}</span>
      <span class="log-level log-level-${esc(l.level || 'INFO')}">${esc(l.level || 'INFO')}</span>
      <span class="log-text">${esc(l.text)}</span>
    </div>`
  ).join('');
  if (auto) container.scrollTop = container.scrollHeight;

  const lcLabel = $('#log-count-label');
  if (lcLabel) lcLabel.textContent = `${state.logs.length} lines`;

  /* Extract message events */
  const msgs = extractMessages(state.logs);
  if (msgs.length > state.msgLog.length) {
    for (let i = state.msgLog.length; i < msgs.length; i++) {
      const m = msgs[i];
      state.msgLog.unshift(m);
      addActivity(`${m.dir === 'zt' ? 'Z→T' : 'T→Z'}: ${trunc(m.text, 48)}`, 'msg');
      state.msgsToday++;
    }
    state.msgLog = state.msgLog.slice(0, 500);
    $('#stat-msgs').textContent = String(state.msgsToday);

    const recentMsgs = state.logs.filter(l => /msg|message|bridging|forward|→|<-|->/i.test(l.text));
    const perMin = Math.min(60, recentMsgs.length);
    pushChartPoint(perMin);
    $('#chart-rate').textContent = perMin + '/min';
    renderMessages();
  }
  updateFooterStats();
}

function extractMessages(logs) {
  const msgs = []; const seen = new Set();
  for (const l of logs) {
    const match = l.text.match(/(?:Message|Bridging|Forwarding|→|<-|->).{0,60}/i);
    if (!match) continue;
    const key = l.timestamp + l.text.slice(0, 40);
    if (seen.has(key)) continue; seen.add(key);
    const dir = /telegram.*zalo|tg.*→|tg.*<-/i.test(l.text) ? 'tz' :
                /zalo.*telegram|zalo.*→|zalo.*->/i.test(l.text) ? 'zt' : null;
    if (!dir) continue;
    msgs.push({ dir, text: match[0], time: l.timestamp });
  }
  return msgs;
}

/* ── Messages View ────────────────────────────────────────── */
function renderMessages() {
  const list = $('#msg-list');
  if (!list) return;

  const filterZt = $('#filter-zt')?.checked ?? true;
  const filterTz = $('#filter-tz')?.checked ?? true;
  const query = ($('#msg-search')?.value || '').toLowerCase();

  const filtered = state.msgLog.filter(m => {
    if (m.dir === 'zt' && !filterZt) return false;
    if (m.dir === 'tz' && !filterTz) return false;
    if (query && !m.text.toLowerCase().includes(query)) return false;
    return true;
  });

  $('#msg-total').textContent = String(state.msgLog.length);
  $('#msg-zt').textContent = String(state.msgLog.filter(m => m.dir === 'zt').length);
  $('#msg-tz').textContent = String(state.msgLog.filter(m => m.dir === 'tz').length);

  if (filtered.length === 0) {
    list.innerHTML = makeEmptyState('No messages match your filters');
    return;
  }
  list.innerHTML = filtered.slice(0, 100).map(m =>
    `<div class="msg-row">
      <span class="msg-direction"><span class="dir-badge dir-${m.dir}">${m.dir === 'zt' ? 'Z→T' : 'T→Z'}</span></span>
      <span class="msg-content">${esc(m.text)}</span>
      <span class="msg-meta">${esc(m.time)}</span>
    </div>`
  ).join('');
}

document.addEventListener('change', e => {
  if (e.target.id === 'filter-zt' || e.target.id === 'filter-tz') renderMessages();
});
document.addEventListener('input', e => {
  if (e.target.id === 'msg-search') renderMessages();
  if (e.target.id === 'contact-search') renderContacts();
});

/* ── Contacts View ────────────────────────────────────────── */
function setupContacts() {
  $$('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      state.contactTab = tab.dataset.tab;
      renderContacts();
    });
  });
  // Load contacts when bridge is running
  setInterval(async () => {
    if (state.bridge) await loadContacts();
  }, 30000);
}

async function loadContacts() {
  try {
    const [friends, groups] = await Promise.all([
      invoke('get_friends').catch(() => []),
      invoke('get_groups').catch(() => []),
    ]);
    if (Array.isArray(friends) && friends.length > 0) state.contacts.friends = friends;
    if (Array.isArray(groups) && groups.length > 0) state.contacts.groups = groups;
    renderContacts();
  } catch (_) {}
}

function renderContacts() {
  const list = $('#contact-list');
  if (!list) return;
  const query = ($('#contact-search')?.value || '').toLowerCase();
  const items = state.contactTab === 'friends' ? state.contacts.friends : state.contacts.groups;

  const filtered = items.filter(c =>
    !query || (c.name || '').toLowerCase().includes(query)
  );

  if (filtered.length === 0) {
    list.innerHTML = makeEmptyState(
      items.length === 0 ? 'Start the bridge to load contacts' : 'No matches'
    );
    return;
  }

  list.className = 'contact-grid';
  list.innerHTML = filtered.map((c, i) => {
    const initial = (c.name || '?').charAt(0).toUpperCase();
    const isGroup = state.contactTab === 'groups';
    const sub = isGroup ? `${c.members || 0} members` : c.alias || 'Friend';
    return `<div class="contact-card" style="animation-delay:${i * 30}ms">
      <div class="contact-avatar ${isGroup ? 'group' : ''}">${esc(initial)}</div>
      <div class="contact-info">
        <div class="contact-name">${esc(c.name)}</div>
        <div class="contact-sub">${esc(sub)}</div>
      </div>
    </div>`;
  }).join('');
}

/* ── Controls ─────────────────────────────────────────────── */
function setupControls() {
  $('#btn-start')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.innerHTML = '<span class="btn-spinner"></span><span>Starting…</span>';
    try {
      await invoke('start_bridge');
      addActivity('Starting bridge…', 'info');
    } catch (err) {
      showToast('Start failed: ' + err, 'error');
      addActivity('Start failed: ' + err, 'error');
    }
    btn.disabled = false;
    btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 20 20" fill="none"><path d="M5 3l12 7-12 7V3z" fill="currentColor"/></svg><span>Start Bridge</span>';
  });

  $('#btn-stop')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.innerHTML = '<span class="btn-spinner"></span><span>Stopping…</span>';
    try {
      await invoke('stop_bridge');
      addActivity('Stopping bridge…', 'info');
    } catch (err) {
      showToast('Stop failed: ' + err, 'error');
    }
    btn.disabled = false;
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 20 20" fill="none"><rect x="5" y="5" width="10" height="10" rx="2" fill="currentColor"/></svg><span>Stop</span>';
  });

  $('#btn-clear-logs')?.addEventListener('click', () => {
    state.logs = []; state.lastLogCount = 0;
    $('#log-container').innerHTML = '';
    $('#log-count-label').textContent = '0 lines';
  });

  $('#btn-toggle-tray')?.addEventListener('click', async () => {
    try { await invoke('toggle_window'); } catch (_) {}
  });

  const lc = $('#log-container');
  lc?.addEventListener('scroll', () => {
    state.logPaused = lc.scrollTop + lc.clientHeight < lc.scrollHeight - 20;
  });
}

/* ── Settings ─────────────────────────────────────────────── */
function setupSettings() {
  $$('.theme-opt').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.theme-opt').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  $('#btn-save-settings')?.addEventListener('click', saveSettings);
  $('#btn-browse-env')?.addEventListener('click', pickEnvAndLoad);
  $('#btn-default-env')?.addEventListener('click', resetToDefaultEnv);
  $('#btn-add-var')?.addEventListener('click', addEnvRow);
}

/* ── Drag & Drop ──────────────────────────────────────────── */
function setupDragDrop() {
  const dropZone = $('#env-drop-zone');
  if (!dropZone) return;
  let dropCounter = 0;
  const showDrop = () => { dropCounter++; dropZone.classList.add('dragover'); };
  const hideDrop = () => { dropCounter--; if (dropCounter <= 0) { dropCounter = 0; dropZone.classList.remove('dragover'); } };

  async function handleDrop(paths) {
    dropZone.classList.remove('dragover');
    dropCounter = 0;
    if (!paths?.length) return;
    const file = paths[0];
    const name = file.replace(/^.*[/\\]/, '');
    if (!name.startsWith('.env')) {
      showToast('Only .env files accepted', 'error');
      return;
    }
    try {
      const cfg = await invoke('load_custom_env', { path: file });
      applyConfig(cfg);
      showToast('Loaded: ' + name, 'success');
    } catch (e) {
      showToast('Load failed: ' + e, 'error');
    }
  }

  try {
    const { listen } = window.__TAURI__.event;
    listen('tauri://drag-drop', (event) => {
      const p = event.payload;
      if (p.type === 'enter') showDrop();
      else if (p.type === 'leave') hideDrop();
      else if (p.type === 'drop') handleDrop(p.paths);
    });
  } catch (_) {}
}

/* ── File Browser ─────────────────────────────────────────── */
async function pickEnvAndLoad() { showFileBrowser(); }

function showFileBrowser() {
  let overlay = $('#file-browser');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'file-browser';
    overlay.className = 'modal-overlay';
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = `
    <div class="modal glass">
      <div class="modal-header">
        <span class="modal-title">Browse .env file</span>
        <button class="btn btn-ghost btn-icon modal-close">
          <svg width="14" height="14" viewBox="0 0 20 20" fill="none"><path d="M5 5l10 10M15 5L5 15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        </button>
      </div>
      <div class="modal-body">
        <div class="browser-toolbar">
          <button id="browser-up" class="btn btn-sm btn-icon" title="Parent directory">
            <svg width="14" height="14" viewBox="0 0 20 20" fill="none"><path d="M10 4l-6 6h4v6h4v-6h4l-6-6z" fill="currentColor"/></svg>
          </button>
          <span id="browser-path" class="mono"></span>
        </div>
        <div id="browser-list" class="browser-list"></div>
      </div>
      <div class="modal-footer">
        <span class="browser-hint">Hidden files are shown (including .env)</span>
        <button id="browser-cancel" class="btn btn-sm btn-outline">Cancel</button>
      </div>
    </div>`;

  overlay.style.display = 'flex';

  let currentDir = state.config?.source_files?.length
    ? state.config.source_files[0].replace(/\/[^/]*$/, '')
    : null;
  if (!currentDir) {
    invoke('list_env_files').then(files => {
      currentDir = files?.length ? files[0].replace(/\/[^/]*$/, '') : '/Users/wica/lq/zalo-tg';
      loadBrowserDir(currentDir);
    }).catch(() => loadBrowserDir('/Users/wica/lq/zalo-tg'));
  } else {
    loadBrowserDir(currentDir);
  }

  overlay.querySelector('.modal-close')?.addEventListener('click', () => overlay.style.display = 'none');
  overlay.querySelector('#browser-cancel')?.addEventListener('click', () => overlay.style.display = 'none');
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.style.display = 'none'; });
}

async function loadBrowserDir(dir) {
  const list = $('#browser-list');
  const pathEl = $('#browser-path');
  const upBtn = $('#browser-up');
  if (!list || !pathEl) return;
  pathEl.textContent = dir;

  const parent = dir.replace(/\/+$/, '').replace(/\/[^/]+$/, '') || '/';
  upBtn.onclick = () => loadBrowserDir(parent);
  upBtn.style.display = parent === '/' || parent === dir ? 'none' : '';
  upBtn.disabled = parent === '/' || parent === dir;

  try {
    const entries = await invoke('scan_dir', { dir });
    list.innerHTML = '';
    const envFiles = entries.filter(e => !e.is_dir && e.name.startsWith('.env'));
    const dirs = entries.filter(e => e.is_dir);
    const others = entries.filter(e => !e.is_dir && !e.name.startsWith('.env'));
    const all = [...envFiles, ...dirs, ...others];

    if (all.length === 0) {
      list.innerHTML = makeEmptyState('Empty directory');
      return;
    }

    for (const entry of all) {
      const item = document.createElement('div');
      item.className = 'browser-item';
      if (entry.is_dir) {
        item.innerHTML = `<span class="bi-icon">📁</span><span>${esc(entry.name)}/</span>`;
        item.addEventListener('click', () => loadBrowserDir(entry.path));
      } else if (entry.name.startsWith('.env')) {
        item.innerHTML = `<span class="bi-icon bi-env">📄</span><span class="bi-name-env">${esc(entry.name)}</span><span class="bi-action">Click to load</span>`;
        item.addEventListener('click', async () => {
          try {
            const cfg = await invoke('load_custom_env', { path: entry.path });
            applyConfig(cfg);
            showToast('Loaded: ' + entry.name, 'success');
            $('#file-browser').style.display = 'none';
          } catch (e) { showToast('Load failed: ' + e, 'error'); }
        });
      } else {
        item.innerHTML = `<span class="bi-icon" style="opacity:0.4">📄</span><span style="color:var(--text-dim)">${esc(entry.name)}</span>`;
        item.style.opacity = '0.5';
      }
      list.appendChild(item);
    }
  } catch (e) {
    list.innerHTML = `<div class="empty-state" style="color:var(--rose)">Error: ${esc(String(e))}</div>`;
  }
}

/* ── Config ───────────────────────────────────────────────── */
async function loadConfig() {
  try { applyConfig(await invoke('get_config')); } catch (_) {}
}

function applyConfig(cfg) {
  state.config = cfg;
  const vars = cfg.vars || {};
  $('#config-path').value = cfg.source_files?.length ? cfg.source_files.join(', ') : 'No file loaded';
  const src = $('#config-source');
  src.textContent = cfg.source_files?.length
    ? 'Loaded from: ' + cfg.source_files.map(f => f.replace(/^.*[/\\]/, '')).join(' + ')
    : 'No config file found — add variables below and save';
  renderEnvList(vars);
  listEnvFiles();
}

async function listEnvFiles() {
  try {
    const files = await invoke('list_env_files');
    const container = $('#env-files-list');
    if (!container) return;
    if (!files?.length) {
      container.innerHTML = '<div style="color:var(--text-muted);padding:4px 0;font-size:11px">No .env files found</div>';
      return;
    }
    const current = state.config?.source_files || [];
    const currentNames = current.map(f => f.replace(/^.*[/\\]/, ''));
    container.innerHTML = '<div style="display:flex;flex-direction:column;gap:2px">' + files.map(f => {
      const name = f.replace(/^.*[/\\]/, '');
      const active = currentNames.includes(name);
      return `<button class="env-file-btn ${active ? 'active' : ''}" data-path="${esc(f)}">
        <span>📄</span><span style="flex:1">${esc(name)}</span>
        <span style="font-size:10px;color:${active ? 'var(--teal)' : 'var(--text-muted)'}">${active ? 'active' : 'load'}</span>
      </button>`;
    }).join('') + '</div>';

    container.querySelectorAll('.env-file-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          applyConfig(await invoke('load_custom_env', { path: btn.dataset.path }));
          showToast('Loaded: ' + btn.dataset.path.replace(/^.*[/\\]/, ''), 'success');
        } catch (e) { showToast('Load failed: ' + e, 'error'); }
      });
    });
  } catch (_) {}
}

function renderEnvList(vars) {
  const list = $('#env-list');
  if (!list) return;
  const keys = Object.keys(vars).sort();
  if (keys.length === 0) {
    list.innerHTML = '<div class="empty-state" style="padding:16px 0">No variables yet. Click "+ Add" to create one.</div>';
    return;
  }
  list.innerHTML = keys.map(k => envRowHTML(k, vars[k])).join('');
  list.querySelectorAll('.env-del').forEach(btn => {
    btn.addEventListener('click', () => {
      delete state.config.vars[btn.dataset.key];
      renderEnvList(state.config.vars);
    });
  });
  list.querySelectorAll('.env-key').forEach(inp => {
    inp.addEventListener('change', () => {
      const oldKey = inp.dataset.origKey;
      const newKey = inp.value.trim();
      if (newKey && newKey !== oldKey) {
        const val = state.config.vars[oldKey];
        delete state.config.vars[oldKey];
        state.config.vars[newKey] = val || '';
      }
    });
  });
  list.querySelectorAll('.env-value').forEach(inp => {
    inp.addEventListener('change', () => {
      state.config.vars[inp.dataset.key] = inp.value;
    });
  });
}

function envRowHTML(key, val) {
  const masked = /token|secret|password|key|auth/i.test(key);
  return `<div class="env-row">
    <input type="text" class="env-key" value="${esc(key)}" data-orig-key="${esc(key)}" placeholder="KEY" />
    <span style="color:var(--text-dim)">=</span>
    <input type="${masked ? 'password' : 'text'}" class="env-value" value="${esc(val || '')}" data-key="${esc(key)}" placeholder="value" />
    <button class="env-del" data-key="${esc(key)}" title="Remove">
      <svg width="12" height="12" viewBox="0 0 20 20" fill="none"><path d="M5 5l10 10M15 5L5 15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
    </button>
  </div>`;
}

function addEnvRow() {
  if (!state.config) state.config = { vars: {} };
  if (!state.config.vars) state.config.vars = {};
  const key = 'NEW_KEY_' + Date.now();
  state.config.vars[key] = '';
  renderEnvList(state.config.vars);
  const lastInput = $('#env-list .env-key:last-of-type');
  if (lastInput) setTimeout(() => lastInput.focus(), 50);
}

async function resetToDefaultEnv() {
  try {
    applyConfig(await invoke('get_config'));
    showToast('Reset to default config', 'info');
  } catch (e) { showToast('Reset failed: ' + e, 'error'); }
}

async function saveSettings() {
  if (!state.config?.vars) return;
  const btn = $('#btn-save-settings');
  btn.disabled = true;
  btn.innerHTML = '<span class="btn-spinner"></span><span>Saving…</span>';
  try {
    await invoke('save_config', { vars: state.config.vars });
    showToast('Settings saved', 'success');
  } catch (e) {
    showToast('Save failed: ' + e, 'error');
  }
  btn.disabled = false;
  btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 20 20" fill="none"><path d="M4 10l4 4 8-8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Save</span>';
}

/* ── Toast ────────────────────────────────────────────────── */
function showToast(msg, type = 'info') {
  const container = $('#toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  const icons = {
    success: '<svg width="14" height="14" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="8" stroke="currentColor" stroke-width="1.5"/><path d="M6 10l3 3 5-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    error: '<svg width="14" height="14" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="8" stroke="currentColor" stroke-width="1.5"/><path d="M7 7l6 6M13 7l-6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    info: '<svg width="14" height="14" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="8" stroke="currentColor" stroke-width="1.5"/><path d="M10 6v.01M10 9v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'
  };
  toast.innerHTML = (icons[type] || icons.info) + '<span>' + esc(msg) + '</span>';
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('out');
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

/* ── Helpers ──────────────────────────────────────────────── */
function makeEmptyState(text) {
  return `<div class="empty-state">
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2">
      <circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3" stroke-linecap="round"/>
    </svg>
    <span>${esc(text)}</span>
  </div>`;
}

function fmtUptime(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h > 0) return h + 'h ' + m + 'm';
  if (m > 0) return m + 'm ' + sec + 's';
  return sec + 's';
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = String(str ?? '');
  return d.innerHTML;
}

function trunc(str, n) { return str.length > n ? str.slice(0, n) + '…' : str; }

/* ── Resize ───────────────────────────────────────────────── */
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(resizeChart, 100);
});
