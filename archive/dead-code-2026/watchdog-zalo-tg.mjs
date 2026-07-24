import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd());
const dataDir = path.join(root, 'data');
const healthPath = path.join(dataDir, 'health.json');
const logPath = path.join(dataDir, 'watchdog.log');
const serviceName = process.env.ZALO_TG_SERVICE || 'zalo-tg';
const maxHealthAgeMs = Number(process.env.WATCHDOG_MAX_HEALTH_AGE_MS || 3 * 60_000);
const maxJobAgeMs = Number(process.env.WATCHDOG_MAX_JOB_AGE_MS || 20 * 60_000);
const minRestartGapMs = Number(process.env.WATCHDOG_MIN_RESTART_GAP_MS || 10 * 60_000);

function log(msg) {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const line = `${new Date().toISOString()} ${msg}\n`;
  appendFileSync(logPath, line, 'utf8');
  console.log(line.trim());
}

function ps(args) {
  return execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', args], { encoding: 'utf8' }).trim();
}

function serviceStatus() {
  try { return ps(`(Get-Service -Name '${serviceName}' -ErrorAction Stop).Status`); }
  catch { return 'Missing'; }
}

function recentlyRestarted() {
  const marker = path.join(dataDir, 'watchdog-last-restart.txt');
  try {
    const ts = Number(readFileSync(marker, 'utf8'));
    return Date.now() - ts < minRestartGapMs;
  } catch { return false; }
}

function markRestart() {
  const marker = path.join(dataDir, 'watchdog-last-restart.txt');
  appendFileSync(marker, String(Date.now()), { flag: 'w' });
}

function restart(reason) {
  if (recentlyRestarted()) { log(`SKIP restart: cooldown active; reason=${reason}`); return; }
  log(`RESTART ${serviceName}: ${reason}`);
  try {
    ps(`Restart-Service -Name '${serviceName}' -Force -ErrorAction Stop`);
    markRestart();
    log(`RESTART OK`);
  } catch (err) {
    log(`RESTART FAILED: ${err.message || err}`);
    process.exitCode = 2;
  }
}

const status = serviceStatus();
if (status !== 'Running') {
  log(`service status=${status}; starting`);
  try { ps(`Start-Service -Name '${serviceName}' -ErrorAction Stop`); markRestart(); log('START OK'); }
  catch (err) { log(`START FAILED: ${err.message || err}`); process.exitCode = 2; }
  process.exit();
}

if (!existsSync(healthPath)) {
  restart('health.json missing');
  process.exit();
}

let h;
try { h = JSON.parse(readFileSync(healthPath, 'utf8')); }
catch { restart('health.json invalid'); process.exit(); }

const updatedAge = Date.now() - Date.parse(h.updatedAt || 0);
if (!Number.isFinite(updatedAge) || updatedAge > maxHealthAgeMs) {
  restart(`health stale ${Math.round(updatedAge / 1000)}s`);
  process.exit();
}

if (h.queueRunning && h.currentJobStartedAt) {
  const jobAge = Date.now() - Date.parse(h.currentJobStartedAt);
  if (Number.isFinite(jobAge) && jobAge > maxJobAgeMs) {
    restart(`queue job stuck ${Math.round(jobAge / 1000)}s: ${h.currentJob || 'unknown'}`);
    process.exit();
  }
}

log(`OK status=${h.status} queue=${h.queueRunning ? 'running' : 'idle'} len=${h.queueLength || 0}`);
