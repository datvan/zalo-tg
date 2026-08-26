import { existsSync, mkdirSync, writeFileSync, readFileSync, renameSync, unlinkSync } from 'fs';
import path from 'path';

export type HealthStatus = 'starting' | 'ok' | 'error' | 'stopping';

export interface BridgeHealth {
  pid: number;
  startedAt: string;
  updatedAt: string;
  status: HealthStatus;
  telegramStartedAt?: string;
  zaloStartedAt?: string;
  lastTelegramUpdateAt?: string;
  lastZaloEventAt?: string;
  lastTgToZaloSuccessAt?: string;
  lastZaloToTgSuccessAt?: string;
  lastTrafficAt?: string;
  queueRunning: boolean;
  queueLength: number;
  currentJob?: string;
  currentJobStartedAt?: string;
  lastError?: string;
  fbSessionOk?: boolean;
  fbSessionCheckedAt?: string;
  fbSessionError?: string;
  ytDlpOk?: boolean;
  ytDlpCheckedAt?: string;
  ytDlpError?: string;
  ytDlpVersion?: string;
}

const dataDir = path.resolve(process.cwd(), 'data');
export const healthPath = path.join(dataDir, 'health.json');

let state: BridgeHealth = {
  pid: process.pid,
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  status: 'starting',
  queueRunning: false,
  queueLength: 0,
};

function persist(): void {
  try {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    state.updatedAt = new Date().toISOString();
    const tmp = `${healthPath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    try {
      renameSync(tmp, healthPath);
    } catch (renameErr) {
      // Windows may briefly lock health.json (AV/indexer/supervisor read). Fall back to direct write;
      // health is best-effort and should never crash/restart the bridge.
      try { writeFileSync(healthPath, JSON.stringify(state, null, 2), 'utf8'); } finally {
        try { unlinkSync(tmp); } catch {}
      }
    }
  } catch (err) {
    console.warn('[Health] write failed:', err);
  }
}

export function markHealth(patch: Partial<BridgeHealth>): void {
  const lastTrafficAt = patch.lastTrafficAt
    ?? patch.lastTelegramUpdateAt
    ?? patch.lastZaloEventAt
    ?? patch.lastTgToZaloSuccessAt
    ?? patch.lastZaloToTgSuccessAt;
  if (lastTrafficAt) patch = { ...patch, lastTrafficAt };
  state = { ...state, ...patch, pid: process.pid };
  persist();
}

export function markError(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  markHealth({ status: 'error', lastError: msg.slice(0, 1000) });
}

export function getHealth(): BridgeHealth {
  return { ...state };
}

export function readHealthFile(): BridgeHealth | undefined {
  try {
    return JSON.parse(readFileSync(healthPath, 'utf8')) as BridgeHealth;
  } catch {
    return undefined;
  }
}

markHealth({ status: 'starting' });
setInterval(() => markHealth({}), 60_000).unref();
