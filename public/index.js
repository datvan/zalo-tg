const { invoke } = window.__TAURI__?.core ?? {};

function $(sel) { return document.querySelector(sel); }
function $$(sel) { return document.querySelectorAll(sel); }

let pollInterval = null;
let logsPaused = false;

// ── Initialization ──
document.addEventListener("DOMContentLoaded", async () => {
  if (!window.__TAURI__) {
    showError("Not running inside Tauri. Open this with `npm run tauri:dev`.");
    return;
  }
  await loadConfig();
  await pollStatus();
  pollInterval = setInterval(pollStatus, 2000);
  setupEventListeners();
});

function setupEventListeners() {
  $("#btn-start").addEventListener("click", startBridge);
  $("#btn-stop").addEventListener("click", stopBridge);
  $("#btn-edit-env").addEventListener("click", openEnvFile);

  // Auto-scroll logs unless user scrolled up
  const logContainer = $("#log-container");
  logContainer.addEventListener("scroll", () => {
    const el = logContainer;
    logsPaused = el.scrollTop + el.clientHeight < el.scrollHeight - 20;
  });
}

// ── Status Polling ──
async function pollStatus() {
  try {
    const status = await invoke("get_bridge_status");
    const logs = await invoke("get_logs", { limit: 200 });
    updateStatus(status);
    renderLogs(logs);
  } catch (e) {
    console.error("poll error:", e);
  }
}

function updateStatus(status) {
  const badge = $("#status-badge");
  const statBridge = $("#stat-bridge");
  const statPid = $("#stat-pid");
  const statUptime = $("#stat-uptime");
  const statLogs = $("#stat-logs");

  badge.textContent = status.running ? "● Running" : "● Stopped";
  badge.className = "badge " + (status.running ? "running" : "stopped");

  statBridge.textContent = status.running ? "● Running" : "● Stopped";
  statBridge.className = "stat-value " + (status.running ? "running" : "stopped");

  statPid.textContent = status.pid ?? "—";
  statUptime.textContent = status.running && status.uptime_secs != null
    ? formatUptime(status.uptime_secs)
    : "—";
  statLogs.textContent = String(status.log_count);
}

function formatUptime(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// ── Logs ──
let lastLogCount = 0;

function renderLogs(logs) {
  const container = $("#log-container");
  if (!logs || logs.length === 0) return;

  const autoScroll = !logsPaused || logs.length !== lastLogCount;

  // Only re-render if new logs arrived
  if (logs.length === lastLogCount) return;
  lastLogCount = logs.length;

  let html = "";
  for (const entry of logs.slice(-200)) {
    html += `<div class="log-entry ${entry.level}">
      <span class="log-time">${escapeHtml(entry.timestamp)}</span>
      <span class="log-level ${entry.level}">${escapeHtml(entry.level)}</span>
      <span class="log-text">${escapeHtml(entry.text)}</span>
    </div>`;
  }
  container.innerHTML = html;

  if (autoScroll) {
    container.scrollTop = container.scrollHeight;
  }
}

// ── Config ──
async function loadConfig() {
  try {
    const cfg = await invoke("get_config");
    renderConfig(cfg);
  } catch (e) {
    console.error("load config error:", e);
  }
}

function renderConfig(cfg) {
  const list = $("#config-list");
  let html = "";
  for (const key of cfg.editable_keys) {
    const val = cfg.vars[key] ?? "(not set)";
    const masked = key.includes("TOKEN") || key.includes("SECRET");
    html += `<div class="config-item">
      <span class="config-key">${escapeHtml(key)}</span>
      <span class="config-val ${masked ? "masked" : ""}">${masked ? "••••••••" : escapeHtml(val)}</span>
    </div>`;
  }
  list.innerHTML = html;
}

// ── Actions ──
async function startBridge() {
  try {
    await invoke("start_bridge");
    await pollStatus();
  } catch (e) {
    showError("Start failed: " + e);
  }
}

async function stopBridge() {
  try {
    await invoke("stop_bridge");
    await pollStatus();
  } catch (e) {
    showError("Stop failed: " + e);
  }
}

async function openEnvFile() {
  try {
    await invoke("open_env_file");
  } catch (e) {
    showError("Open .env failed: " + e);
  }
}

// ── Helpers ──
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function showError(msg) {
  console.error(msg);
}
