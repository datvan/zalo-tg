import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Write authentication/session material with owner-only permissions where the
 * platform supports POSIX file modes. `mode` protects newly-created files;
 * chmod also tightens permissions on files created by older releases.
 */
export function writePrivateTextFileSync(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Windows and some network filesystems do not implement POSIX chmod. The
    // write still succeeds and platform ACLs remain authoritative there.
  }
}

export function writePrivateJsonFileSync(filePath: string, value: unknown): void {
  writePrivateTextFileSync(filePath, JSON.stringify(value, null, 2));
}
