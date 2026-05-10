import type { Context } from 'telegraf';
import { config } from './config.js';

export function isAllowedTelegramUser(ctx: Context): boolean {
  const userId = ctx.from?.id;
  if (userId === undefined) return false;
  return config.telegram.adminUserIds.includes(userId);
}

export function isBridgeGroup(ctx: Context): boolean {
  return ctx.chat?.id === config.telegram.groupId;
}

export function canUseBridge(ctx: Context): boolean {
  return isBridgeGroup(ctx) && isAllowedTelegramUser(ctx);
}

export async function rejectUnauthorized(ctx: Context): Promise<void> {
  console.warn(`[Security] blocked Telegram update from user=${ctx.from?.id ?? 'unknown'} chat=${ctx.chat?.id ?? 'unknown'}`);
  try {
    if ('answerCbQuery' in ctx && typeof ctx.answerCbQuery === 'function') {
      await ctx.answerCbQuery('Unauthorized');
      return;
    }
    if (ctx.chat?.id === config.telegram.groupId) {
      await ctx.reply('⛔ Unauthorized');
    }
  } catch {
    // Ignore notification failures.
  }
}
