import { ThreadType } from 'zca-js';
import path from 'path';
import { createReadStream } from 'fs';

import type { ZaloAPI } from '../zalo/types.js';
import { store, msgStore, userCache, friendsCache, sentMsgStore, pollStore, mediaGroupStore } from '../store.js';
import { tgBot } from './bot.js';
import { config } from '../config.js';
import { downloadToTemp, cleanTemp, convertToM4a, convertToMp4, convertTgsToMp4 } from '../utils/media.js';
import { extractSocialVideoUrl, enqueueSocialVideo, downloadSocialVideo, socialVideoLabel } from '../utils/socialVideo.js';
import { triggerQRLogin } from '../zalo/client.js';
import { canUseBridge, rejectUnauthorized } from '../security.js';

// â”€â”€ Mention resolution helper â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

type TgEntity = { type: string; offset: number; length: number; user?: { first_name: string; last_name?: string } };

/**
 * Resolve TG mention entities (or plain-text @Name patterns) in a string
 * to Zalo mention objects. Works for both msg.text+entities and
 * msg.caption+caption_entities.
 */
function resolveTgMentions(
  text: string,
  entities: ReadonlyArray<TgEntity> | undefined,
  forZaloGroup: boolean,
): Array<{ pos: number; uid: string; len: number }> {
  const result: Array<{ pos: number; uid: string; len: number }> = [];
  if (!forZaloGroup) return result;

  // 1. Named TG entities (@username or text_mention with user object)
  if (entities) {
    for (const e of entities) {
      if (e.type === 'mention') {
        const rawName = text.slice(e.offset + 1, e.offset + e.length); // strip leading @
        const uid = userCache.resolveByName(rawName);
        if (uid) result.push({ pos: e.offset, uid, len: e.length });
      } else if (e.type === 'text_mention' && e.user) {
        const rawName = e.user.first_name + (e.user.last_name ? ` ${e.user.last_name}` : '');
        const uid = userCache.resolveByName(rawName);
        if (uid) result.push({ pos: e.offset, uid, len: e.length });
      }
    }
  }

  // 2. Plain-text @Name patterns (only if no entity matched above)
  if (result.length === 0) {
    const atPattern = /@([\p{L}\p{N}_]+(?:\s[\p{L}\p{N}_]+){0,3})/gu;
    let m: RegExpExecArray | null;
    while ((m = atPattern.exec(text)) !== null) {
      const captured = m[1];
      if (/^(all|everyone|táº¥t\s*cáº£)$/i.test(captured)) {
        result.push({ pos: m.index, uid: '-1', len: m[0].length });
        continue;
      }
      const words = captured.split(' ');
      for (let end = words.length; end >= 1; end--) {
        const candidate = words.slice(0, end).join(' ');
        const uid = userCache.resolveByName(candidate);
        if (uid) {
          result.push({ pos: m.index, uid, len: ('@' + candidate).length });
          break;
        }
      }
    }
  }

  return result;
}

/** Track in-progress QR login so we don't stack multiple flows. */
let qrLoginInProgress = false;

/**
 * Start a Zalo QR login flow and forward the QR image + status messages
 * back to the Telegram chat/topic where /login was sent.
 */
async function handleLoginCommand(
  chatId: number,
  threadId: number | undefined,
  onNewApi: (api: ZaloAPI) => void,
): Promise<void> {
  if (qrLoginInProgress) {
    await tgBot.telegram.sendMessage(
      chatId,
      'â³ Äang cÃ³ phiÃªn Ä‘Äƒng nháº­p khÃ¡c Ä‘ang cháº¡y. Vui lÃ²ng chá»...',
      threadId ? { message_thread_id: threadId } : {},
    );
    return;
  }

  qrLoginInProgress = true;
  const msgOpts = threadId ? { message_thread_id: threadId } : {};

  try {
    await tgBot.telegram.sendMessage(chatId, 'ðŸ”„ Äang táº¡o mÃ£ QR Zalo...', msgOpts);

    const newApi = await triggerQRLogin({
      onQRReady: async (imagePath) => {
        await tgBot.telegram.sendPhoto(
          chatId,
          { source: createReadStream(imagePath) },
          {
            ...msgOpts,
            caption: 'ðŸ“± Má»Ÿ á»©ng dá»¥ng <b>Zalo</b> â†’ CÃ i Ä‘áº·t â†’ QuÃ©t mÃ£ QR Ä‘á»ƒ Ä‘Äƒng nháº­p.',
            parse_mode: 'HTML',
          },
        );
      },
      onExpired: async () => {
        await tgBot.telegram.sendMessage(chatId, 'â° QR háº¿t háº¡n, Ä‘ang táº¡o mÃ£ má»›i...', msgOpts);
      },
      onScanned: async (displayName) => {
        await tgBot.telegram.sendMessage(
          chatId,
          `âœ… ÄÃ£ quÃ©t! Chá» xÃ¡c nháº­n tá»« <b>${displayName}</b>...`,
          { ...msgOpts, parse_mode: 'HTML' },
        );
      },
      onDeclined: async () => {
        await tgBot.telegram.sendMessage(chatId, 'âŒ ÄÄƒng nháº­p bá»‹ tá»« chá»‘i trÃªn Ä‘iá»‡n thoáº¡i.', msgOpts);
      },
      onSuccess: async () => {
        await tgBot.telegram.sendMessage(
          chatId,
          'ðŸŽ‰ ÄÄƒng nháº­p Zalo thÃ nh cÃ´ng! Bridge Ä‘ang hoáº¡t Ä‘á»™ng.',
          msgOpts,
        );
      },
    });

    onNewApi(newApi);
  } catch (err) {
    await tgBot.telegram.sendMessage(
      chatId,
      `âŒ ÄÄƒng nháº­p tháº¥t báº¡i: ${String(err)}`,
      msgOpts,
    ).catch(() => undefined);
  } finally {
    qrLoginInProgress = false;
  }
}

/**
 * Wire up Telegram â†’ Zalo forwarding.
 *
 * @param initialApi  Starting Zalo API (null if not yet logged in).
 * @param onZaloLogin Called with the new API after a successful /login so the
 *                    caller can re-attach the Zalo listener on the fresh API.
 */
export function setupTelegramHandler(
  initialApi: ZaloAPI | null,
  onZaloLogin: (api: ZaloAPI) => Promise<void>,
): (api: ZaloAPI) => void {
  /** Mutable reference so /login can swap in a new API instance. */
  let currentApi: ZaloAPI | null = initialApi;

  /** Exposed setter so index.ts can inject the auto-logged-in API. */
  const setCurrentApi = (api: ZaloAPI) => { currentApi = api; };

  tgBot.command('login', async (ctx) => {
    if (!canUseBridge(ctx)) { await rejectUnauthorized(ctx); return; }
    const threadId = ctx.message.message_thread_id;
    await handleLoginCommand(ctx.chat.id, threadId, (newApi) => {
      currentApi = newApi;
      void onZaloLogin(newApi).catch((e: unknown) => console.error('[/login] onZaloLogin error:', e));
    });
  });

  // /topic â€“ manage bridge topic mappings
  // Usage inside a topic:  /topic info | /topic delete
  // Usage from General:    /topic list
  tgBot.command('topic', async (ctx) => {
    if (!canUseBridge(ctx)) { await rejectUnauthorized(ctx); return; }
    const topicId = 'message_thread_id' in ctx.message
      ? (ctx.message.message_thread_id as number | undefined)
      : undefined;
    const arg = (ctx.message.text ?? '').split(/\s+/)[1]?.toLowerCase() ?? '';
    const replyOpts = topicId ? { message_thread_id: topicId } : {};

    if (arg === 'list' || !arg) {
      const all = store.all();
      if (all.length === 0) {
        await ctx.telegram.sendMessage(config.telegram.groupId, 'ðŸ“­ ChÆ°a cÃ³ topic nÃ o.', replyOpts);
        return;
      }
      const lines = all.map(e =>
        `â€¢ <b>${e.name}</b> â€” topicId=${e.topicId}, zaloId=${e.zaloId}, type=${e.type === 1 ? 'group' : 'dm'}`,
      );
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        `ðŸ“‹ <b>Bridge topics</b> (${all.length}):\n${lines.join('\n')}`,
        { ...replyOpts, parse_mode: 'HTML' },
      );
      return;
    }

    if (!topicId) {
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        'âš ï¸ Lá»‡nh nÃ y pháº£i Ä‘Æ°á»£c gá»­i trong má»™t topic cá»¥ thá»ƒ.',
        replyOpts,
      );
      return;
    }

    if (arg === 'info') {
      const entry = store.getEntryByTopic(topicId);
      if (!entry) {
        await ctx.telegram.sendMessage(config.telegram.groupId, 'âŒ Topic nÃ y chÆ°a Ä‘Æ°á»£c map.', replyOpts);
        return;
      }
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        `â„¹ï¸ <b>${entry.name}</b>\nzaloId: <code>${entry.zaloId}</code>\ntype: ${entry.type === 1 ? 'group' : 'dm'}`,
        { ...replyOpts, parse_mode: 'HTML' },
      );
      return;
    }

    if (arg === 'delete') {
      const removed = store.remove(topicId);
      if (!removed) {
        await ctx.telegram.sendMessage(config.telegram.groupId, 'âŒ Topic nÃ y chÆ°a Ä‘Æ°á»£c map.', replyOpts);
        return;
      }
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        `ðŸ—‘ï¸ ÄÃ£ xoÃ¡ mapping: <b>${removed.name}</b> (zaloId=${removed.zaloId})`,
        { ...replyOpts, parse_mode: 'HTML' },
      );
      return;
    }

    await ctx.telegram.sendMessage(
      config.telegram.groupId,
      'â“ DÃ¹ng: <code>/topic list</code> | <code>/topic info</code> | <code>/topic delete</code>',
      { ...replyOpts, parse_mode: 'HTML' },
    );
  });

  tgBot.command('recall', async (ctx) => {
    if (!canUseBridge(ctx)) { await rejectUnauthorized(ctx); return; }
    if (!currentApi) { await ctx.reply('âŒ Zalo chÆ°a káº¿t ná»‘i'); return; }

    const replyTo = 'reply_to_message' in ctx.message
      ? (ctx.message as { reply_to_message?: { message_id: number } }).reply_to_message
      : undefined;

    if (!replyTo) {
      await ctx.reply('â„¹ï¸ Reply vÃ o tin nháº¯n mÃ¬nh Ä‘Ã£ gá»­i rá»“i gÃµ /recall');
      return;
    }

    // Look up from sentMsgStore (TGâ†’Zalo messages we sent)
    const sent = sentMsgStore.get(replyTo.message_id);
    if (!sent) {
      await ctx.reply('âŒ KhÃ´ng tÃ¬m tháº¥y tin nháº¯n Ä‘Ã£ gá»­i (chá»‰ thu há»“i Ä‘Æ°á»£c tin mÃ¬nh gá»­i tá»« Telegram, vÃ  chá»‰ trong 300 tin gáº§n nháº¥t)');
      return;
    }

    const { ThreadType } = await import('zca-js');
    const zaloThreadType = sent.threadType === 1 ? ThreadType.Group : ThreadType.User;

    try {
      await currentApi.undo(
        { msgId: sent.msgId, cliMsgId: 0 },
        sent.zaloId,
        zaloThreadType,
      );
      console.log(`[TGâ†’Zalo] Recall msgId=${sent.msgId} zaloId=${sent.zaloId}`);
      await ctx.reply('âœ… ÄÃ£ thu há»“i tin nháº¯n trÃªn Zalo');
    } catch (err) {
      console.error('[TGâ†’Zalo] Recall error:', err);
      await ctx.reply(`âŒ Thu há»“i tháº¥t báº¡i: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  tgBot.command('search', async (ctx) => {
    if (!canUseBridge(ctx)) { await rejectUnauthorized(ctx); return; }
    // /search must be in General (no topicId) or any topic â€” reply to same thread
    const threadId = 'message_thread_id' in ctx.message
      ? (ctx.message.message_thread_id as number | undefined)
      : undefined;
    const replyOpts = threadId ? { message_thread_id: threadId } : {};

    const query = (ctx.message.text ?? '').replace(/^\/search\s*/i, '').trim();
    if (!query) {
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        'ðŸ” CÃº phÃ¡p: <code>/search TÃªn</code>',
        { ...replyOpts, parse_mode: 'HTML' },
      );
      return;
    }

    // Refresh friends cache if stale
    if (!friendsCache.isFresh()) {
      try {
        const raw = await currentApi?.getAllFriends() as Array<{ userId: string; displayName: string }> | undefined;
        if (raw) friendsCache.set(raw.map(f => ({ userId: f.userId, displayName: f.displayName })));
      } catch (err) {
        console.error('[/search] getAllFriends failed:', err);
      }
    }

    const results = friendsCache.search(query, 10);
    if (results.length === 0) {
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        `ðŸ” KhÃ´ng tÃ¬m tháº¥y ai cÃ³ tÃªn chá»©a "<b>${query}</b>".`,
        { ...replyOpts, parse_mode: 'HTML' },
      );
      return;
    }

    // Build inline keyboard â€” each button opens/creates a DM topic
    const buttons = results.map(f => [{
      text: f.displayName,
      callback_data: `sc:${f.userId}`,
    }]);

    await ctx.telegram.sendMessage(
      config.telegram.groupId,
      `ðŸ” Káº¿t quáº£ "<b>${query}</b>" (${results.length} ngÆ°á»i):`,
      {
        ...replyOpts,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: buttons },
      },
    );
  });

  tgBot.on('callback_query', async (ctx) => {
    if (!canUseBridge(ctx)) { await rejectUnauthorized(ctx); return; }

    const data = 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;

    if (data?.startsWith('lock_poll:')) {
      const pollId = Number(data.slice('lock_poll:'.length));
      const entry = pollStore.getByPollId(pollId);
      if (!entry || !currentApi) {
        await ctx.answerCbQuery('âŒ KhÃ´ng tÃ¬m tháº¥y bÃ¬nh chá»n.');
        return;
      }
      try {
        await doLockPoll(entry, currentApi);
        await ctx.answerCbQuery('âœ… ÄÃ£ khoÃ¡ bÃ¬nh chá»n');
      } catch (err) {
        console.error('[TGâ†’Zalo] lock_poll callback error:', err);
        try { await ctx.answerCbQuery('âŒ Lá»—i khoÃ¡ bÃ¬nh chá»n'); } catch { /* ignore */ }
      }
      return;
    }

    if (!data?.startsWith('sc:')) return;

    const userId = data.slice(3);
    if (!userId) { await ctx.answerCbQuery('âŒ Dá»¯ liá»‡u khÃ´ng há»£p lá»‡'); return; }

    // Check if topic already exists
    const existing = store.getTopicByZalo(userId, 0 /* DM */);
    if (existing !== undefined) {
      await ctx.answerCbQuery('â„¹ï¸ Topic Ä‘Ã£ tá»“n táº¡i');
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        `ðŸ’¬ Topic cho ngÆ°á»i nÃ y Ä‘Ã£ cÃ³ sáºµn (topicId=${existing}).`,
        { message_thread_id: existing },
      );
      return;
    }

    // Resolve display name (from friends cache or getUserInfo)
    let displayName = friendsCache.search('', 0).find(f => f.userId === userId)?.displayName;
    if (!displayName) {
      try {
        const resp = await currentApi?.getUserInfo(userId) as {
          changed_profiles?: Record<string, { displayName?: string }>;
        } | undefined;
        displayName = resp?.changed_profiles?.[userId]?.displayName;
      } catch { /* ignore */ }
    }
    if (!displayName) displayName = `Zalo ${userId}`;

    // Create TG forum topic
    try {
      const topic = await ctx.telegram.createForumTopic(
        config.telegram.groupId,
        `ðŸ‘¤ ${displayName}`.slice(0, 128),
        { icon_color: 0x6FB9F0 },
      );
      const topicId = topic.message_thread_id;
      store.set({ topicId, zaloId: userId, type: 0, name: displayName });
      console.log(`[/search] Created DM topic "${displayName}" (topicId=${topicId})`);

      await ctx.answerCbQuery('âœ… ÄÃ£ táº¡o topic!');
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        `âœ… ÄÃ£ táº¡o topic cho <b>${displayName}</b>.\nNháº¯n tin táº¡i Ä‘Ã¢y Ä‘á»ƒ chat vá»›i há» qua Zalo.`,
        { message_thread_id: topicId, parse_mode: 'HTML' },
      );
    } catch (err) {
      console.error('[/search] createForumTopic failed:', err);
      await ctx.answerCbQuery('âŒ Táº¡o topic tháº¥t báº¡i');
    }
  });

  // Bot pháº£i lÃ  admin vÃ  allowed_updates pháº£i cÃ³ "message_reaction"
  tgBot.on('message_reaction', async (ctx) => {
    try {
      if (!currentApi) return;
      const update = ctx.messageReaction;
      if (!update) return;

      // Determine which reaction was added (new_reaction - old_reaction)
      type EmojiReaction = { type: 'emoji'; emoji: string };
      const isEmoji = (r: { type: string }): r is EmojiReaction => r.type === 'emoji';
      const oldEmojis = new Set(
        update.old_reaction
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .filter(r => isEmoji(r as any))
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .map(r => (r as any).emoji as string),
      );
      const added = update.new_reaction
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .filter(r => isEmoji(r as any) && !oldEmojis.has((r as any).emoji as string));

      // If nothing was added (only removed), skip
      if (added.length === 0) return;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tgEmoji = (added[0] as any).emoji as string;

      // Map TG emoji â†’ Zalo Reactions icon
      // Zalo Reactions enum values are the icon strings used in addReaction
      const TG_TO_ZALO: Record<string, string> = {
        'â¤':  '/-heart',
        'â¤ï¸': '/-heart',
        'ðŸ‘':  '/-strong',
        'ðŸ‘Ž':  '/-weak',
        'ðŸ˜„':  ':>',
        'ðŸ˜':  ':>',
        'ðŸ˜¢':  ':-((',
        'ðŸ˜­':  ':((',
        'ðŸ˜®':  ':o',
        'ðŸ˜±':  ':o',
        'ðŸ˜¡':  ':-h',
        'ðŸ¤¬':  ':-h',
        'ðŸ˜˜':  ':-*',
        'ðŸ¥°':  ';xx',
        'ðŸ˜':  ';xx',
        'ðŸ¤£':  ":'>",
        'ðŸ˜‚':  ":'>",
        'ðŸ’©':  '/-shit',
        'ðŸŒ¹':  '/-rose',
        'ðŸ’”':  '/-break',
        'ðŸ˜•':  ';-/',
        'ðŸ¤”':  ';-/',
        'ðŸ˜‰':  ';-)',
        'ðŸ‘Œ':  '/-ok',
        'âœŒï¸':  '/-v',
        'âœŒ':  '/-v',
        'ðŸ™':  '_()_',
        'ðŸ‘Š':  '/-punch',
        'ðŸ¤¯':  ':o',
        'ðŸŽ‰':  '/-bd',
        'ðŸ†':  '/-ok',
        'ðŸ’¯':  '/-ok',
        'ðŸ˜Ž':  'x-)',
        'ðŸ¤©':  'x-)',
        'ðŸ”¥':  '/-heart',
      };

      const zaloIcon = TG_TO_ZALO[tgEmoji];
      if (!zaloIcon) {
        console.log(`[TGâ†’Zalo] Reaction: no Zalo map for TG emoji "${tgEmoji}"`);
        return;
      }

      // Look up Zalo quote data for this TG message
      const tgMsgId = update.message_id;
      const quote   = msgStore.getQuote(tgMsgId);
      if (!quote) {
        console.log(`[TGâ†’Zalo] Reaction: no Zalo quote for TG msg ${tgMsgId}`);
        return;
      }

      const { ThreadType } = await import('zca-js');
      const zaloThreadType = quote.threadType === 1 ? ThreadType.Group : ThreadType.User;

      await currentApi.addReaction(
        { rType: 0, source: 0, icon: zaloIcon },
        {
          data: { msgId: quote.msgId, cliMsgId: quote.cliMsgId },
          threadId: quote.zaloId,
          type: zaloThreadType,
        },
      );
      console.log(`[TGâ†’Zalo] Reaction "${tgEmoji}" â†’ Zalo "${zaloIcon}" on msg ${quote.msgId}`);
    } catch (err) {
      console.error('[TGâ†’Zalo] Reaction error:', err);
    }
  });

  tgBot.on('message', async (ctx) => {
    try {
      const msg = ctx.message;
      // Only handle messages from our bridge group
      if (!canUseBridge(ctx)) { await rejectUnauthorized(ctx); return; }

      // Must originate from a topic (all bridged conversations live in topics)
      const topicId =
        'message_thread_id' in msg ? (msg.message_thread_id as number | undefined) : undefined;
      if (!topicId) return;

      // Zalo not connected yet
      if (!currentApi) {
        console.warn('[TGâ†’Zalo] currentApi is null â€“ Zalo not connected. Ignoring message.');
        return;
      }

      // Capture api reference so closures below always use the same instance
      const api = currentApi;

      // Look up the corresponding Zalo conversation
      const entry = store.getEntryByTopic(topicId);
      if (!entry) {
        console.warn(`[TGâ†’Zalo] No Zalo mapping for topicId=${topicId}`);
        return;
      }

      const { zaloId } = entry;
      // Ensure numeric value is correctly mapped to ThreadType enum at runtime
      const threadType: ThreadType = entry.type === 1 ? ThreadType.Group : ThreadType.User;

      // Helper: send TG error notification back to the same topic
      const notifyError = async (action: string, err: unknown) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        const code = (err as { code?: number }).code;
        console.error(`[TGâ†’Zalo] ${action} failed (zaloId=${zaloId}, type=${threadType}):`, err);

        // Provide a friendlier explanation for common Zalo error codes
        let hint = '';
        if (code === 114) {
          hint = threadType === ThreadType.User
            ? '\nðŸ’¡ <i>Zalo tá»« chá»‘i: chÆ°a káº¿t báº¡n hoáº·c ngÆ°á»i dÃ¹ng Ä‘Ã£ báº­t giá»›i háº¡n tin nháº¯n tá»« ngÆ°á»i láº¡.</i>'
            : '\nðŸ’¡ <i>Zalo tá»« chá»‘i tham sá»‘ (code 114).</i>';
        } else if (code === -216) {
          hint = '\nðŸ’¡ <i>PhiÃªn Ä‘Äƒng nháº­p Zalo háº¿t háº¡n. DÃ¹ng /login Ä‘á»ƒ Ä‘Äƒng nháº­p láº¡i.</i>';
        }

        await tgBot.telegram
          .sendMessage(
            config.telegram.groupId,
            `âš ï¸ Gá»­i tháº¥t báº¡i: <b>${action}</b>\n<code>${errMsg}${code != null ? ` (code ${code})` : ''}</code>${hint}`,
            { message_thread_id: topicId, parse_mode: 'HTML' },
          )
          .catch(() => undefined);
      };

      if ('text' in msg && msg.text) {
        // Skip bot commands that were already handled above
        if (msg.text.startsWith('/')) return;
        const socialVideoUrl = extractSocialVideoUrl(msg.text);
        if (socialVideoUrl) {
          let localPaths: string[] = [];
          const label = socialVideoLabel(socialVideoUrl);
          try {
            await enqueueSocialVideo(`tg:${threadType}:${zaloId}`, `${label}:telegram`, async () => {
            console.log(`[TG→Zalo][SocialVideo] Downloading ${label}: ${socialVideoUrl}`);
            localPaths = await downloadSocialVideo(socialVideoUrl);
            for (let i = 0; i < localPaths.length; i++) {
              const uploaded = await api.uploadAttachment(localPaths[i], zaloId, threadType) as Array<{
                fileUrl?: string;
                normalUrl?: string;
                hdUrl?: string;
                thumbUrl?: string;
              }>;
              console.log(`[TG→Zalo][SocialVideo] Upload result part ${i + 1}/${localPaths.length}:`, JSON.stringify(uploaded[0] ?? {}));
              const nativeVideoUrl = uploaded[0]?.fileUrl ?? uploaded[0]?.normalUrl ?? uploaded[0]?.hdUrl;
              const thumbnailUrl = uploaded[0]?.thumbUrl ?? nativeVideoUrl;
              if (!nativeVideoUrl || !thumbnailUrl) throw new Error('Missing videoUrl/thumbUrl from uploadAttachment');
              await api.sendVideo({
                videoUrl: nativeVideoUrl,
                thumbnailUrl,
                duration: 30_000,
                width: 720,
                height: 1280,
              }, zaloId, threadType);
              console.log(`[TG→Zalo][SocialVideo] Sent native video part ${i + 1}/${localPaths.length}`);
            }
            });
          } catch (err) {
            await notifyError('socialVideo', err);
          } finally {
            for (const lp of localPaths) await cleanTemp(lp);
          }
          return;
        }
        console.log(`[TGâ†’Zalo] sendMessage â†’ zaloId=${zaloId} type=${threadType} text="${msg.text.slice(0, 80)}"`);
        // Look up Zalo quote data if this TG message is a reply
        const replyToMsgId = msg.reply_to_message?.message_id;
        const zaloQuote = replyToMsgId !== undefined ? msgStore.getQuote(replyToMsgId) : undefined;

        const zaloMentions = resolveTgMentions(
          msg.text,
          ('entities' in msg ? msg.entities : undefined) as ReadonlyArray<TgEntity> | undefined,
          threadType === ThreadType.Group,
        );

        try {
          let sendResult = await api.sendMessage(
            {
              msg: msg.text,
              ...(zaloQuote ? { quote: zaloQuote } : {}),
              ...(zaloMentions.length ? { mentions: zaloMentions } : {}),
            },
            zaloId,
            threadType,
          ).catch(async (err: unknown) => {
            // Code 114 often means the quote data is incompatible (e.g. quoting
            // a media message whose content structure differs from what zca-js
            // expects). Retry without the quote so the text still goes through.
            if ((err as { code?: number }).code === 114 && zaloQuote) {
              console.warn('[TGâ†’Zalo] code 114 with quote, retrying without quote');
              return api.sendMessage(
                {
                  msg: msg.text,
                  ...(zaloMentions.length ? { mentions: zaloMentions } : {}),
                },
                zaloId,
                threadType,
              );
            }
            throw err;
          });
          const zaloMsgId = sendResult?.message?.msgId;
          if (zaloMsgId !== undefined) {
            sentMsgStore.save(msg.message_id, { msgId: zaloMsgId, zaloId, threadType });
          }
        } catch (err) {
          await notifyError('sendMessage', err);
        }
        return;
      }

      // helper: download TG file â†’ send via uploadAttachment â†’ cleanup
      const TG_FILE_LIMIT = 20 * 1024 * 1024; // 20 MB â€” Telegram Bot API hard limit
      const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
      const withRetry = async <T>(label: string, fn: () => Promise<T>, attempts = 5): Promise<T> => {
        let lastErr: unknown;
        for (let i = 1; i <= attempts; i++) {
          try { return await fn(); }
          catch (err) {
            lastErr = err;
            if (i === attempts) break;
            const delay = Math.min(5000, 500 * 2 ** (i - 1));
            console.warn(`[TGâ†’Zalo] ${label} failed (${i}/${attempts}), retrying in ${delay}ms:`, err);
            await sleep(delay);
          }
        }
        throw lastErr;
      };
      const getFileLinkWithRetry = (fileId: string): Promise<URL> => withRetry('getFileLink', () => ctx.telegram.getFileLink(fileId));
      const downloadToTempWithRetry = (url: string, filename: string) => withRetry('downloadToTemp', () => downloadToTemp(url, filename));
      const notifyTooBig = async (filename: string, sizeBytes?: number) => {
        const sizeMb = sizeBytes ? ` (${(sizeBytes / 1024 / 1024).toFixed(1)} MB)` : '';
        await notifyError(
          `sendAttachment(${filename})`,
          new Error(`File${sizeMb} vÆ°á»£t giá»›i háº¡n 20 MB cá»§a Telegram Bot API â€” khÃ´ng thá»ƒ táº£i xuá»‘ng`),
        );
      };

      const sendAttachment = async (
        fileId: string,
        filename: string,
        fileSize?: number,
        caption?: string,
        captionMentions?: Array<{ pos: number; uid: string; len: number }>,
      ) => {
        // Telegram Bot API cannot download files > 20 MB
        if (fileSize !== undefined && fileSize > TG_FILE_LIMIT) {
          await notifyTooBig(filename, fileSize);
          return;
        }
        // Pass Zalo quote if the TG message is a reply to a forwarded Zalo message
        const replyToMsgId = 'reply_to_message' in msg
          ? (msg as { reply_to_message?: { message_id: number } }).reply_to_message?.message_id
          : undefined;
        const zaloQuote = replyToMsgId !== undefined ? msgStore.getQuote(replyToMsgId) : undefined;
        let fileLink: URL;
        try {
          fileLink = await getFileLinkWithRetry(fileId);
        } catch (err: unknown) {
          const isTooBig = err instanceof Error && err.message.includes('file is too big');
          if (isTooBig) { await notifyTooBig(filename, fileSize); return; }
          throw err;
        }
        const localPath = await downloadToTempWithRetry(fileLink.toString(), filename);
        try {
          console.log(`[TGâ†’Zalo] Sending ${filename} â†’ zaloId=${zaloId} type=${threadType}`);
          const withTimeout = <T>(p: Promise<T>) => Promise.race([
            p,
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('Send timeout (30s)')), 30_000),
            ),
          ]);

          // zca-js splits internally when msg is non-empty + quote is set:
          //   1) sends caption+quote as text (reply indicator in Zalo)
          //   2) sends attachment without quote
          // When no caption, skip the quote â€” adding a placeholder text just to
          // carry the quote would create visible noise in the conversation.
          const effectiveCaption = caption ?? '';

          const sendResult = await withTimeout(api.sendMessage(
            {
              msg: effectiveCaption,
              attachments: [localPath],
              ...(effectiveCaption.length && zaloQuote ? { quote: zaloQuote } : {}),
              ...(captionMentions?.length ? { mentions: captionMentions } : {}),
            },
            zaloId,
            threadType,
          )).catch(async (err: unknown) => {
            // Code 114 with quote: quote data incompatible with this message type.
            // Retry without quote so the attachment still goes through.
            if ((err as { code?: number }).code === 114) {
              console.warn('[TGâ†’Zalo] code 114 on attachment+quote, retrying without quote');
              return withTimeout(api.sendMessage(
                {
                  msg: effectiveCaption,
                  attachments: [localPath],
                  ...(captionMentions?.length ? { mentions: captionMentions } : {}),
                },
                zaloId,
                threadType,
              ));
            }
            throw err;
          }) as { message?: { msgId?: number } | null; attachment?: Array<{ msgId?: number }> };

          const zaloMsgId = sendResult?.message?.msgId ?? sendResult?.attachment?.[0]?.msgId;
          if (zaloMsgId !== undefined) {
            sentMsgStore.save(msg.message_id, { msgId: zaloMsgId, zaloId, threadType });
          }
          console.log(`[TGâ†’Zalo] Send OK: ${filename}`);
        } catch (err) {
          await notifyError(`sendAttachment(${filename})`, err);
        } finally {
          await cleanTemp(localPath);
        }
      };

      // Helper: extract caption + resolved mentions from any media message
      const getCaptionMentions = () => {
        const cap = ('caption' in msg ? (msg as { caption?: string }).caption : undefined);
        const capEntities = ('caption_entities' in msg
          ? (msg as { caption_entities?: ReadonlyArray<TgEntity> }).caption_entities
          : undefined);
        const capMentions = cap
          ? resolveTgMentions(cap, capEntities, threadType === ThreadType.Group)
          : undefined;
        return { cap, capMentions };
      };

      // Helper: flush a media group â€” download all files and send as single Zalo message
      const flushMediaGroup = async (
        items: import('../store.js').MediaGroupItem[],
        meta: { topicId: number; zaloId: string; threadType: 0 | 1; replyToMsgId?: number },
      ) => {
        const replyMsgId = meta.replyToMsgId;
        const zaloQuote = replyMsgId !== undefined ? msgStore.getQuote(replyMsgId) : undefined;
        const caption = items[0]?.caption ?? '';
        const capMentions = items[0]?.captionMentions;
        const localPaths: string[] = [];
        try {
          for (const item of items) {
            if ((item.fileSize ?? 0) > 20 * 1024 * 1024) continue; // skip oversized
            let fileLink: URL;
            try { fileLink = await withRetry('getFileLink', () => tgBot.telegram.getFileLink(item.fileId)); }
            catch { continue; }
            localPaths.push(await downloadToTempWithRetry(fileLink.toString(), item.fname));
          }
          if (localPaths.length === 0) return;
          const sendResult = await api.sendMessage(
            {
              msg: caption,
              attachments: localPaths,
              ...(zaloQuote ? { quote: zaloQuote } : {}),
              ...(capMentions?.length ? { mentions: capMentions } : {}),
            },
            meta.zaloId,
            meta.threadType === 1 ? ThreadType.Group : ThreadType.User,
          );
          const zaloMsgId = sendResult?.message?.msgId ?? sendResult?.attachment?.[0]?.msgId;
          if (zaloMsgId !== undefined) {
            // We don't have a single tgMsgId here (multiple), just skip sentMsgStore
            console.log(`[TGâ†’Zalo] Media group sent: ${localPaths.length} files, zaloMsgId=${zaloMsgId}`);
          }
        } catch (err) {
          console.error('[TGâ†’Zalo] Media group send failed:', err);
        } finally {
          for (const lp of localPaths) await cleanTemp(lp);
        }
      };

      // Capture api reference for closures (already defined above but re-alias for flush closure)
      const _api = api;

      if ('photo' in msg && msg.photo && msg.photo.length > 0) {
        const photo = msg.photo[msg.photo.length - 1]!;
        const { cap, capMentions } = getCaptionMentions();
        const mediaGroupId = ('media_group_id' in msg ? (msg as { media_group_id?: string }).media_group_id : undefined);
        if (mediaGroupId) {
          const replyToMsgId = msg.reply_to_message?.message_id;
          mediaGroupStore.add(
            mediaGroupId,
            { fileId: photo.file_id, fname: 'photo.jpg', fileSize: photo.file_size, caption: cap, captionMentions: capMentions },
            { topicId, zaloId, threadType: entry.type, replyToMsgId },
            (items, meta) => { void flushMediaGroup(items, meta); },
          );
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          void _api; // keep reference
          return;
        }
        await sendAttachment(photo.file_id, 'photo.jpg', photo.file_size, cap, capMentions);
        return;
      }

      if ('animation' in msg && msg.animation) {
        const mime = msg.animation.mime_type ?? '';
        const ext = mime === 'video/mp4' ? '.mp4' : mime === 'image/gif' ? '.gif' : '.mp4';
        const fname = msg.animation.file_name ?? `animation_${Date.now()}${ext}`;
        const { cap, capMentions } = getCaptionMentions();
        await sendAttachment(msg.animation.file_id, fname, msg.animation.file_size, cap, capMentions);
        return;
      }

      if ('document' in msg && msg.document) {
        const doc   = msg.document;
        const fname = doc.file_name ?? `file_${Date.now()}.bin`;
        const { cap, capMentions } = getCaptionMentions();
        await sendAttachment(doc.file_id, fname, doc.file_size, cap, capMentions);
        return;
      }

      if ('video' in msg && msg.video) {
        const vid   = msg.video;
        const fname = vid.file_name ?? `video_${Date.now()}.mp4`;
        const { cap, capMentions } = getCaptionMentions();
        const mediaGroupId = ('media_group_id' in msg ? (msg as { media_group_id?: string }).media_group_id : undefined);
        if (mediaGroupId) {
          const replyToMsgId = msg.reply_to_message?.message_id;
          mediaGroupStore.add(
            mediaGroupId,
            { fileId: vid.file_id, fname, fileSize: vid.file_size, caption: cap, captionMentions: capMentions },
            { topicId, zaloId, threadType: entry.type, replyToMsgId },
            (items, meta) => { void flushMediaGroup(items, meta); },
          );
          return;
        }
        await sendAttachment(vid.file_id, fname, vid.file_size, cap, capMentions);
        return;
      }

      if ('voice' in msg && msg.voice) {
        // Telegram voice notes are always small (<1 min OGG Opus), well under 20 MB
        if ((msg.voice.file_size ?? 0) > TG_FILE_LIMIT) {
          await notifyTooBig(`voice_${Date.now()}.ogg`, msg.voice.file_size);
          return;
        }
        // Download OGG from TG, convert to M4A, upload to Zalo, send as voice bubble
        let fileLink: URL;
        try { fileLink = await getFileLinkWithRetry(msg.voice.file_id); }
        catch (err: unknown) {
          const isTooBig = err instanceof Error && err.message.includes('file is too big');
          if (isTooBig) { await notifyTooBig(`voice_${Date.now()}.ogg`, msg.voice.file_size); return; }
          throw err;
        }
        const oggPath  = await downloadToTempWithRetry(fileLink.toString(), `voice_${Date.now()}.ogg`);
        let m4aPath: string | undefined;
        try {
          m4aPath = await convertToM4a(oggPath);
          // Upload to Zalo CDN to get a voiceUrl
          const uploaded = await api.uploadAttachment(m4aPath, zaloId, threadType) as Array<{ fileUrl?: string }>;
          const voiceUrl = uploaded[0]?.fileUrl;
          if (!voiceUrl) throw new Error('No fileUrl from uploadAttachment');
          console.log(`[TGâ†’Zalo] Sending voice â†’ ${voiceUrl}`);
          await api.sendVoice({ voiceUrl }, zaloId, threadType);
          console.log(`[TGâ†’Zalo] Voice sent OK`);
        } catch (err) {
          console.error('[TGâ†’Zalo] Voice convert/send failed, falling back to file:', err);
          await sendAttachment(msg.voice.file_id, `voice_${Date.now()}.ogg`);
        } finally {
          await cleanTemp(oggPath);
          if (m4aPath) await cleanTemp(m4aPath);
        }
        return;
      }

      if ('sticker' in msg && msg.sticker) {
        const sticker = msg.sticker;
        console.log('[TGâ†’Zalo] Sticker meta:', JSON.stringify({
          emoji: sticker.emoji,
          set_name: sticker.set_name,
          is_animated: sticker.is_animated,
          is_video: sticker.is_video,
          mime_type: sticker.file_id ? undefined : undefined,
          file_size: sticker.file_size,
          width: sticker.width,
          height: sticker.height,
          has_thumbnail: Boolean(sticker.thumbnail),
        }));

        // Telegram video stickers are WEBM. Zalo treats WEBM poorly, so convert
        // to MP4 and upload as a video/document attachment to preserve motion.
        if (sticker.is_video) {
          if ((sticker.file_size ?? 0) > TG_FILE_LIMIT) {
            await notifyTooBig(`sticker_${Date.now()}.webm`, sticker.file_size);
            return;
          }
          let fileLink: URL;
          try { fileLink = await getFileLinkWithRetry(sticker.file_id); }
          catch (err: unknown) {
            const isTooBig = err instanceof Error && err.message.includes('file is too big');
            if (isTooBig) { await notifyTooBig(`sticker_${Date.now()}.webm`, sticker.file_size); return; }
            throw err;
          }
          const webmPath = await downloadToTempWithRetry(fileLink.toString(), `sticker_${Date.now()}.webm`);
          let mp4Path: string | undefined;
          try {
            mp4Path = await convertToMp4(webmPath);
            console.log(`[TGâ†’Zalo] Uploading video sticker MP4 â†’ zaloId=${zaloId} type=${threadType}`);
            const uploaded = await api.uploadAttachment(mp4Path, zaloId, threadType) as Array<{
              fileUrl?: string;
              normalUrl?: string;
              hdUrl?: string;
              thumbUrl?: string;
              fileName?: string;
            }>;
            console.log('[TGâ†’Zalo] Video sticker upload result:', JSON.stringify(uploaded[0] ?? {}));
            const videoUrl = uploaded[0]?.fileUrl ?? uploaded[0]?.normalUrl ?? uploaded[0]?.hdUrl;
            const thumbnailUrl = uploaded[0]?.thumbUrl ?? videoUrl;
            if (!videoUrl || !thumbnailUrl) throw new Error('Missing videoUrl/thumbUrl from uploadAttachment');
            const sendResult = await api.sendVideo(
              {
                videoUrl,
                thumbnailUrl,
                duration: 3000,
                width: sticker.width ?? 512,
                height: sticker.height ?? 512,
              },
              zaloId,
              threadType,
            ) as { msgId?: number };
            if (sendResult?.msgId !== undefined) {
              sentMsgStore.save(msg.message_id, { msgId: sendResult.msgId, zaloId, threadType });
            }
            console.log('[TGâ†’Zalo] Video sticker sent as native video OK');
          } catch (err) {
            console.error('[TGâ†’Zalo] Video sticker convert/send failed, falling back to thumbnail:', err);
            if (sticker.thumbnail) await sendAttachment(sticker.thumbnail.file_id, `sticker_${Date.now()}.jpg`);
            else await sendAttachment(sticker.file_id, `sticker_${Date.now()}.webm`, sticker.file_size);
          } finally {
            await cleanTemp(webmPath);
            if (mp4Path) await cleanTemp(mp4Path);
          }
          return;
        }

        // Telegram animated stickers are TGS/Lottie. Render to MP4 and send as
        // native Zalo video to preserve motion.
        if (sticker.is_animated) {
          if ((sticker.file_size ?? 0) > TG_FILE_LIMIT) {
            await notifyTooBig(`sticker_${Date.now()}.tgs`, sticker.file_size);
            return;
          }
          let fileLink: URL;
          try { fileLink = await getFileLinkWithRetry(sticker.file_id); }
          catch (err: unknown) {
            const isTooBig = err instanceof Error && err.message.includes('file is too big');
            if (isTooBig) { await notifyTooBig(`sticker_${Date.now()}.tgs`, sticker.file_size); return; }
            throw err;
          }
          const tgsPath = await downloadToTempWithRetry(fileLink.toString(), `sticker_${Date.now()}.tgs`);
          let mp4Path: string | undefined;
          try {
            mp4Path = await convertTgsToMp4(tgsPath);
            console.log(`[TGâ†’Zalo] Uploading animated sticker MP4 â†’ zaloId=${zaloId} type=${threadType}`);
            const uploaded = await api.uploadAttachment(mp4Path, zaloId, threadType) as Array<{
              fileUrl?: string;
              normalUrl?: string;
              hdUrl?: string;
              thumbUrl?: string;
            }>;
            console.log('[TGâ†’Zalo] Animated sticker upload result:', JSON.stringify(uploaded[0] ?? {}));
            const videoUrl = uploaded[0]?.fileUrl ?? uploaded[0]?.normalUrl ?? uploaded[0]?.hdUrl;
            const thumbnailUrl = uploaded[0]?.thumbUrl ?? videoUrl;
            if (!videoUrl || !thumbnailUrl) throw new Error('Missing videoUrl/thumbUrl from uploadAttachment');
            const sendResult = await api.sendVideo(
              {
                videoUrl,
                thumbnailUrl,
                duration: 3000,
                width: sticker.width ?? 512,
                height: sticker.height ?? 512,
              },
              zaloId,
              threadType,
            ) as { msgId?: number };
            if (sendResult?.msgId !== undefined) {
              sentMsgStore.save(msg.message_id, { msgId: sendResult.msgId, zaloId, threadType });
            }
            console.log('[TGâ†’Zalo] Animated sticker sent as native video OK');
          } catch (err) {
            console.error('[TGâ†’Zalo] Animated sticker render/send failed, falling back to thumbnail:', err);
            if (sticker.thumbnail) await sendAttachment(sticker.thumbnail.file_id, `sticker_${Date.now()}.jpg`);
            else await sendAttachment(sticker.file_id, `sticker_${Date.now()}.tgs`, sticker.file_size);
          } finally {
            await cleanTemp(tgsPath);
            if (mp4Path) await cleanTemp(mp4Path);
          }
          return;
        }

        await sendAttachment(sticker.file_id, `sticker_${Date.now()}.webp`, sticker.file_size);
        return;
      }

      if ('poll' in msg && msg.poll) {
        const tgPoll = msg.poll;
        console.log(`[TGâ†’Zalo] Received TG poll: id=${tgPoll.id} question="${tgPoll.question}" is_anonymous=${tgPoll.is_anonymous}`);

        if (threadType !== 1) {
          await ctx.reply('âŒ Chá»‰ táº¡o bÃ¬nh chá»n Ä‘Æ°á»£c trong nhÃ³m Zalo.', { message_thread_id: topicId });
          return;
        }

        try {
          // 1. Create poll on Zalo
          const created = await api.createPoll(
            {
              question:         tgPoll.question,
              options:          tgPoll.options.map((o: { text: string }) => o.text),
              isAnonymous:      false,   // force non-anonymous so poll_answer fires
              allowMultiChoices: tgPoll.allows_multiple_answers ?? false,
            },
            zaloId,
          );
          console.log(`[TGâ†’Zalo] Zalo poll created: pollId=${created?.poll_id}`);

          // 2. Bot re-creates the same poll on TG (non-anonymous so bot gets poll_answer)
          const botPollMsg = await tgBot.telegram.sendPoll(
            config.telegram.groupId,
            tgPoll.question,
            tgPoll.options.map((o: { text: string }) => o.text),
            {
              message_thread_id:       topicId,
              is_anonymous:            false,
              allows_multiple_answers: tgPoll.allows_multiple_answers ?? false,
            } as Parameters<typeof tgBot.telegram.sendPoll>[3],
          );
          const tgPollUUID = (botPollMsg as { poll?: { id?: string } }).poll?.id ?? '';
          console.log(`[TGâ†’Zalo] Bot TG poll sent: msgId=${botPollMsg.message_id} uuid=${tgPollUUID}`);

          // 3. Build option list from Zalo response
          const zaloPollOptions = created?.options ?? tgPoll.options.map((o: { text: string }, i: number) => ({
            option_id: i, content: o.text, votes: 0,
          }));

          // 4. Send score message below bot's poll
          const scoreLines = zaloPollOptions.map((o: { content: string }) =>
            `${o.content}\n  ${'â–‘'.repeat(10)} 0 phiáº¿u (0%)`,
          );
          const scoreText = `ðŸ“Š <b>Káº¿t quáº£ bÃ¬nh chá»n</b>\n<i>(táº¡o tá»« Telegram)</i>\n\nTá»•ng: 0 phiáº¿u\n\n${scoreLines.join('\n\n')}`;
          const lockPollId = created?.poll_id ?? 0;
          const tgScoreMsg = await tgBot.telegram.sendMessage(
            config.telegram.groupId,
            scoreText,
            {
              message_thread_id: topicId,
              parse_mode: 'HTML',
              reply_parameters: { message_id: botPollMsg.message_id, allow_sending_without_reply: true },
              reply_markup: {
                inline_keyboard: [[
                  { text: 'ðŸ”’ KhoÃ¡ bÃ¬nh chá»n', callback_data: `lock_poll:${lockPollId}` },
                ]],
              },
            },
          );

          // 5. Save to pollStore â€” keyed by both pollId and tgPollUUID
          if (created?.poll_id) {
            pollStore.save({
              pollId:           created.poll_id,
              zaloGroupId:      zaloId,
              tgPollMsgId:      botPollMsg.message_id,
              tgOrigPollMsgId:  msg.message_id,   // user's original poll
              tgPollUUID:       tgPollUUID,
              tgScoreMsgId:     tgScoreMsg.message_id,
              tgThreadId:       topicId,
              options: zaloPollOptions.map((o: { option_id?: number; content: string }, i: number) => ({
                option_id: o.option_id ?? i,
                content:   o.content,
              })),
            });
          }
        } catch (err) {
          console.error('[TGâ†’Zalo] createPoll failed:', err);
          await tgBot.telegram.sendMessage(
            config.telegram.groupId,
            'âŒ KhÃ´ng thá»ƒ táº¡o bÃ¬nh chá»n trÃªn Zalo.',
            { message_thread_id: topicId },
          );
        }
        return;
      }

      if ('location' in msg && msg.location) {
        const { latitude, longitude } = msg.location;
        const mapsUrl = `https://www.google.com/maps?q=${latitude},${longitude}`;
        try {
          // zca-js has no sendLocation â€” use sendLink for a map preview bubble in Zalo
          await api.sendLink(
            { msg: '', link: mapsUrl },
            zaloId,
            threadType,
          );
          console.log(`[TGâ†’Zalo] Location sent: ${latitude},${longitude}`);
        } catch (err) {
          // Fallback: send as plain text link
          await api.sendMessage({ msg: `ðŸ“ ${mapsUrl}` }, zaloId, threadType);
        }
        return;
      }

      if ('contact' in msg && msg.contact) {
        const contact = msg.contact as { phone_number: string; first_name: string; last_name?: string; user_id?: number };
        const fullName = [contact.first_name, contact.last_name].filter(Boolean).join(' ');
        // Try to send via sendCard if we can resolve the Zalo UID from the phone number
        // Fall back to sending contact info as a plain text message
        let cardSent = false;
        if (contact.user_id) {
          // TG user_id is not Zalo UID, skip sendCard attempt
        }
        if (!cardSent) {
          const body = `ðŸ‘¤ <b>Danh thiáº¿p</b>\nTÃªn: <b>${fullName}</b>\nSÄT: <code>${contact.phone_number}</code>`;
          try {
            await api.sendMessage({ msg: `ðŸ‘¤ ${fullName} â€” ${contact.phone_number}` }, zaloId, threadType);
          } catch (err) {
            await notifyError('sendContact', err);
          }
          // Also send formatted version on TG side as confirmation (just log)
          void body;
        }
        return;
      }
    } catch (err) {
      console.error('[TGâ†’Zalo] Error:', err);
    }
  });

  async function doLockPoll(entry: import('../store.js').PollEntry, api: ZaloAPI): Promise<void> {
    await api.lockPoll(entry.pollId);
    console.log(`[TGâ†’Zalo] Locked Zalo poll ${entry.pollId}`);
    // Stop bot's clone TG poll
    try {
      await tgBot.telegram.stopPoll(config.telegram.groupId, entry.tgPollMsgId);
    } catch { /* already stopped or no permission */ }
    // Stop original user poll too (if we have its message_id)
    if (entry.tgOrigPollMsgId) {
      try {
        await tgBot.telegram.stopPoll(config.telegram.groupId, entry.tgOrigPollMsgId);
      } catch { /* no admin rights or already stopped */ }
    }
    // Update score message: show [ÄÃ£ Ä‘Ã³ng], remove lock button
    try {
      const detail = await api.getPollDetail(entry.pollId);
      if (detail?.options) {
        const total = detail.options.reduce((s: number, o: { votes: number }) => s + (o.votes ?? 0), 0);
        const lines = (detail.options as Array<{ content: string; votes: number }>).map(o => {
          const pct = total > 0 ? Math.round((o.votes / total) * 100) : 0;
          const bar = 'â–ˆ'.repeat(Math.round(pct / 10)) + 'â–‘'.repeat(10 - Math.round(pct / 10));
          return `${o.content}\n  ${bar} ${o.votes} phiáº¿u (${pct}%)`;
        });
        const scoreText = `ðŸ“Š <b>Káº¿t quáº£ bÃ¬nh chá»n <i>[ÄÃ£ Ä‘Ã³ng]</i></b>\n\nTá»•ng: ${total} phiáº¿u\n\n${lines.join('\n\n')}`;
        try {
          await tgBot.telegram.editMessageText(
            config.telegram.groupId,
            entry.tgScoreMsgId,
            undefined,
            scoreText,
            { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } },
          );
        } catch { /* too old to edit */ }
      }
    } catch { /* non-fatal */ }
  }

  tgBot.on('poll', async (ctx) => {
    try {
      const poll = ctx.poll;
      if (!poll.is_closed) return;
      const entry = pollStore.getByTgPollUUID(poll.id);
      if (!entry || !currentApi) return;
      await doLockPoll(entry, currentApi);
    } catch (err) {
      console.error('[TGâ†’Zalo] lockPoll error:', err);
    }
  });

  tgBot.on('poll_answer', async (ctx) => {
    try {
      const answer = ctx.pollAnswer;
      // answer.option_ids: array of 0-based indices chosen in TG poll
      // answer.poll_id: TG internal poll ID (NOT the Zalo pollId)
      // We track by message_id via pollStore, but Telegraf poll_answer only has poll_id.
      // pollStore also indexes by tgPollMsgId. TG doesn't give us the message_id in poll_answer,
      // so we keep a secondary index by TG poll UUID in our store via a separate lookup.
      // Telegraf ctx.pollAnswer.poll_id is the TG poll identifier â€” we stored tgPollMsgId.
      // Workaround: iterate pollStore (small set) by checking tgPollUUID stored during creation.

      // Since we can only look up by tgPollMsgId but TG gives us poll_id (a string UUID),
      // we store the mapping tgPollUUID â†’ pollId when the poll is sent.
      const tgPollUUID = answer.poll_id;
      console.log(`[TGâ†’Zalo] poll_answer: poll_id=${tgPollUUID} option_ids=[${answer.option_ids}]`);
      const entry = pollStore.getByTgPollUUID(tgPollUUID);
      if (!entry) {
        console.log('[TGâ†’Zalo] poll_answer: unknown poll UUID', tgPollUUID);
        return;
      }

      if (!currentApi) return;
      const api = currentApi;

      // Map TG 0-based option indices â†’ Zalo option_ids
      const optionIds = answer.option_ids
        .map(idx => entry.options[idx]?.option_id)
        .filter((id): id is number => id !== undefined);

      // empty option_ids = user retracted vote â€” refresh score only, no Zalo call
      const refreshScore = async () => {
        try {
          const detail = await api.getPollDetail(entry.pollId);
          if (!detail?.options) return;
          const total = detail.options.reduce((s: number, o: { votes: number }) => s + (o.votes ?? 0), 0);
          const lines = (detail.options as Array<{ content: string; votes: number }>).map(o => {
            const pct = total > 0 ? Math.round((o.votes / total) * 100) : 0;
            const bar = 'â–ˆ'.repeat(Math.round(pct / 10)) + 'â–‘'.repeat(10 - Math.round(pct / 10));
            return `${o.content}\n  ${bar} ${o.votes} phiáº¿u (${pct}%)`;
          });
          const status = detail.closed ? ' <i>[ÄÃ£ Ä‘Ã³ng]</i>' : '';
          const scoreText = `ðŸ“Š <b>Káº¿t quáº£ bÃ¬nh chá»n${status}</b>\n\nTá»•ng: ${total} phiáº¿u\n\n${lines.join('\n\n')}`;
          const replyMarkup = detail.closed
            ? { inline_keyboard: [] as { text: string; callback_data: string }[][] }
            : { inline_keyboard: [[{ text: 'ðŸ”’ KhoÃ¡ bÃ¬nh chá»n', callback_data: `lock_poll:${entry.pollId}` }]] };
          try {
            await tgBot.telegram.editMessageText(
              config.telegram.groupId,
              entry.tgScoreMsgId,
              undefined,
              scoreText,
              { parse_mode: 'HTML', reply_markup: replyMarkup },
            );
          } catch {
            const newMsg = await tgBot.telegram.sendMessage(
              config.telegram.groupId,
              scoreText,
              { message_thread_id: entry.tgThreadId, parse_mode: 'HTML',
                reply_parameters: { message_id: entry.tgPollMsgId, allow_sending_without_reply: true },
                reply_markup: replyMarkup },
            );
            pollStore.updateScoreMsg(entry.pollId, newMsg.message_id);
          }
        } catch (e) {
          console.warn('[TGâ†’Zalo] poll score refresh failed:', e);
        }
      };

      if (optionIds.length === 0) {
        // Vote retracted â€” unvote on Zalo then refresh score
        try {
          await api.votePoll(entry.pollId, []);
          console.log(`[TGâ†’Zalo] Unvoted poll ${entry.pollId}`);
        } catch (e) {
          console.warn('[TGâ†’Zalo] unvote failed:', e);
        }
        await refreshScore();
        return;
      }

      // votePoll accepts single id or array
      await api.votePoll(entry.pollId, optionIds.length === 1 ? optionIds[0] : optionIds);
      console.log(`[TGâ†’Zalo] Voted poll ${entry.pollId} options [${optionIds}]`);

      // Immediately refresh score message
      await refreshScore();
    } catch (err) {
      console.error('[TGâ†’Zalo] poll_answer error:', err);
    }
  });

  return setCurrentApi;
}

// Called by setupTelegramHandler, but defined after so we can reference tgBot directly.



