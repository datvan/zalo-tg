import 'dotenv/config';

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

function parseAdminUserIds(raw: string): number[] {
  const ids = raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => Number(s));
  if (ids.length === 0 || ids.some(id => !Number.isSafeInteger(id))) {
    throw new Error('ADMIN_USER_IDS must be a comma-separated list of Telegram numeric user IDs');
  }
  return ids;
}

export const config = {
  telegram: {
    token:        requireEnv('TG_TOKEN'),
    groupId:      Number(requireEnv('TG_GROUP_ID')),
    adminUserIds: parseAdminUserIds(requireEnv('ADMIN_USER_IDS')),
  },
  zalo: {
    credentialsPath: process.env.ZALO_CREDENTIALS_PATH ?? './credentials.json',
  },
  dataDir: process.env.DATA_DIR ?? './data',
} as const;
