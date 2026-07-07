// ── Zalo-only sidecar for Rust bridge (Phase 2) ─────────────────────────────
// Uses REAL telegraf for Zalo→TG sending.
// Rust handles TG→Zalo receiving via getUpdates polling + stdin commands.

process.env.ZALO_SIDECAR = '1';

import { getZaloApi, resetZaloApi } from './zalo/client.js';
import { CloseReason, ThreadType } from 'zca-js';
import { setupZaloHandler } from './zalo/handler.js';
import { setupTelegramHandler } from './telegram/handler.js';
import { config } from './config.js';
import { store, userCache } from './store.js';
import { registerShutdownHandler, requestShutdown } from './lifecycle.js';
import { createInterface } from 'readline';

// ── Helpers ───────────────────────────────────────────────────────────────────

function writeEvent(event: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(event) + '\n');
}

let _activeApi: Awaited<ReturnType<typeof getZaloApi>> | null = null;
let _reconnectInProgress = false;
let _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let _bridgeReadyAnnounced = false;

// ── Zalo bootstrap ────────────────────────────────────────────────────────────

async function pruneLeftGroupTopics(api: Awaited<ReturnType<typeof getZaloApi>>): Promise<void> {
  try {
    const groups = await api.getAllGroups() as { gridVerMap?: Record<string, string> } | undefined;
    const activeGroupIds = new Set(Object.keys(groups?.gridVerMap ?? {}));
    const removed: string[] = [];
    for (const entry of store.all()) {
      if (entry.type === 1 && !activeGroupIds.has(entry.zaloId)) {
        store.remove(entry.topicId);
        removed.push(`${entry.name} (${entry.zaloId})`);
      }
    }
    if (removed.length > 0) {
      writeEvent({ type: 'log', level: 'warn', message: `Pruned ${removed.length} stale mapping(s)` });
    }
  } catch (err) {
    console.warn('[Sidecar] Could not prune stale group topics:', err);
  }
}

async function startZalo(
  api: Awaited<ReturnType<typeof getZaloApi>>,
  isReconnect = false,
): Promise<void> {
  _activeApi = api;
  if (!isReconnect) await pruneLeftGroupTopics(api);
  await setupZaloHandler(api);
  if (isReconnect) {
    api.listener.once('connected', () => {
      try {
        api.listener.requestOldMessages(ThreadType.User);
        api.listener.requestOldMessages(ThreadType.Group);
        api.listener.requestOldReactions(ThreadType.User);
        api.listener.requestOldReactions(ThreadType.Group);
        writeEvent({ type: 'log', level: 'info', message: 'Catch-up sync requested after reconnect' });
      } catch (err) {
        console.warn('[Sidecar] Failed to request catch-up sync:', err);
      }
    });
  }
  api.listener.start();
  writeEvent({ type: 'state', state: 'listener_started', is_reconnect: isReconnect });
  if (!_bridgeReadyAnnounced) {
    _bridgeReadyAnnounced = true;
    writeEvent({ type: 'state', state: 'ready' });
  }

  const scheduleReconnect = (delayMs: number): void => {
    if (_reconnectTimer || _reconnectInProgress) return;
    _reconnectTimer = setTimeout(() => {
      _reconnectTimer = null;
      void (async () => {
        if (_reconnectInProgress) return;
        _reconnectInProgress = true;
        try {
          resetZaloApi();
          const newApi = await getZaloApi();
          await startZalo(newApi, true);
          writeEvent({ type: 'log', level: 'success', message: 'Zalo reconnected and syncing' });
        } catch (err) {
          console.error('[Sidecar] Zalo reconnect failed:', err);
          writeEvent({ type: 'log', level: 'error', message: 'Zalo reconnect failed' });
        } finally {
          _reconnectInProgress = false;
        }
      })();
    }, delayMs);
  };

  api.listener.once('disconnected', (code: CloseReason, reason: string) => {
    writeEvent({ type: 'disconnected', code, reason: String(reason) });
    if (code === CloseReason.ManualClosure) return;
    if (code === CloseReason.DuplicateConnection) {
      console.warn(`[Sidecar] Zalo disconnected: duplicate connection (code=${code})`);
      return;
    }
    if (code === CloseReason.KickConnection) {
      console.warn(`[Sidecar] Zalo disconnected: kicked (code=${code})`);
      return;
    }
    console.warn(`[Sidecar] Zalo disconnected (code=${code}), reconnecting in 5 s…`);
    scheduleReconnect(5_000);
  });
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  writeEvent({ type: 'state', state: 'starting', version: process.version, pid: process.pid });

  // Warm caches
  writeEvent({ type: 'log', level: 'info', message: `${userCache.stats().users} users · ${store.all().length} topics restored` });

  // Wire up Telegram handlers (register bot commands / callbacks) WITHOUT polling.
  // Rust handles TG→Zalo via stdin; telegraf handles Zalo→TG via real API.
  const setZaloApi = setupTelegramHandler(null, async (newApi) => {
    await startZalo(newApi, true);
  });

  // Graceful shutdown
  registerShutdownHandler(async (reason, exitCode) => {
    if (_reconnectTimer) {
      clearTimeout(_reconnectTimer);
      _reconnectTimer = null;
    }
    try { _activeApi?.listener.stop(); } catch { /* ignore */ }
    writeEvent({ type: 'state', state: 'shutdown', reason: String(reason), exitCode });
    await new Promise(r => setTimeout(r, 2500));
    process.exit(exitCode);
  });

  // Zalo auto-login from saved credentials
  getZaloApi()
    .then(async (api) => {
      setZaloApi(api);
      writeEvent({ type: 'log', level: 'info', message: 'Zalo auto-login succeeded' });
      await startZalo(api);
    })
    .catch((err: unknown) => {
      console.warn('[Sidecar] Zalo auto-login failed:', err);
      writeEvent({ type: 'log', level: 'warn', message: 'Zalo auto-login failed — waiting for /login' });
      writeEvent({ type: 'state', state: 'need_login' });
    });

  // Stdin command reader (TG→Zalo from Rust bridge)
  const rl = createInterface({ input: process.stdin, terminal: false });
  for await (const line of rl) {
    try {
      const cmd = JSON.parse(line);
      await handleCommand(cmd);
    } catch (err) {
      console.error('[Sidecar] Invalid stdin command:', line, err);
    }
  }

  process.once('SIGINT',  () => { void requestShutdown('Received SIGINT', 0); });
  process.once('SIGTERM', () => { void requestShutdown('Received SIGTERM', 0); });
}

// ── Command handler (TG→Zalo from Rust) ─────────────────────────────────────

async function handleCommand(cmd: Record<string, unknown>): Promise<void> {
  const { command, data } = cmd;
  const api = _activeApi;
  if (!api) {
    writeEvent({ type: 'cmd_result', command, error: 'Zalo API not ready' });
    return;
  }

  try {
    switch (command as string) {
      case 'send_message': {
        const result = await api.sendMessage(data as never);
        writeEvent({ type: 'cmd_result', command, result });
        break;
      }
      case 'send_attachment': {
        const result = await api.sendAttachment(data as never);
        writeEvent({ type: 'cmd_result', command, result });
        break;
      }
      case 'send_reaction': {
        const result = await api.sendReaction(data as never);
        writeEvent({ type: 'cmd_result', command, result });
        break;
      }
      case 'recall': {
        const result = await api.undo(data as never);
        writeEvent({ type: 'cmd_result', command, result });
        break;
      }
      case 'trigger_login': {
        writeEvent({ type: 'cmd_result', command, status: 'login_triggered' });
        resetZaloApi();
        const { triggerQRLogin } = await import('./zalo/client.js');
        const newApi = await triggerQRLogin({
          onQRReady: (imagePath, code) => writeEvent({ type: 'login_qr', imagePath, code }),
          onScanned: (name) => writeEvent({ type: 'login_scanned', name }),
          onExpired: () => writeEvent({ type: 'login_expired' }),
          onDeclined: () => writeEvent({ type: 'login_declined' }),
          onSuccess: () => writeEvent({ type: 'login_success' }),
        });
        _activeApi = newApi;
        await startZalo(newApi);
        break;
      }
      default:
        writeEvent({ type: 'cmd_result', command, error: `Unknown: ${command}` });
    }
  } catch (err) {
    writeEvent({ type: 'cmd_result', command, error: String(err) });
  }
}

main().catch((err: unknown) => {
  console.error('[Sidecar] Fatal error:', err);
  process.exit(1);
});
