import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, 'data');
const logPath = path.join(dataDir, 'watchdog-pm2.log');
const healthPath = path.join(dataDir, 'health.json');
const app = process.env.ZALO_TG_PM2_APP || 'zalo-tg';
const maxHealthAgeMs = Number(process.env.WATCHDOG_MAX_HEALTH_AGE_MS || 3 * 60_000);
const maxJobAgeMs = Number(process.env.WATCHDOG_MAX_JOB_AGE_MS || 5 * 60_000);
const minRestartGapMs = Number(process.env.WATCHDOG_MIN_RESTART_GAP_MS || 2 * 60_000);
const maxZaloEventAgeMs = Number(process.env.WATCHDOG_MAX_ZALO_EVENT_AGE_MS || 3 * 60 * 60_000);
const minZaloRuntimeBeforeStaleMs = Number(process.env.WATCHDOG_MIN_ZALO_RUNTIME_BEFORE_STALE_MS || 30 * 60_000);
const maxTgActiveAgeMs = Number(process.env.WATCHDOG_MAX_TG_ACTIVE_AGE_MS || 30 * 60_000);
const maxBidirectionalSilenceMs = Number(process.env.WATCHDOG_MAX_BIDIRECTIONAL_SILENCE_MS || 3 * 60 * 60_000);
const maxTrafficSilenceMs = Number(process.env.WATCHDOG_MAX_TRAFFIC_SILENCE_MS || 3 * 60 * 60_000);
const activeStartHour = Number(process.env.WATCHDOG_ACTIVE_START_HOUR || 8);
const activeEndHour = Number(process.env.WATCHDOG_ACTIVE_END_HOUR || 23);
const markerPath = path.join(dataDir, 'watchdog-pm2-last-restart.txt');
const pm2Script = path.join(path.dirname(process.execPath), 'node_modules', 'pm2', 'bin', 'pm2');

mkdirSync(dataDir, { recursive: true });

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  appendFileSync(logPath, line, 'utf8');
  console.log(line.trim());
}

function pm2(args) {
  return execFileSync(process.execPath, [pm2Script, ...args], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

function getPm2App() {
  const raw = pm2(['jlist']);
  const match = raw.match(/\[.*\]/s);
  const list = match ? JSON.parse(match[0]) : [];
  return list.find(p => p?.name === app);
}

function ageMs(ts) {
  if (!ts) return Infinity;
  const t = Date.parse(ts);
  return Number.isFinite(t) ? Date.now() - t : Infinity;
}

function sec(ms) {
  return Number.isFinite(ms) ? `${Math.round(ms / 1000)}s` : 'missing';
}

function inCooldown() {
  try {
    const ts = Number(readFileSync(markerPath, 'utf8'));
    return Number.isFinite(ts) && Date.now() - ts < minRestartGapMs;
  } catch { return false; }
}

function markRestart() {
  writeFileSync(markerPath, String(Date.now()), 'utf8');
}

function restart(reason) {
  if (inCooldown()) return log(`SKIP restart cooldown reason=${reason}`);
  log(`RESTART ${app}: ${reason}`);
  try {
    pm2(['restart', app]);
    markRestart();
    log('RESTART OK');
  } catch (err) {
    log(`RESTART FAILED: ${err?.message || err}`);
    process.exitCode = 2;
  }
}

let proc;
try { proc = getPm2App(); }
catch (err) { log(`PM2 jlist failed: ${err?.message || err}`); process.exit(2); }

if (!proc) {
  log(`PM2 app missing: ${app}; trying start via pm2 start dist/index.js --name ${app}`);
  try { pm2(['start', 'dist/index.js', '--name', app]); markRestart(); log('START OK'); } catch (err) { log(`START FAILED: ${err?.message || err}`); process.exitCode = 2; }
  process.exit();
}

if (proc.pm2_env?.status !== 'online') {
  restart(`pm2 status=${proc.pm2_env?.status || 'unknown'}`);
  process.exit();
}

if (!existsSync(healthPath)) {
  restart('health.json missing');
  process.exit();
}

let h;
try { h = JSON.parse(readFileSync(healthPath, 'utf8')); }
catch { restart('health.json invalid'); process.exit(); }

const updatedAge = ageMs(h.updatedAt);
if (!Number.isFinite(updatedAge) || updatedAge > maxHealthAgeMs) {
  restart(`health stale ${sec(updatedAge)}`);
  process.exit();
}

const zaloStartedAge = ageMs(h.zaloStartedAt || h.startedAt);
const zaloEventAge = ageMs(h.lastZaloEventAt || h.lastZaloToTgSuccessAt);
const tgActiveAge = Math.min(ageMs(h.lastTelegramUpdateAt), ageMs(h.lastTgToZaloSuccessAt));
const trafficAge = ageMs(h.lastTrafficAt || h.lastZaloEventAt || h.lastTelegramUpdateAt || h.lastTgToZaloSuccessAt || h.lastZaloToTgSuccessAt);
const hasZaloEverWorked = !!(h.lastZaloEventAt || h.lastZaloToTgSuccessAt);
const tgSideActive = Number.isFinite(tgActiveAge) && tgActiveAge <= maxTgActiveAgeMs;
const hasTelegramEverWorked = !!(h.lastTelegramUpdateAt || h.lastTgToZaloSuccessAt);
const localHour = new Date().getHours();
const inActiveHours = activeStartHour <= activeEndHour ? (localHour >= activeStartHour && localHour <= activeEndHour) : (localHour >= activeStartHour || localHour <= activeEndHour);
const bothDirectionsSilent = hasTelegramEverWorked && hasZaloEverWorked && tgActiveAge > maxBidirectionalSilenceMs && zaloEventAge > maxBidirectionalSilenceMs;
const zaloWarmEnough = Number.isFinite(zaloStartedAge) && zaloStartedAge >= minZaloRuntimeBeforeStaleMs;

if (zaloWarmEnough && inActiveHours && bothDirectionsSilent) {
  restart(`bidirectional-half-dead tgActiveAge=${sec(tgActiveAge)} zaloEventAge=${sec(zaloEventAge)} healthAge=${sec(updatedAge)} activeHour=${localHour}`);
  process.exit();
}

if (zaloWarmEnough && inActiveHours && trafficAge > maxTrafficSilenceMs) {
  restart(`bridge-traffic-stale trafficAge=${sec(trafficAge)} healthAge=${sec(updatedAge)} activeHour=${localHour}`);
  process.exit();
}

if (hasZaloEverWorked && zaloWarmEnough && tgSideActive && zaloEventAge > maxZaloEventAgeMs) {
  restart(`zalo-listener-stale zaloEventAge=${sec(zaloEventAge)} tgActiveAge=${sec(tgActiveAge)} startedAge=${sec(zaloStartedAge)}`);
  process.exit();
}

if (h.queueRunning && h.currentJobStartedAt) {
  const jobAge = ageMs(h.currentJobStartedAt);
  if (Number.isFinite(jobAge) && jobAge > maxJobAgeMs) {
    restart(`queue stuck ${sec(jobAge)} job=${h.currentJob || 'unknown'} len=${h.queueLength || 0}`);
    process.exit();
  }
}

log(`OK pm2=online pid=${proc.pid} healthAge=${sec(updatedAge)} trafficAge=${sec(trafficAge)} tgActiveAge=${sec(tgActiveAge)} zaloEventAge=${sec(zaloEventAge)} queue=${h.queueRunning ? 'running' : 'idle'} len=${h.queueLength || 0}`);
