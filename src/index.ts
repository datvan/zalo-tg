import { getZaloApi } from './zalo/client.js';
import { setupZaloHandler } from './zalo/handler.js';
import { tgBot } from './telegram/bot.js';
import { setupTelegramHandler } from './telegram/handler.js';
import { config } from './config.js';
import { getHealth, markError, markHealth } from './health.js';
import { startFacebookSessionWatchdog } from './utils/facebookBrowserSession.js';
import { startYtDlpWatchdog } from './utils/ytDlpMaintenance.js';
import { escapeHtml } from './utils/format.js';

process.on('beforeExit', (code) => {
  console.error('[ProcessDiag] beforeExit', code, new Error('beforeExit stack').stack);
});
process.on('exit', (code) => {
  console.error('[ProcessDiag] exit', code);
});
process.on('uncaughtException', (err) => {
  console.error('[ProcessDiag] uncaughtException', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[ProcessDiag] unhandledRejection', reason);
});

function ageMs(ts?: string): number {
  if (!ts) return Infinity;
  const t = Date.parse(ts);
  return Number.isFinite(t) ? Date.now() - t : Infinity;
}

function inActiveHours(): boolean {
  const hour = new Date().getHours();
  const start = Number(process.env.ZALO_TG_ACTIVE_START_HOUR || 8);
  const end = Number(process.env.ZALO_TG_ACTIVE_END_HOUR || 23);
  return start <= end ? hour >= start && hour < end : hour >= start || hour < end;
}

setInterval(() => {
  if (!inActiveHours()) return;
  const h = getHealth();
  const startedAge = ageMs(h.zaloStartedAt || h.startedAt);
  const minRuntimeMs = Number(process.env.ZALO_TG_MIN_RUNTIME_BEFORE_STALE_MS || 30 * 60_000);
  if (startedAge < minRuntimeMs) return;
  const maxSilentMs = Number(process.env.ZALO_TG_MAX_SILENCE_MS || 3 * 60 * 60_000);
  // No fallback bail-out here: ageMs(undefined) already returns Infinity, so "traffic
  // never recorded" is correctly treated as maximally stale instead of silently ignored
  // (that silent ignore is exactly what let this in-process watchdog go blind whenever
  // the Zalo-side health instrumentation regressed — see zalo/handler.ts markHealth calls).
  const trafficAge = ageMs(h.lastTrafficAt);
  if (trafficAge <= maxSilentMs) return;
  const msg = `[BridgeWatchdog] no bridge traffic for ${Math.round(trafficAge / 1000)}s; exiting for PM2 restart`;
  console.error(msg);
  markError(msg);
  process.exit(13);
}, 60_000).unref();

// Ã¢â€â‚¬Ã¢â€â‚¬ Boot Zalo (also used when /login swaps in a fresh API) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

function wireZaloListenerDiagnostics(api: Awaited<ReturnType<typeof getZaloApi>>): void {
  api.listener.on('error', (err: unknown) => {
    const msg = `[Zalo] listener error: ${err instanceof Error ? err.message : String(err)}`;
    console.error(msg);
    markHealth({ status: 'error', lastError: msg.slice(0, 1000) });
  });
  api.listener.on('disconnected', (code: number, reason: string) => {
    console.warn(`[Zalo] listener disconnected code=${code} reason=${reason} (retrying if possible)`);
    markHealth({ status: 'error', lastError: `zalo disconnected code=${code} reason=${reason}`.slice(0, 1000) });
  });
  // 'closed' only fires once zca-js gives up retrying (non-retryable code, or retry budget exhausted) —
  // at that point the socket is permanently dead with nothing left in-process to reconnect it, so we
  // exit and let PM2 fully restart the process instead of lingering as an unrecoverable zombie.
  api.listener.on('closed', (code: number, reason: string) => {
    const msg = `[Zalo] listener closed permanently code=${code} reason=${reason}; exiting for PM2 restart`;
    console.error(msg);
    markError(msg);
    process.exit(14);
  });
}

async function startZalo(api: Awaited<ReturnType<typeof getZaloApi>>): Promise<void> {
  setupZaloHandler(api);
  wireZaloListenerDiagnostics(api);
  api.listener.start({ retryOnClose: true });
  markHealth({ status: 'ok', zaloStartedAt: new Date().toISOString(), lastError: undefined });
  console.log('[Boot] Zalo listener started ok');
}

async function main(): Promise<void> {
  console.log('Ã¢â€¢â€Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢â€”');
  console.log('Zalo <-> Telegram Bridge  v1.0.1210');
  console.log('Ã¢â€¢Å¡Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â');

  // Ã¢â€â‚¬Ã¢â€â‚¬ Wire up Telegram handler BEFORE launching the bot Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
  // setupTelegramHandler returns a setter to inject the Zalo API after auto-login.
  const setZaloApi = setupTelegramHandler(null, async (newApi) => {
    await startZalo(newApi);
  });

  // Ã¢â€â‚¬Ã¢â€â‚¬ Start Telegram bot so /login can be received immediately Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
  // NOTE: tgBot.launch() runs the polling loop forever, so we must NOT await it.
  // The second argument callback fires once getMe() + deleteWebhook() succeed.
  tgBot.launch({ allowedUpdates: ['message', 'callback_query', 'message_reaction', 'poll_answer', 'poll'] }, () => {
    console.log('[Boot] Telegram bot started Ã¢Å“â€œ');

    // Ã¢â€â‚¬Ã¢â€â‚¬ Attempt Zalo login in background Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
    // If credentials.json exists Ã¢â€ â€™ connects automatically and updates currentApi.
    // If not Ã¢â€ â€™ notifies the user to run /login.
    getZaloApi()
      .then(async (api) => {
        setZaloApi(api);   // Ã¢â€ Â inject into Telegram handler so TGÃ¢â€ â€™Zalo works
        await startZalo(api);
      })
      .catch((err: unknown) => {
        console.warn('[Boot] Zalo auto-login failed:', err);
        tgBot.telegram
          .sendMessage(
            config.telegram.groupId,
            'Ã¢Å¡Â Ã¯Â¸Â ChÃ†Â°a Ã„â€˜Ã„Æ’ng nhÃ¡ÂºÂ­p Zalo. GÃ¡Â»Â­i <b>/login</b> Ã„â€˜Ã¡Â»Æ’ Ã„â€˜Ã„Æ’ng nhÃ¡ÂºÂ­p.',
            { parse_mode: 'HTML' },
          )
          .catch(() => undefined);
      });

    startFacebookSessionWatchdog((reason) => {
      tgBot.telegram
        .sendMessage(
          config.telegram.groupId,
          `⚠️ Facebook session hỏng, video Facebook sẽ fail cho đến khi login lại.\nChạy: <code>node scripts/login-facebook-profile.mjs</code>\n<code>${escapeHtml(reason)}</code>`,
          { parse_mode: 'HTML' },
        )
        .catch(() => undefined);
    });

    startYtDlpWatchdog((reason) => {
      tgBot.telegram
        .sendMessage(
          config.telegram.groupId,
          `⚠️ yt-dlp không tải được video YouTube ngay cả sau khi tự update — YouTube có thể vừa đổi thêm thứ mới. Cần kiểm tra thủ công: <code>yt-dlp -U</code> hoặc chờ bản yt-dlp mới hơn.\n<code>${escapeHtml(reason)}</code>`,
          { parse_mode: 'HTML' },
        )
        .catch(() => undefined);
    });
  });

  console.log('[Boot] Bridge is running Ã°Å¸Å¡â‚¬  (Ctrl+C to stop)');

  // Ã¢â€â‚¬Ã¢â€â‚¬ Graceful shutdown Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
  const shutdown = (signal: string) => {
    markHealth({ status: 'stopping' });
    console.log(`\n[Boot] Received ${signal}, shutting down...`);
    try { getZaloApi().then(api => api.listener.stop()).catch(() => undefined); } catch { /* ignore */ }
    tgBot.stop(signal);
    process.exit(0);
  };

  process.once('SIGINT',  () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  markError(err);
  console.error('[Boot] Fatal error:', err);
  process.exit(1);
});





