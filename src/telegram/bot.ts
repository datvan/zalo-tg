import { Telegraf } from 'telegraf';
import https from 'https';
import { config } from '../config.js';
import { markError } from '../health.js';

// Force IPv4 to avoid ETIMEDOUT on systems where IPv6 is blocked/unreachable
const agent = new https.Agent({ family: 4 });

/** Singleton Telegraf bot instance shared across the app. */
export const tgBot = new Telegraf(config.telegram.token, {
  telegram: { agent },
});

// Without this, an unhandled error thrown inside any middleware/handler crashes the
// polling loop silently — Telegraf swallows it into an unhandled rejection with no
// restart, no health signal, and no visibility beyond a generic process-level log.
tgBot.catch((err, ctx) => {
  const msg = `[Telegram] middleware error (update ${ctx.update.update_id}): ${err instanceof Error ? err.message : String(err)}`;
  console.error(msg, err);
  markError(msg);
});
