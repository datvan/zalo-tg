const invoke = window.__TAURI__?.core?.invoke;
const $ = (s, p) => (p || document).querySelector(s);
const $$ = (s, p) => (p || document).querySelectorAll(s);

const state = {
  bridge: false, pid: null, uptime: null,
  zalo: false, tg: false,
  msgsToday: 0, msgLog: [], logs: [],
  chartData: [],
  activity: [],
  config: null,
};

document.addEventListener('DOMContentLoaded', async () => {
  if (!invoke) { showFallback(); return; }
  setupNav();
  setupControls();
  setupSettings();
  await loadConfig();
  setupDragDrop();
  initChart();
  startPolling();
});

function showFallback() {
  document.getElementById('app').innerHTML =
    '<div style="padding:40px;text-align:center;color:#5c6288;font-family:system-ui">zalo-tg Bridge</div>';
}

function setupNav() {
  const views = { dashboard: 1, messages: 1, settings: 1 };
  $$('.nav-item[data-view]').forEach(item => {
    item.addEventListener('click', () => {
      if (!views[item.dataset.view]) return;
      $$('.nav-item[data-view]').forEach(n => n.classList.remove('active'));
      item.classList.add('active');
      $$('.view').forEach(v => v.classList.remove('active'));
      const view = $(`#view-${item.dataset.view}`);
      if (view) view.classList.add('active');
    });
  });
}

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

let prevRunning = false;

function updateStatus(s) {
  state.bridge = s.running;
  state.pid = s.pid;
  state.uptime = s.uptime_secs;

  const badge = $('#global-badge');
  badge.textContent = s.running ? '● RUNNING' : '● STOPPED';
  badge.className = 'badge ' + (s.running ? 'running' : 'stopped');

  const dot = $('#footer-status');
  dot.textContent = s.running ? '● Running' : '● Stopped';
  dot.className = 'status-dot ' + (s.running ? 'running anim-pulse' : 'stopped');
  $('#footer-uptime').textContent = s.running && s.uptime_secs != null ? fmtUptime(s.uptime_secs) : '—';

  const bEl = $('#stat-bridge');
  bEl.textContent = s.running ? 'Running' : 'Stopped';
  bEl.style.color = s.running ? 'var(--green)' : 'var(--text-muted)';
  const bridgeDot = $('.stat-icon .dot-indicator');
  if (bridgeDot) bridgeDot.className = 'dot-indicator ' + (s.running ? 'green' : 'red');

  detectPlatform();

  if (s.running && !prevRunning) addActivity('Bridge started', 'start');
  else if (!s.running && prevRunning) addActivity('Bridge stopped', 'stop');
  prevRunning = s.running;
}

function detectPlatform() {
  const logs = state.logs;
  const recent = logs.slice(-80);
  const zaloActive = recent.some(l => /zalo|zca/i.test(l.text));
  const tgActive = recent.some(l => /telegram|telegraf|tg/i.test(l.text) && !/ZALO_TG/.test(l.text));
  const zEl = $('#stat-zalo');
  const tEl = $('#stat-tg');
  if (!state.bridge) {
    zEl.textContent = '—'; zEl.style.color = 'var(--text-muted)';
    tEl.textContent = '—'; tEl.style.color = 'var(--text-muted)';
    const zi = $('#stat-card-zalo .stat-icon');
    const ti = $('#stat-card-tg .stat-icon');
    if (zi) zi.style.background = 'var(--bg-surface)';
    if (ti) ti.style.background = 'var(--bg-surface)';
    return;
  }
  const zConnected = zaloActive && !recent.some(l => l.level === 'error' && /zalo/i.test(l.text));
  const tConnected = tgActive && !recent.some(l => l.level === 'error' && /telegram/i.test(l.text));
  zEl.textContent = zConnected ? 'Connected' : 'Waiting…';
  zEl.style.color = zConnected ? 'var(--green)' : 'var(--yellow)';
  tEl.textContent = tConnected ? 'Connected' : 'Waiting…';
  tEl.style.color = tConnected ? 'var(--green)' : 'var(--yellow)';
  const zi = $('#stat-card-zalo .stat-icon');
  const ti = $('#stat-card-tg .stat-icon');
  if (zi) zi.style.background = zConnected ? 'var(--green-dim)' : 'var(--bg-surface)';
  if (ti) ti.style.background = tConnected ? 'var(--green-dim)' : 'var(--bg-surface)';
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

let chartCtx = null;
function initChart() {
  const canvas = $('#msg-chart');
  if (!canvas) return;
  chartCtx = canvas.getContext('2d');
  for (let i = 0; i < 60; i++) state.chartData.push(0);
  resizeChart();
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
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  chartCtx = ctx;
  drawChart();
}

function drawChart() {
  const ctx = chartCtx;
  if (!ctx) return;
  const canvas = ctx.canvas;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.width / dpr;
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

  ctx.strokeStyle = 'rgba(38,43,64,0.4)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + (ch / 4) * i;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
  }

  const pts = data.map((v, i) => ({
    x: pad.l + i * stepX,
    y: pad.t + ch - (v / max) * ch
  }));

  const grad = ctx.createLinearGradient(0, pad.t, 0, h - pad.b);
  grad.addColorStop(0, 'rgba(34,211,238,0.25)');
  grad.addColorStop(0.5, 'rgba(34,211,238,0.08)');
  grad.addColorStop(1, 'rgba(34,211,238,0.01)');
  ctx.beginPath();
  pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
  ctx.lineTo(pad.l + (len - 1) * stepX, h - pad.b);
  ctx.lineTo(pad.l, h - pad.b);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.shadowColor = 'rgba(34,211,238,0.3)';
  ctx.shadowBlur = 4;
  ctx.beginPath();
  pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
  ctx.strokeStyle = 'rgba(34,211,238,0.4)';
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.shadowBlur = 0;

  ctx.beginPath();
  pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
  ctx.strokeStyle = '#22D3EE';
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.stroke();

  const last = data[len - 1];
  if (last > 0) {
    const p = pts[len - 1];
    ctx.beginPath(); ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = '#22D3EE'; ctx.fill();
    ctx.shadowColor = 'rgba(34,211,238,0.5)';
    ctx.shadowBlur = 6;
    ctx.beginPath(); ctx.arc(p.x, p.y, 1.5, 0, Math.PI * 2);
    ctx.fillStyle = '#fff'; ctx.fill();
    ctx.shadowBlur = 0;
  }

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

const ACTIVITY_ICONS = { msg:'💬', start:'▶', stop:'■', error:'✕', warn:'⚠', info:'●', default:'·' };

function addActivity(text, type) {
  const now = new Date();
  const time = now.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
  state.activity.unshift({ text, time, type: type || 'info' });
  if (state.activity.length > 50) state.activity.pop();
  renderActivity();
}

function renderActivity() {
  const feed = $('#activity-feed');
  if (!feed) return;
  if (state.activity.length === 0) {
    feed.innerHTML = '<div class="empty-state">Waiting for bridge events…</div>';
    $('#activity-count').textContent = '0';
    return;
  }
  $('#activity-count').textContent = String(state.activity.length);
  feed.innerHTML = state.activity.map(a =>
    `<div class="activity-item">
      <span class="icon">${ACTIVITY_ICONS[a.type] || ACTIVITY_ICONS.default}</span>
      <span class="text">${esc(a.text)}</span>
      <span class="time">${a.time}</span>
    </div>`
  ).join('');
}

let lastLogCount = 0;
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

function updateFooterStats() {
  const el = $('#footer-stats');
  if (el) el.textContent = state.msgsToday + ' msgs today';
}

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

  if (total) total.textContent = String(state.msgLog.length);
  if (zt) zt.textContent = String(state.msgLog.filter(m => m.dir === 'zt').length);
  if (tz) tz.textContent = String(state.msgLog.filter(m => m.dir === 'tz').length);

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

document.addEventListener('change', e => {
  if (e.target.id === 'filter-zt' || e.target.id === 'filter-tz') renderMessages();
});
document.addEventListener('input', e => {
  if (e.target.id === 'msg-search') renderMessages();
});

function setupControls() {
  const start = $('#btn-start');
  const stop = $('#btn-stop');
  if (start) start.addEventListener('click', async () => {
    start.disabled = true; start.textContent = 'Starting…';
    try { await invoke('start_bridge'); addActivity('Starting bridge…', 'info'); }
    catch (e) { addActivity('Start failed: ' + e, 'error'); }
    start.disabled = false; start.textContent = 'Start Bridge';
  });
  if (stop) stop.addEventListener('click', async () => {
    stop.disabled = true; stop.textContent = 'Stopping…';
    try { await invoke('stop_bridge'); addActivity('Stopping bridge…', 'info'); }
    catch (e) { addActivity('Stop failed: ' + e, 'error'); }
    stop.disabled = false; stop.textContent = 'Stop';
  });
  const clearBtn = $('#btn-clear-logs');
  if (clearBtn) clearBtn.addEventListener('click', () => {
    state.logs = []; lastLogCount = 0; const c = $('#log-container');
    if (c) c.innerHTML = '';
  });
  const trayBtn = $('#btn-toggle-tray');
  if (trayBtn) trayBtn.addEventListener('click', async () => {
    try { await invoke('toggle_window'); } catch (_) {}
  });
  const lc = $('#log-container');
  if (lc) {
    lc.addEventListener('scroll', () => {
      const el = lc;
      const was = window.__logPaused;
      window.__logPaused = el.scrollTop + el.clientHeight < el.scrollHeight - 20;
    });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  // override renderLogs to use __logPaused
  const origRender = renderLogs;
  renderLogs = function() {
    const container = $('#log-container');
    if (!container || !state.logs.length) return;
    if (state.logs.length === lastLogCount) return;
    lastLogCount = state.logs.length;
    const auto = !window.__logPaused || state.logs.length - lastLogCount + 200 > lastLogCount;
    container.innerHTML = state.logs.slice(-200).map(l =>
      `<div class="log-entry ${l.level}">
        <span class="log-time">${esc(l.timestamp)}</span>
        <span class="log-level ${l.level}">${esc(l.level)}</span>
        <span class="log-text">${esc(l.text)}</span>
      </div>`
    ).join('');
    if (auto) container.scrollTop = container.scrollHeight;
  };
});

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

function setupDragDrop() {
  const dropZone = $('#env-drop-zone');
  if (!dropZone) return;

  let dropCounter = 0;

  function showDrop() {
    dropCounter++;
    dropZone.classList.add('drag-over');
  }

  function hideDrop() {
    dropCounter--;
    if (dropCounter <= 0) {
      dropCounter = 0;
      dropZone.classList.remove('drag-over');
    }
  }

  async function handleDrop(paths) {
    dropZone.classList.remove('drag-over');
    dropCounter = 0;
    if (!paths || paths.length === 0) return;
    const file = paths[0];
    const name = file.replace(/^.*[/\\]/, '');
    if (!name.startsWith('.env')) {
      addActivity('Drop only .env files: ' + name, 'error');
      return;
    }
    try {
      const cfg = await invoke('load_custom_env', { path: file });
      applyConfig(cfg);
      addActivity('Dropped: ' + name, 'info');
    } catch (e) {
      addActivity('Load failed: ' + e, 'error');
    }
  }

  // Listen for Tauri drag-drop events (gives real file paths)
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

async function pickEnvAndLoad() {
  showFileBrowser();
}

function showFileBrowser() {
  let overlay = $('#file-browser');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'file-browser';
    overlay.className = 'modal-overlay';
    overlay.style.display = 'none';
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <span class="modal-title">Browse .env file</span>
        <button class="btn btn-ghost btn-sm modal-close">×</button>
      </div>
      <div class="modal-body">
        <div id="browser-toolbar" style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          <button id="browser-up" class="btn btn-sm" title="Parent directory">↑</button>
          <span id="browser-path" style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span>
        </div>
        <div id="browser-list" style="max-height:320px;overflow-y:auto"></div>
      </div>
      <div class="modal-footer" style="display:flex;justify-content:space-between;align-items:center">
        <span style="font-size:10px;color:var(--text-muted)">Hidden files are shown (including .env)</span>
        <button id="browser-cancel" class="btn btn-sm">Cancel</button>
      </div>
    </div>
  `;

  overlay.style.display = 'flex';

  let currentDir = state.config?.source_files?.length
    ? state.config.source_files[0].replace(/\/[^/]*$/, '')
    : null;
  if (!currentDir) {
    // Use project dir — get from list_env_files
    invoke('list_env_files').then(files => {
      if (files && files.length > 0) {
        currentDir = files[0].replace(/\/[^/]*$/, '');
      } else {
        currentDir = '/Users/wica/lq/zalo-tg';
      }
      loadBrowserDir(currentDir);
    }).catch(() => {
      currentDir = '/Users/wica/lq/zalo-tg';
      loadBrowserDir(currentDir);
    });
  } else {
    loadBrowserDir(currentDir);
  }

  overlay.querySelector('.modal-close')?.addEventListener('click', () => { overlay.style.display = 'none'; });
  overlay.querySelector('#browser-cancel')?.addEventListener('click', () => { overlay.style.display = 'none'; });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.style.display = 'none'; });
}

async function loadBrowserDir(dir) {
  const list = $('#browser-list');
  const pathEl = $('#browser-path');
  const upBtn = $('#browser-up');
  if (!list || !pathEl) return;

  pathEl.textContent = dir;

  // Up button
  if (upBtn) {
    const parent = dir.replace(/\/+$/, '').replace(/\/[^/]+$/, '') || '/';
    upBtn.onclick = () => loadBrowserDir(parent);
    upBtn.style.display = parent === '/' || parent === dir ? 'none' : '';
  }

  try {
    const entries = await invoke('scan_dir', { dir });
    list.innerHTML = '';

    // .env files first, then dirs, then other files
    const envFiles = entries.filter(e => !e.is_dir && e.name.startsWith('.env'));
    const dirs = entries.filter(e => e.is_dir);
    const others = entries.filter(e => !e.is_dir && !e.name.startsWith('.env'));

    const allItems = [...envFiles, ...dirs, ...others];
    if (allItems.length === 0) {
      list.innerHTML = '<div class="empty-state">Empty directory</div>';
      return;
    }

    for (const entry of allItems) {
      const item = document.createElement('div');
      item.className = 'browser-item';
      if (entry.is_dir) {
        item.innerHTML = `
          <span style="color:var(--accent-violet);margin-right:6px">📁</span>
          <span style="color:var(--text-primary)">${esc(entry.name)}/</span>
        `;
        item.addEventListener('click', () => loadBrowserDir(entry.path));
        item.style.cursor = 'pointer';
      } else if (entry.name.startsWith('.env')) {
        item.innerHTML = `
          <span style="color:var(--accent);margin-right:6px">📄</span>
          <span style="color:var(--accent);font-weight:500">${esc(entry.name)}</span>
          <span style="margin-left:auto;font-size:10px;color:var(--accent)">Click to load</span>
        `;
        item.addEventListener('click', async () => {
          try {
            const cfg = await invoke('load_custom_env', { path: entry.path });
            applyConfig(cfg);
            addActivity('Loaded: ' + entry.name, 'info');
            $('#file-browser').style.display = 'none';
          } catch (e) {
            addActivity('Load failed: ' + e, 'error');
          }
        });
        item.style.cursor = 'pointer';
      } else {
        item.innerHTML = `
          <span style="color:var(--text-muted);margin-right:6px">📄</span>
          <span style="color:var(--text-muted)">${esc(entry.name)}</span>
        `;
        item.style.opacity = '0.5';
      }
      list.appendChild(item);
    }
  } catch (e) {
    list.innerHTML = '<div class="empty-state" style="color:var(--red)">Error: ' + esc(String(e)) + '</div>';
  }
}

async function loadConfig() {
  try {
    const cfg = await invoke('get_config');
    applyConfig(cfg);
  } catch (_) {}
}

function applyConfig(cfg) {
  state.config = cfg;
  const vars = cfg.vars || {};

  $('#config-path').value = cfg.source_files?.length
    ? cfg.source_files.join(', ')
    : 'No file loaded';

  const src = $('#config-source');
  if (cfg.source_files?.length) {
    const files = cfg.source_files.map(f => f.replace(/^.*[/\\]/, '')).join(' + ');
    src.textContent = 'Loaded from: ' + files;
  } else {
    src.textContent = 'No config file found — add variables below and save';
  }

  renderEnvList(vars);
  listEnvFiles();
}

async function listEnvFiles() {
  try {
    const files = await invoke('list_env_files');
    const container = $('#env-files-list');
    if (!container) return;
    if (!files || files.length === 0) {
      container.innerHTML = '<div style="color:var(--text-muted);padding:4px 0">No .env files found in project directory</div>';
      return;
    }
    const current = state.config?.source_files || [];
    const currentNames = current.map(f => f.replace(/^.*[/\\]/, ''));
    let html = '<div style="display:flex;flex-direction:column;gap:2px">';
    for (const f of files) {
      const name = f.replace(/^.*[/\\]/, '');
      const active = currentNames.includes(name);
      html += `<button class="env-file-btn ${active ? 'active' : ''}" data-path="${esc(f)}" style="display:flex;align-items:center;gap:8px;padding:4px 8px;border-radius:4px;border:none;background:${active ? 'var(--accent-dim)' : 'transparent'};color:${active ? 'var(--accent)' : 'var(--text-secondary)'};cursor:pointer;font-size:12px;font-family:var(--font-mono);text-align:left;width:100%">
        <span>📄</span>
        <span style="flex:1">${esc(name)}</span>
        ${active ? '<span style="font-size:10px;color:var(--accent)">active</span>' : '<span style="font-size:10px;color:var(--text-muted)">click to load</span>'}
      </button>`;
    }
    html += '</div>';
    container.innerHTML = html;

    container.querySelectorAll('.env-file-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const path = btn.dataset.path;
        try {
          const cfg = await invoke('load_custom_env', { path });
          applyConfig(cfg);
          addActivity('Loaded: ' + path.replace(/^.*[/\\]/, ''), 'info');
        } catch (e) {
          addActivity('Load failed: ' + e, 'error');
        }
      });
    });
  } catch (_) {}
}

function renderEnvList(vars) {
  const list = $('#env-list');
  if (!list) return;
  const keys = Object.keys(vars).sort();
  if (keys.length === 0) {
    list.innerHTML = '<div class="empty-state" style="padding:12px 0">No variables yet. Click "+ Add" to add one.</div>';
    return;
  }
  list.innerHTML = keys.map(k => envRowHTML(k, vars[k])).join('');

  // Wire up remove buttons
  list.querySelectorAll('.env-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.key;
      delete state.config.vars[key];
      renderEnvList(state.config.vars);
    });
  });

  // Wire up input changes
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
  list.querySelectorAll('.env-val').forEach(inp => {
    inp.addEventListener('change', () => {
      const key = inp.dataset.key;
      state.config.vars[key] = inp.value;
    });
  });
}

function envRowHTML(key, val) {
  const masked = /token|secret|password|key|auth/i.test(key);
  const displayVal = masked && val ? '••••••••' : val || '';
  return `<div class="env-row" style="display:flex;align-items:center;gap:8px;padding:4px 0">
    <input type="text" class="input mono env-key" style="width:200px;flex-shrink:0" value="${esc(key)}" data-orig-key="${esc(key)}" placeholder="KEY" />
    <span style="color:var(--text-muted)">=</span>
    <input type="${masked ? 'password' : 'text'}" class="input mono env-val" style="flex:1;min-width:0" value="${esc(displayVal)}" data-key="${esc(key)}" placeholder="value" />
    <button class="btn btn-ghost btn-sm env-remove" data-key="${esc(key)}" title="Remove" style="color:var(--red)">×</button>
  </div>`;
}

function addEnvRow() {
  if (!state.config) state.config = { vars: {} };
  if (!state.config.vars) state.config.vars = {};
  const key = 'NEW_KEY_' + Date.now();
  state.config.vars[key] = '';
  renderEnvList(state.config.vars);
  // Focus the new key input
  const list = $('#env-list');
  const lastInput = list?.querySelector('.env-key:last-of-type');
  if (lastInput) setTimeout(() => lastInput.focus(), 50);
}

async function resetToDefaultEnv() {
  try {
    const cfg = await invoke('get_config');
    applyConfig(cfg);
    addActivity('Reset to default config', 'info');
  } catch (e) {
    addActivity('Reset failed: ' + e, 'error');
  }
}

async function saveSettings() {
  if (!state.config?.vars) return;
  try {
    await invoke('save_config', { vars: state.config.vars });
    addActivity('Settings saved', 'info');
  } catch (e) {
    addActivity('Save failed: ' + e, 'error');
  }
}

function fmtUptime(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h > 0) return h + 'h ' + m + 'm';
  if (m > 0) return m + 'm ' + sec + 's';
  return sec + 's';
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function trunc(str, n) {
  return str.length > n ? str.slice(0, n) + '…' : str;
}

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(resizeChart, 100);
});
