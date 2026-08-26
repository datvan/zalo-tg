import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  mkdtempSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';

const dirCache = new Map<string, string>();

function sanitizePathSegment(value: string, fallback: string): string {
  const cleaned = value
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return cleaned || fallback;
}

function currentUserToken(): string {
  if (typeof process.getuid === 'function') return String(process.getuid());
  try {
    return sanitizePathSegment(os.userInfo().username, 'user');
  } catch {
    return 'user';
  }
}

function sharedDirMode(): number {
  // Local Bot API runs in another process/container and must be able to read
  // file:// uploads by absolute path. Official api.telegram.org only needs the
  // bridge process to read its own temp files, so keep those directories private.
  return config.telegram.localServer ? 0o755 : 0o700;
}

function sharedFileMode(): number {
  return config.telegram.localServer ? 0o644 : 0o600;
}

function verifyWritableDirectory(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true, mode: sharedDirMode() });
    try { chmodSync(dir, sharedDirMode()); } catch { /* best-effort on POSIX only */ }
    accessSync(dir, constants.W_OK | constants.X_OK);

    const probe = path.join(
      dir,
      `.zalo-tg-write-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    writeFileSync(probe, '', { mode: sharedFileMode() });
    unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

/**
 * Root for files that may need to be visible to both the bridge and a local
 * Telegram Bot API server. Override with ZALO_TG_SHARED_TMP_ROOT when Docker
 * mounts a different shared path into both containers.
 */
export function getSharedTempRoot(): string {
  const override = process.env.ZALO_TG_SHARED_TMP_ROOT?.trim();
  if (override) return path.resolve(override);

  // In local mode the Bot API server reads file:// paths from its own
  // filesystem namespace. The project mounts /tmp into both containers/processes.
  if (config.telegram.localServer && process.platform !== 'win32') return '/tmp';

  return os.tmpdir();
}

/**
 * Return a writable, Bot-API-readable temp directory for a namespace.
 *
 * Older releases used fixed paths such as /tmp/zalo-tg/zalo-qr.png. In Docker,
 * those paths can be left behind as root-owned files/directories by a previous
 * run or by the host bind mount, causing EACCES for the non-root runtime user.
 * This resolver first tries the stable path, then falls back to a user-scoped
 * and finally a unique directory under the same shared root.
 */
export function getSharedTempDir(namespace = 'zalo-tg'): string {
  const root = getSharedTempRoot();
  const safeNamespace = sanitizePathSegment(namespace, 'zalo-tg');
  const cacheKey = `${root}\0${safeNamespace}\0${config.telegram.localServer ? 'local' : 'remote'}`;
  const cached = dirCache.get(cacheKey);
  if (cached && verifyWritableDirectory(cached)) return cached;

  const candidates = [
    path.join(root, safeNamespace),
    path.join(root, `${safeNamespace}-${currentUserToken()}`),
  ];

  for (const candidate of candidates) {
    if (verifyWritableDirectory(candidate)) {
      dirCache.set(cacheKey, candidate);
      return candidate;
    }
  }

  try {
    const uniqueDir = mkdtempSync(path.join(root, `${safeNamespace}-${currentUserToken()}-`));
    if (verifyWritableDirectory(uniqueDir)) {
      dirCache.set(cacheKey, uniqueDir);
      return uniqueDir;
    }
  } catch { /* fall through to explicit error below */ }

  throw new Error(
    `Cannot create a writable shared temp directory under ${root}. `
    + 'Check Docker volume permissions or set ZALO_TG_SHARED_TMP_ROOT to a writable path mounted into both containers.',
  );
}

export function createSharedTempPath(namespace: string, prefix: string, extension: string): string {
  const safePrefix = sanitizePathSegment(prefix, 'file');
  const safeExtension = extension
    ? `.${extension.replace(/^\.+/, '').replace(/[^a-zA-Z0-9]+/g, '').slice(0, 16)}`
    : '';
  return path.join(
    getSharedTempDir(namespace),
    `${safePrefix}-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 9)}${safeExtension}`,
  );
}

export function prepareSharedTempFile(filePath: string): void {
  try { chmodSync(filePath, sharedFileMode()); } catch { /* Windows/non-POSIX FS */ }
}
