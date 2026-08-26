import 'dotenv/config';
import path from 'path';
import { PROJECT_ROOT } from './utils/paths.js';

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

function requireTelegramGroupId(): number {
  const raw = requireEnv('TG_GROUP_ID');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value >= 0) {
    throw new Error('TG_GROUP_ID must be a negative safe integer (Telegram supergroup ID)');
  }
  return value;
}

function resolvePath(envVal: string | undefined, defaultRelative: string): string {
  const raw = envVal ?? defaultRelative;
  // Already absolute → use as-is, otherwise resolve from project root
  return path.isAbsolute(raw) ? raw : path.resolve(PROJECT_ROOT, raw);
}

function envFlag(key: string, defaultValue = false): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/**
 * Parse ZALO_EXCLUDE_THREADS: comma-separated "type:id" pairs or bare ids.
 * type: 0 = DM, 1 = group. Bare ids are treated as groups ("1:id").
 * Returns a record keyed by "type:id" so it survives JSON serialization.
 */
function excludeThreads(): Record<string, true> {
  const raw = process.env.ZALO_EXCLUDE_THREADS?.trim() ?? '';
  const out: Record<string, true> = {};
  if (!raw) return out;
  for (const part of raw.split(',')) {
    const item = part.trim();
    if (!item) continue;
    const m = item.match(/^(\d):(.+)$/);
    if (m && (m[1] === '0' || m[1] === '1')) {
      out[`${m[1]}:${m[2]}`] = true;
    } else {
      out[`1:${item}`] = true;
    }
  }
  return out;
}


function localBotApiServer(): string | null {
  if (!envFlag('LOCAL_BOT_API')) return null;
  const raw = requireEnv('TG_LOCAL_SERVER').replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('TG_LOCAL_SERVER must be a valid http(s) URL when LOCAL_BOT_API is enabled');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('TG_LOCAL_SERVER must use http or https');
  }
  return raw;
}

export const config = {
  telegram: {
    token:       requireEnv('TG_TOKEN'),
    groupId:     requireTelegramGroupId(),
    adminUserIds: (process.env.ADMIN_USER_IDS ?? '').split(',').map(s => Number(s.trim())).filter(Number.isSafeInteger),
    localServer: localBotApiServer(),
  },
  zalo: {
    credentialsPath: resolvePath(process.env.ZALO_CREDENTIALS_PATH, 'credentials.json'),
    skipMutedGroups: envFlag('ZALO_SKIP_MUTED_GROUPS'),
    muteSilentMirror: envFlag('ZALO_MUTE_SILENT', true),
    dmNativeReaction: envFlag('ZALO_DM_NATIVE_REACTION', true),
    excludeThreads: excludeThreads(),
  },
  dataDir: resolvePath(process.env.DATA_DIR, 'data'),
} as const;
