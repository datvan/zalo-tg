import { spawn, execFileSync } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { existsSync, readFileSync, appendFileSync, mkdirSync, writeFileSync, unlinkSync, createWriteStream } from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd());
const dataDir = path.join(root, 'data');
const logDir = path.join(root, 'logs');
const healthPath = path.join(dataDir, 'health.json');
const supervisorLog = path.join(logDir, 'zalo-tg-supervisor.log');
const pidFile = path.join(dataDir, 'zalo-tg-supervisor.pid');
const node = process.execPath;
const maxHealthAgeMs = Number(process.env.SUPERVISOR_MAX_HEALTH_AGE_MS || 3 * 60_000);
const maxJobAgeMs = Number(process.env.SUPERVISOR_MAX_JOB_AGE_MS || 5 * 60_000);
const minRestartGapMs = Number(process.env.SUPERVISOR_MIN_RESTART_GAP_MS || 60_000);
const maxNoZaloEventMs = Number(process.env.SUPERVISOR_MAX_NO_ZALO_EVENT_MS || 15 * 60_000);

mkdirSync(dataDir, { recursive: true });
mkdirSync(logDir, { recursive: true });

let child;
let lastRestart = 0;
let stopping = false;

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  appendFileSync(supervisorLog, line, 'utf8');
  console.log(line.trim());
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function acquireSupervisorLock() {
  if (existsSync(pidFile)) {
    const oldPid = Number(readFileSync(pidFile, 'utf8').trim());
    if (isPidAlive(oldPid)) {
      log(`LOCK active supervisor pid=${oldPid}; exiting pid=${process.pid}`);
      process.exit(0);
    }
    log(`LOCK stale supervisor pid=${oldPid || 'invalid'}; taking over`);
  }
  writeFileSync(pidFile, String(process.pid), 'utf8');
  process.on('exit', () => {
    try {
      if (existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() === String(process.pid)) unlinkSync(pidFile);
    } catch {}
  });
}

function listBridgeChildren() {
  if (process.platform !== 'win32') return [];
  try {
    const ps = `Get-CimInstance Win32_Process | ? { $_.CommandLine -match 'dist/index.js' -and $_.CommandLine -match [regex]::Escape('${root.replace(/'/g, "''")}') } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`;
    const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true }).trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (err) {
    log(`WARN duplicate scan failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function killProcess(pid, reason) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return;
  try {
    if (process.platform === 'win32') execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else process.kill(pid, 'SIGKILL');
    log(`KILL duplicate pid=${pid}: ${reason}`);
  } catch (err) {
    log(`WARN kill pid=${pid} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function killDuplicateChildren() {
  for (const p of listBridgeChildren()) {
    const pid = Number(p.ProcessId ?? p.processId ?? p.pid);
    if (child?.pid && pid === child.pid) continue;
    killProcess(pid, 'pre-spawn single-child guard');
  }
}

function start(reason = 'start') {
  lastRestart = Date.now();
  killDuplicateChildren();
  log(`START child: ${reason}`);
  const childLog = path.join(logDir, 'zalo-tg-child.log');
  const outFd = openSync(childLog, 'a');
  child = spawn(node, ['dist/index.js'], {
    cwd: root,
    windowsHide: true,
    stdio: ['ignore', outFd, outFd],
    env: process.env,
  });
  child.on('exit', () => { try { closeSync(outFd); } catch {} });
  log(`child pid=${child.pid}`);
  child.on('exit', (code, signal) => {
    log(`child exit code=${code} signal=${signal}`);
    child = undefined;
    if (!stopping) setTimeout(() => start('child exited'), 3000).unref();
  });
}

function stopChild() {
  if (!child || child.killed) return;
  try { child.kill('SIGTERM'); } catch {}
  setTimeout(() => { try { if (child && !child.killed) child.kill('SIGKILL'); } catch {} }, 10_000).unref();
}

function restart(reason) {
  if (Date.now() - lastRestart < minRestartGapMs) return log(`SKIP restart cooldown: ${reason}`);
  log(`RESTART child: ${reason}`);
  stopChild();
  setTimeout(() => { if (!child) start(reason); }, 12_000).unref();
}

function checkDuplicateChildren() {
  const children = listBridgeChildren();
  for (const p of children) {
    const pid = Number(p.ProcessId ?? p.processId ?? p.pid);
    if (child?.pid && pid === child.pid) continue;
    killProcess(pid, 'periodic single-child guard');
  }
}

function check() {
  checkDuplicateChildren();
  if (!child) return;
  if (!existsSync(healthPath)) return restart('health missing');
  let h;
  try { h = JSON.parse(readFileSync(healthPath, 'utf8')); }
  catch { return restart('health invalid'); }
  const updatedAge = Date.now() - Date.parse(h.updatedAt || 0);
  if (!Number.isFinite(updatedAge) || updatedAge > maxHealthAgeMs) return restart(`health stale ${Math.round(updatedAge / 1000)}s`);
  if (h.zaloStartedAt && !h.lastZaloEventAt) {
    const noEventAge = Date.now() - Date.parse(h.zaloStartedAt);
    if (Number.isFinite(noEventAge) && noEventAge > maxNoZaloEventMs) return restart(`zalo listener no events s`);
  }
  if (h.zaloStartedAt && h.lastZaloEventAt) {
    const eventAge = Date.now() - Date.parse(h.lastZaloEventAt);
    if (Number.isFinite(eventAge) && eventAge > 6 * 60 * 60_000) log(`WARN last Zalo event stale s`);
  }
  if (h.queueRunning && h.currentJobStartedAt) {
    const jobAge = Date.now() - Date.parse(h.currentJobStartedAt);
    if (Number.isFinite(jobAge) && jobAge > maxJobAgeMs) return restart(`job stuck ${Math.round(jobAge / 1000)}s: ${h.currentJob || 'unknown'}`);
  }
  log(`OK child=${child.pid} status=${h.status} queue=${h.queueRunning ? 'running' : 'idle'} len=${h.queueLength || 0}`);
}

process.on('SIGINT', () => { stopping = true; stopChild(); process.exit(0); });
process.on('SIGTERM', () => { stopping = true; stopChild(); process.exit(0); });

acquireSupervisorLock();
start('supervisor boot');
setInterval(check, 60_000);




