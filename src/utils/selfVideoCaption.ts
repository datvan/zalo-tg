import { copyFileSync, existsSync, unlinkSync } from 'fs';
import path from 'path';

const pendingSelfVideoCaptions = new Map<string, string>();
const pendingSelfVideoFallbacks = new Map<string, { localPath: string; caption: string; timer: NodeJS.Timeout }>();

function msgIdFromResult(result: unknown): string | undefined {
  const msgId = (result as { msgId?: unknown })?.msgId;
  return msgId == null ? undefined : String(msgId);
}

function removeFileQuietly(localPath: string): void {
  try {
    if (existsSync(localPath)) unlinkSync(localPath);
  } catch { /* ignore cleanup failure */ }
}

export function rememberSelfVideoCaption(result: unknown, caption: string): void {
  const msgId = msgIdFromResult(result);
  if (msgId) pendingSelfVideoCaptions.set(msgId, caption);
}

export function hasSelfVideoCaption(msgId: string): boolean {
  return pendingSelfVideoCaptions.has(msgId);
}

export function takeSelfVideoCaption(msgId: string): string | undefined {
  const caption = pendingSelfVideoCaptions.get(msgId);
  if (caption) pendingSelfVideoCaptions.delete(msgId);
  return caption;
}

export function rememberSelfVideoFallback(result: unknown, localPath: string, caption: string, ttlMs = 180_000): void {
  const msgId = msgIdFromResult(result);
  if (!msgId || !existsSync(localPath)) return;
  dropSelfVideoFallback(msgId);
  const parsed = path.parse(localPath);
  const fallbackPath = path.join(parsed.dir, `${parsed.name}_selfmirror_${msgId.replace(/[^\w.-]/g, '_')}${parsed.ext || '.mp4'}`);
  copyFileSync(localPath, fallbackPath);
  const timer = setTimeout(() => dropSelfVideoFallback(msgId), ttlMs);
  pendingSelfVideoFallbacks.set(msgId, { localPath: fallbackPath, caption, timer });
}

export function takeSelfVideoFallback(msgId: string): { localPath: string; caption: string } | undefined {
  const fallback = pendingSelfVideoFallbacks.get(msgId);
  if (!fallback) return undefined;
  pendingSelfVideoFallbacks.delete(msgId);
  clearTimeout(fallback.timer);
  return { localPath: fallback.localPath, caption: fallback.caption };
}

export function dropSelfVideoFallback(msgId: string): void {
  const fallback = pendingSelfVideoFallbacks.get(msgId);
  if (!fallback) return;
  pendingSelfVideoFallbacks.delete(msgId);
  clearTimeout(fallback.timer);
  removeFileQuietly(fallback.localPath);
}
