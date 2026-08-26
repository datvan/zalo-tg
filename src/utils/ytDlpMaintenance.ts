import { existsSync } from 'fs';
import { spawn } from 'child_process';
import path from 'path';
import { markHealth } from '../health.js';

/**
 * Keeps yt-dlp itself current and watches for YouTube extraction breaking — the mirror of
 * facebookBrowserSession.ts's session watchdog, but for a different failure class. Facebook
 * downloads fail because a *session cookie* goes stale; YouTube downloads fail because the
 * *yt-dlp binary* falls behind YouTube's frequent client/extractor changes (e.g. the
 * android_vr player_client YouTube blocked in Aug 2026, fixed in yt-dlp 2026.08.19). A cookie
 * file can't fix that — only shipping a newer yt-dlp can, so this module's "refresh" step is
 * `pip install --upgrade yt-dlp` instead of a cookie export.
 */

const DEFAULT_YTDLP_BIN = 'C:\\Users\\Admin\\AppData\\Roaming\\Python\\Python311\\Scripts\\yt-dlp.exe';

export function ytDlpBinPath(): string {
  const envBin = process.env.YTDLP_BIN?.trim();
  return envBin || (existsSync(DEFAULT_YTDLP_BIN) ? DEFAULT_YTDLP_BIN : 'yt-dlp');
}

/** pip lives alongside yt-dlp.exe in the same Scripts directory when installed via `pip install
 * yt-dlp` (the case here) — deriving it from the yt-dlp path avoids a second hardcoded path that
 * could silently drift out of sync with YTDLP_BIN if that env var is ever overridden. */
function pipBinPath(): string {
  const envBin = process.env.PIP_BIN?.trim();
  if (envBin) return envBin;
  const ytDlpBin = ytDlpBinPath();
  return existsSync(ytDlpBin) ? path.join(path.dirname(ytDlpBin), 'pip.exe') : 'pip';
}

function runCapture(command: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const { promise, resolve } = Promise.withResolvers<{ code: number | null; stdout: string; stderr: string }>();
  const p = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  const timer = setTimeout(() => { p.kill(); }, timeoutMs);
  p.stdout.on('data', d => { stdout += String(d); });
  p.stderr.on('data', d => { stderr += String(d); });
  p.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  p.on('error', err => { clearTimeout(timer); resolve({ code: null, stdout, stderr: String(err) }); });
  return promise;
}

export async function currentYtDlpVersion(): Promise<string | undefined> {
  const { code, stdout } = await runCapture(ytDlpBinPath(), ['--version'], 15_000);
  return code === 0 ? stdout.trim() : undefined;
}

/** `pip install --upgrade yt-dlp` — safe to run unconditionally: pip no-ops (exit 0, "already
 * satisfied") when already current, so this never needs a pre-check for whether an update
 * exists. Returns the version after the attempt regardless of whether it changed. */
export async function upgradeYtDlp(): Promise<{ ok: boolean; version?: string; error?: string }> {
  const { code, stderr } = await runCapture(pipBinPath(), ['install', '--upgrade', 'yt-dlp'], 120_000);
  if (code !== 0) return { ok: false, error: stderr.slice(-800) || `pip exit ${code}` };
  const version = await currentYtDlpVersion();
  return { ok: true, version };
}

/** A long-lived, stable, publicly embeddable YouTube video used purely as an extraction canary —
 * not shown to users, just downloaded (`--simulate`, no bytes written) to prove yt-dlp can still
 * resolve a playable format against YouTube's current client requirements. */
const CANARY_URL = process.env.YTDLP_CANARY_URL?.trim() || 'https://www.youtube.com/watch?v=jNQXAC9IVRw';

export async function checkYtDlpExtractionAlive(): Promise<{ alive: boolean; reason?: string }> {
  const { code, stderr } = await runCapture(
    ytDlpBinPath(),
    ['--no-warnings', '-f', 'bv*+ba/b', '--simulate', CANARY_URL],
    30_000,
  );
  if (code === 0) return { alive: true };
  return { alive: false, reason: stderr.trim().slice(-500) || `yt-dlp exit ${code}` };
}

const DEFAULT_CHECK_INTERVAL_MS = 6 * 60 * 60_000; // matches the Facebook session watchdog cadence.
const ALERT_COOLDOWN_MS = 12 * 60 * 60_000;
let lastAlertAt = 0;

/** Runs immediately and then on an interval: upgrades yt-dlp (a no-op when already current),
 * then confirms extraction still works against the canary video. If extraction is broken even
 * after the upgrade attempt, alerts (rate limited) — this is the case that needs a human, since
 * it means YouTube broke something newer than the latest yt-dlp release supports yet. */
export function startYtDlpWatchdog(onExtractionDead: (reason: string) => void): void {
  const run = async () => {
    const upgrade = await upgradeYtDlp().catch(err => ({ ok: false as const, version: undefined, error: err instanceof Error ? err.message : String(err) }));
    if (!upgrade.ok) console.warn('[YtDlpWatchdog] upgrade failed:', upgrade.error);
    else if (upgrade.version) console.log(`[YtDlpWatchdog] yt-dlp version: ${upgrade.version}`);

    let result: { alive: boolean; reason?: string };
    try {
      result = await checkYtDlpExtractionAlive();
    } catch (err) {
      console.warn('[YtDlpWatchdog] extraction check failed:', err instanceof Error ? err.message : err);
      return;
    }
    if (result.alive) {
      markHealth({ ytDlpOk: true, ytDlpCheckedAt: new Date().toISOString(), ytDlpVersion: upgrade.version, ytDlpError: undefined });
      return;
    }
    markHealth({ ytDlpOk: false, ytDlpCheckedAt: new Date().toISOString(), ytDlpVersion: upgrade.version, ytDlpError: result.reason });
    console.warn(`[YtDlpWatchdog] extraction dead even after upgrade attempt: ${result.reason}`);
    const now = Date.now();
    if (now - lastAlertAt > ALERT_COOLDOWN_MS) {
      lastAlertAt = now;
      onExtractionDead(result.reason ?? 'unknown');
    }
  };
  void run();
  setInterval(run, Number(process.env.YTDLP_CHECK_INTERVAL_MS || DEFAULT_CHECK_INTERVAL_MS)).unref();
}
