import { ThreadType } from 'zca-js';
import { createReadStream } from 'fs';
import path from 'path';
import QRCode from 'qrcode';

import type { ZaloAPI, ZaloMessage, ZaloMediaContent, ZaloGroupInfoResponse } from './types.js';
import { ZALO_MSG_TYPES } from './types.js';
import { store } from '../store.js';
import { markHealth } from '../health.js';
import { tgBot } from '../telegram/bot.js';
import { config } from '../config.js';
import { downloadToTemp, cleanTemp, getVideoInfo } from '../utils/media.js';
import { extractSocialVideoUrl, enqueueSocialVideo, downloadSocialVideo, prepareTelegramVideoPaths, formatSocialVideoCaption } from '../utils/socialVideo.js';
import { beginSocialVideoJob, buildSocialVideoJobPartManifest, completeSocialVideoJob, createDurableSocialVideoJob, failSocialVideoJob, hasSocialVideoJobPartManifestMismatch, listReplayableSocialVideoJobs, markSocialVideoJobPartDone, setSocialVideoJobPartManifest, type DurableSocialVideoJob } from '../utils/durableSocialVideoQueue.js';
import { canAutoRepostSocialVideoTopic } from '../utils/socialVideoPolicy.js';
import { sendZaloVideoWithClientId } from '../utils/zaloSendVideoWithClientId.js';
import { applyMentionsHtml, formatGroupMsgHtml, formatGroupMsg, groupCaption, topicName, truncate, escapeHtml } from '../utils/format.js';
import { msgStore, userCache, pollStore, sentMsgStore, zaloAlbumStore, type ZaloQuoteData } from '../store.js';
import { resolveTopicDisplayName, type TopicProfile } from './topic.js';

// â”€â”€ Bank card HTML parser â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
interface BankCardInfo {
  bankName: string;
  accountNumber: string;
  holderName?: string;
  vietqr: string;
}


interface LinkMeta {
  finalUrl: string;
  title?: string;
  description?: string;
  image?: string;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function extractMeta(html: string, finalUrl: string): LinkMeta {
  const pick = (patterns: RegExp[]) => {
    for (const re of patterns) {
      const m = html.match(re);
      if (m?.[1]?.trim()) return decodeHtmlEntities(m[1].trim());
    }
    return undefined;
  };
  const title = pick([
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["'][^>]*>/i,
    /<title[^>]*>([^<]+)<\/title>/i,
  ]);
  const description = pick([
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["'][^>]*>/i,
  ]);
  const image = pick([
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["'][^>]*>/i,
  ]);
  return { finalUrl, title, description, image };
}

async function fetchLinkMeta(url: string): Promise<LinkMeta | null> {
  try {
    const resp = await fetch(url, {
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    const finalUrl = resp.url || url;
    const contentType = resp.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) return { finalUrl };
    const html = await resp.text();
    return extractMeta(html.slice(0, 300_000), finalUrl);
  } catch (err) {
    console.warn('[ZaloHandler] fetchLinkMeta failed:', err);
    return null;
  }
}

function parseBankCardHtml(html: string): BankCardInfo | null {
  const ptags = [...html.matchAll(/<p[^>]*>([^<]+)<\/p>/g)]
    .map(m => m[1].trim()).filter(t => t.length > 0);

  const normalised = html.replace(/&amp;/g, '&');
  const contentMatch = normalised.match(/content=([^&"< ]+)/);
  if (!contentMatch) return null;
  const vietqr = decodeURIComponent(contentMatch[1]);

  // p-tag order from Zalo HTML: [BIN, BankName, AccountNumber, HolderName?, ...]
  const numericTags = ptags.filter(t => /^\d+$/.test(t));
  const textTags    = ptags.filter(t => !/^\d+$/.test(t));

  const accountNumber = numericTags.find(t => t.length !== 6) ?? numericTags[1] ?? numericTags[0] ?? '';
  const bankName      = textTags[0] ?? '';
  const holderName    = textTags[1]?.trim() || undefined;

  if (!vietqr) return null;
  return { bankName, accountNumber, holderName, vietqr };
}

// â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Fetch group member list and populate `userCache` so mention resolution works
 * immediately even before any group message is received.
 */
async function populateGroupMemberCache(api: ZaloAPI, groupId: string): Promise<void> {
  try {
    const info = await api.getGroupInfo(groupId) as {
      gridInfoMap?: Record<string, {
        memVerList?: string[];
        totalMember?: number;
      }>;
    };
    const groupData = info?.gridInfoMap?.[groupId];
    if (!groupData) {
      console.warn(`[Zalo] getGroupInfo: no data for group ${groupId}`);
      return;
    }

    // memVerList entries are "uid_version" â€” extract UIDs
    const uids = (groupData.memVerList ?? [])
      .map(s => s.split('_')[0])
      .filter(Boolean);
    if (uids.length === 0) {
      console.warn(`[Zalo] group ${groupId}: empty memVerList (totalMember=${groupData.totalMember})`);
      return;
    }

    // Batch-fetch display names (getUserInfo accepts up to ~50 per call)
    const BATCH = 50;
    let saved = 0;
    for (let i = 0; i < uids.length; i += BATCH) {
      const batch = uids.slice(i, i + BATCH);
      const resp = await api.getUserInfo(batch) as {
        changed_profiles?: Record<string, { displayName?: string; zaloName?: string }>;
        unchanged_profiles?: Record<string, unknown>;
      };
      const profiles = resp?.changed_profiles ?? {};
      // unchanged_profiles also has profile data
      const unchanged = resp?.unchanged_profiles ?? {};
      for (const uid of batch) {
        const p = (profiles[uid] ?? unchanged[uid]) as { displayName?: string; zaloName?: string } | undefined;
        const name = p?.displayName?.trim() || p?.zaloName?.trim();
        if (uid && name) { userCache.save(uid, name); saved++; }
      }
    }
    console.log(`[Zalo] Cached ${saved}/${uids.length} members for group ${groupId}`);
  } catch (err) {
    console.warn(`[Zalo] populateGroupMemberCache failed for ${groupId}:`, err);
  }
}

async function getOrCreateTopic(
  zaloId: string,
  type: 0 | 1,
  displayName: string,
  avatarUrl?: string,
): Promise<number> {
  const existing = store.getTopicByZalo(zaloId, type);
  if (existing !== undefined) return existing;

  const name  = topicName(displayName, type);
  const color = type === ThreadType.Group ? 0xFF93B2 : 0x6FB9F0;

  const topic = await tgBot.telegram.createForumTopic(
    config.telegram.groupId,
    name,
    { icon_color: color },
  );

  const topicId = topic.message_thread_id;
  store.set({ topicId, zaloId, type, name: displayName });
  console.log(`[Zaloâ†’TG] New topic: "${name}" (topicId=${topicId})`);

  // Pin group avatar as the first message in the topic
  if (type === 1 /* Group */ && avatarUrl) {
    try {
      const localPath = await downloadToTemp(avatarUrl, `avatar_${Date.now()}.jpg`);
      const stream = createReadStream(localPath);
      const avatarMsg = await tgBot.telegram.sendPhoto(
        config.telegram.groupId,
        { source: stream },
        {
          message_thread_id: topicId,
          caption: `ðŸ–¼ áº¢nh Ä‘áº¡i diá»‡n nhÃ³m <b>${escapeHtml(displayName)}</b>`,
          parse_mode: 'HTML',
        },
      );
      await cleanTemp(localPath);
      try {
        await tgBot.telegram.pinChatMessage(config.telegram.groupId, avatarMsg.message_id, { disable_notification: true });
      } catch { /* pinning requires admin rights */ }
    } catch (avatarErr) {
      console.warn(`[Zaloâ†’TG] Failed to pin group avatar for ${displayName}:`, avatarErr);
    }
  }

  return topicId;
}

/**
 * Parse `content` field which is either a JSON string, a plain string, or
 * already an object. Returns a normalised `ZaloMediaContent` object.
 */
function parseContent(raw: string | ZaloMediaContent | Record<string, unknown>): {
  text: string | null;
  media: ZaloMediaContent;
} {
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as ZaloMediaContent;
      return { text: null, media: parsed };
    } catch {
      // plain text string
      return { text: raw, media: {} };
    }
  }
  return { text: null, media: raw as ZaloMediaContent };
}


function pickMediaUrl(media: ZaloMediaContent): string | undefined {
  const direct = media.href ?? (media as Record<string, unknown>).url ?? (media as Record<string, unknown>).fileUrl ??
    (media as Record<string, unknown>).normalUrl ?? (media as Record<string, unknown>).hdUrl ??
    (media as Record<string, unknown>).videoUrl;
  if (typeof direct === 'string' && direct.length > 0) return direct;
  if (!media.params) return undefined;
  try {
    const params = JSON.parse(media.params) as Record<string, unknown>;
    for (const key of ['hdUrl', 'videoUrl', 'fileUrl', 'normalUrl', 'url', 'href', 'downloadUrl', 'src']) {
      const value = params[key];
      if (typeof value === 'string' && value.length > 0) return value;
    }
  } catch { /* ignore */ }
  return undefined;
}

function shortContent(raw: unknown): string {
  try { return JSON.stringify(raw).slice(0, 800); }
  catch { return String(raw).slice(0, 800); }
}

// â”€â”€ Poll helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

import type { PollOptions } from 'zca-js';

function buildScoreText(header: string, options: Pick<PollOptions, 'content' | 'votes'>[], closed: boolean): string {
  const total = options.reduce((s, o) => s + (o.votes ?? 0), 0);
  const lines = options.map(o => {
    const pct = total > 0 ? Math.round((o.votes / total) * 100) : 0;
    const bar = 'â–ˆ'.repeat(Math.round(pct / 10)) + 'â–‘'.repeat(10 - Math.round(pct / 10));
    return `${escapeHtml(o.content)}\n  ${bar} ${o.votes} phiáº¿u (${pct}%)`;
  });
  const status = closed ? ' <i>[ÄÃ£ Ä‘Ã³ng]</i>' : '';
  return `ðŸ“Š <b>${escapeHtml(header)}</b>${status}\n\nTá»•ng: ${total} phiáº¿u\n\n${lines.join('\n\n')}`;
}

// â”€â”€ Main handler â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** Track which groups already had their member cache populated this session. */
const _memberCacheLoaded = new Set<string>();

export function setupZaloHandler(api: ZaloAPI): void {
  // Pre-populate userCache for all existing group topics on startup
  for (const entry of store.all()) {
    if (entry.type === 1 /* Group */) {
      void populateGroupMemberCache(api, entry.zaloId);
      _memberCacheLoaded.add(entry.zaloId);
    }
  }

  const queuedDurableZaloSocialVideoJobs = new Set<string>();
  const scheduledDurableZaloSocialVideoRetries = new Set<string>();
  const scheduleDurableZaloRetry = (job: DurableSocialVideoJob, delayMs: number): void => {
    if (scheduledDurableZaloSocialVideoRetries.has(job.id)) return;
    scheduledDurableZaloSocialVideoRetries.add(job.id);
    const timer = setTimeout(() => {
      scheduledDurableZaloSocialVideoRetries.delete(job.id);
      enqueueDurableZaloSocialVideoJob(job);
    }, delayMs);
    timer.unref?.();
  };
  const runDurableZaloSocialVideoJob = async (
    job: DurableSocialVideoJob,
    sendOptions: { message_thread_id: number; parse_mode: 'HTML'; caption?: string },
    saveMapping?: (sent: { message_id: number }) => void,
  ): Promise<void> => {
    const started = beginSocialVideoJob(job.id);
    if (!started || started.status === 'done' || started.status === 'failed') return;
    let localPaths: string[] = [];
    let downloadedPaths: string[] = [];
    try {
      console.log(`[Zalo→TG][SocialVideo] Downloading ${started.label}: ${started.url}`);
      const downloaded = await downloadSocialVideo(started.url);
      downloadedPaths = downloaded.paths;
      localPaths = await prepareTelegramVideoPaths(downloaded.paths);
      const currentManifest = await buildSocialVideoJobPartManifest(localPaths);
      if (hasSocialVideoJobPartManifestMismatch(started, currentManifest)) {
        throw new Error(`Durable social video part manifest mismatch for ${started.id}`);
      }
      setSocialVideoJobPartManifest(started.id, currentManifest);
      for (let i = 0; i < localPaths.length; i++) {
        if (started.sentParts?.[String(i)]) continue;
        const partPath = localPaths[i]!;
        const videoInfo = await getVideoInfo(partPath).catch(() => ({ durationMs: 30_000, width: 720, height: 1280 }));
        const partCaption = escapeHtml(formatSocialVideoCaption(downloaded.meta, localPaths.length > 1 ? `Part ${i + 1}/${localPaths.length}` : undefined));
        const sent = await tgBot.telegram.sendVideo(
          config.telegram.groupId,
          { source: createReadStream(partPath) },
          { ...sendOptions, caption: partCaption, duration: Math.round(videoInfo.durationMs / 1000), width: videoInfo.width, height: videoInfo.height },
        );
        saveMapping?.(sent);
        markSocialVideoJobPartDone(started.id, i, String(sent.message_id), sent);
        console.log(`[Zalo→TG][SocialVideo] Sent part ${i + 1}/${localPaths.length} msgId=${sent.message_id}`);
      }
      completeSocialVideoJob(started.id);
    } finally {
      for (const p of new Set([...downloadedPaths, ...localPaths])) await cleanTemp(p);
    }
  };
  const enqueueDurableZaloSocialVideoJob = (job: DurableSocialVideoJob, sendOptions?: { message_thread_id: number; parse_mode: 'HTML'; caption?: string }, saveMapping?: (sent: { message_id: number }) => void): void => {
    if (queuedDurableZaloSocialVideoJobs.has(job.id) || job.status === 'done' || job.status === 'failed') return;
    queuedDurableZaloSocialVideoJobs.add(job.id);
    void enqueueSocialVideo(`zalo:${job.threadType}:${job.zaloId}`, `${job.label}:zalo`, async () => {
      try {
        await runDurableZaloSocialVideoJob(job, sendOptions ?? { message_thread_id: job.topicId, parse_mode: 'HTML' }, saveMapping);
      } catch (err) {
        const failed = failSocialVideoJob(job.id, err);
        if (failed?.status === 'pending') {
          const delay = Math.min(60_000, 10_000 * Math.max(1, failed.attempts));
          console.warn(`[SocialVideo][Durable] retry ${failed.id} in ${delay}ms`);
          scheduleDurableZaloRetry(failed, delay);
          return;
        }
        if (failed) {
          console.error('[SocialVideo] Auto repost failed:', err);
          try { await api.sendMessage({ msg: 'Không tải được video từ link này.' }, failed.zaloId, failed.threadType); } catch { /* ignore */ }
        }
      }
    }, job.id).catch(err => {
      const failed = failSocialVideoJob(job.id, err);
      if (failed?.status === 'pending') scheduleDurableZaloRetry(failed, 30_000);
    }).finally(() => queuedDurableZaloSocialVideoJobs.delete(job.id));
  };
  const replayDurableZaloSocialVideoJobs = (): void => {
    const jobs = listReplayableSocialVideoJobs().filter(job => job.source === 'zalo' && job.target === 'telegram');
    if (jobs.length) console.log(`[SocialVideo][Durable] replaying ${jobs.length} Zalo→Telegram job(s)`);
    for (const job of jobs) enqueueDurableZaloSocialVideoJob(job);
  };
  replayDurableZaloSocialVideoJobs();
  api.listener.on('message', async (msg: ZaloMessage) => {

    try {
      if (msg.isSelf) {
        const ownMsgIds = [msg.data?.msgId, msg.data?.realMsgId]
          .filter((id): id is string => typeof id === 'string' && id.length > 0);
        if (ownMsgIds.some(id => sentMsgStore.getByZaloMsgId(id) !== undefined)) return;
      }

      const zaloId     = msg.threadId;
      const type       = msg.type as 0 | 1;
      const senderName = msg.data.dName?.trim() || msg.data.uidFrom || 'Zalo user';
      const msgType    = msg.data.msgType ?? ZALO_MSG_TYPES.TEXT;
      console.log('[Zalo?TG] Incoming:', JSON.stringify({ msgType, isSelf: msg.isSelf, uidFrom: msg.data.uidFrom, dName: msg.data.dName, msgId: msg.data.msgId, realMsgId: msg.data.realMsgId }));
      markHealth({ status: 'ok', lastZaloEventAt: new Date().toISOString() });

      // Pre-populate member cache the first time we see a new group
      if (type === 1 && !_memberCacheLoaded.has(zaloId)) {
        _memberCacheLoaded.add(zaloId);
        void populateGroupMemberCache(api, zaloId);
      }

      // Keep userCache up-to-date so TGâ†’Zalo mention resolution works
      userCache.save(msg.data.uidFrom, senderName);

      // Resolve conversation name. Self DM events carry logged-in account name in dName.
      let topicProfile: TopicProfile | undefined;
      if (type === ThreadType.User && store.getTopicByZalo(zaloId, type) === undefined) {
        try {
          const resp = await api.getUserInfo(zaloId) as {
            changed_profiles?: Record<string, TopicProfile>;
            unchanged_profiles?: Record<string, TopicProfile>;
          };
          topicProfile = resp?.changed_profiles?.[zaloId] ?? resp?.unchanged_profiles?.[zaloId];
        } catch { /* non-fatal; helper keeps self name out of topic */ }
      }

      let displayName = resolveTopicDisplayName({
        type,
        zaloId,
        senderName,
        isSelf: msg.isSelf,
        profile: topicProfile,
      });
      let groupAvatarUrl: string | undefined;
      if (type === ThreadType.Group) {
        try {
          const info = await api.getGroupInfo(zaloId) as ZaloGroupInfoResponse;
          displayName = info?.gridInfoMap?.[zaloId]?.name ?? senderName;
          groupAvatarUrl = info?.gridInfoMap?.[zaloId]?.avt;
        } catch { /* non-fatal */ }
      }

      const topicId = await getOrCreateTopic(zaloId, type, displayName, groupAvatarUrl);

      // Resolve Telegram reply target from incoming Zalo quote (if any)
      let tgReplyMsgId: number | undefined;
      if (msg.data.quote) {
        const globalId = String(msg.data.quote.globalMsgId);
        // Primary: messages received from Zalo and forwarded to TG
        // Fallback: messages we sent from TG to Zalo (reverse lookup)
        tgReplyMsgId = msgStore.getTgMsgId(globalId) ?? sentMsgStore.getByZaloMsgId(globalId);
      }

      // Base TG send options (with optional reply_parameters)
      const tgBase: {
        message_thread_id: number;
        reply_parameters?: { message_id: number; allow_sending_without_reply: boolean };
      } = { message_thread_id: topicId };
      if (tgReplyMsgId !== undefined) {
        tgBase.reply_parameters = { message_id: tgReplyMsgId, allow_sending_without_reply: true };
      }

      const caption = groupCaption(senderName);
      const tgOpts  = { ...tgBase, parse_mode: 'HTML' as const, caption };

      // Build quote data + mapping helper â€” saved after every successful TG send
      const zaloMsgIds = msg.data.realMsgId && msg.data.realMsgId !== msg.data.msgId
        ? [msg.data.msgId, msg.data.realMsgId]
        : [msg.data.msgId];
      const zaloQuoteData: ZaloQuoteData = {
        msgId:    msg.data.msgId,
        cliMsgId: msg.data.cliMsgId ?? '',
        uidFrom:  msg.data.uidFrom,
        ts:       msg.data.ts,
        msgType:  msgType,
        content:  msg.data.content as string | Record<string, unknown>,
        ttl:      msg.data.ttl ?? 0,
        zaloId,
        threadType: type,
      };
      const saveTgMapping = (sent: { message_id: number }) => {
        msgStore.save(sent.message_id, zaloMsgIds, zaloQuoteData);
      };

      const { text, media } = parseContent(msg.data.content);

      const maybeAutoRepostSocialVideo = (rawUrl: string | undefined, source: string) => {
        if (!rawUrl || !canAutoRepostSocialVideoTopic(topicId)) return;
        const videoUrl = extractSocialVideoUrl(rawUrl);
        if (!videoUrl) return;
        const job = createDurableSocialVideoJob({
          source: 'zalo',
          target: 'telegram',
          sourceMessageId: String(msg.data.realMsgId ?? msg.data.msgId),
          topicId,
          text: rawUrl,
          url: videoUrl,
          zaloId,
          threadType: type,
        });
        enqueueDurableZaloSocialVideoJob(job, tgOpts, saveTgMapping);
      };

      // â”€â”€ 1. Plain text â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      if (msgType === ZALO_MSG_TYPES.TEXT || (text !== null)) {
        const body = text ?? (typeof msg.data.content === 'string' ? msg.data.content : '');
        if (!body.trim()) return;
        if (msg.isSelf && sentMsgStore.consumePendingSelf(zaloId, type, body)) {
          console.log('[Zalo?TG] Skipped TG-origin self echo msgId=' + msg.data.msgId);
          return;
        }
        const mentions = msg.data.mentions;
        const bodyHtml = mentions?.length
          ? applyMentionsHtml(truncate(body), mentions)
          : escapeHtml(truncate(body));
        const tgText = formatGroupMsgHtml(senderName, bodyHtml);
        const sent = await tgBot.telegram.sendMessage(
          config.telegram.groupId,
          tgText,
          { ...tgBase, parse_mode: 'HTML' },
        );
        saveTgMapping(sent);
        console.log(`[Zalo?TG] Text sent OK msgId=${msg.data.msgId} tgMsgId=${sent.message_id}`);
        markHealth({ status: 'ok', lastZaloToTgSuccessAt: new Date().toISOString() });

        maybeAutoRepostSocialVideo(body, 'text');
        return;
      }

      // â”€â”€ 2. Photo / Image â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      if (msgType === ZALO_MSG_TYPES.PHOTO) {
        // prefer HD from params, fall back to href
        let url = media.href;
        if (media.params) {
          try {
            const p = JSON.parse(media.params) as { hd?: string };
            if (p.hd) url = p.hd;
          } catch { /* ignore */ }
        }
        if (!url) { console.warn('[ZaloHandler] Photo: no URL found in content:', media); return; }

        // Caption attached to the photo by the sender (Zalo stores it in description)
        const photoCaption = media.description?.trim() || undefined;

        const childnumber: number = (media as { childnumber?: number }).childnumber ?? 0;
        const albumKey = `${zaloId}:${msg.data.uidFrom}`;

        // If childnumber > 0 OR there's already a buffer for this key â†’ album mode
        const hasBuffer = (typeof zaloAlbumStore as unknown as { _has?: (k: string) => boolean })._has?.(albumKey);
        void hasBuffer; // unused, we detect via the add callback

        zaloAlbumStore.add(
          albumKey,
          url,
          zaloMsgIds[0],
          { senderName, topicId, tgBase, zaloQuote: zaloQuoteData },
          async (buf) => {
            if (buf.urls.length === 1) {
              // Single photo â€” send normally
              const singleUrl = buf.urls[0]!;
              const localPath = await downloadToTemp(singleUrl, `photo_${Date.now()}.jpg`);
              const stream = createReadStream(localPath);
              try {
                const sent = await tgBot.telegram.sendPhoto(
                  config.telegram.groupId,
                  { source: stream },
                  {
                    ...buf.tgBase,
                    parse_mode: 'HTML' as const,
                    caption: photoCaption
                      ? `${groupCaption(buf.senderName)}
${escapeHtml(photoCaption)}`
                      : groupCaption(buf.senderName),
                  },
                );
                markHealth({ status: 'ok', lastZaloToTgSuccessAt: new Date().toISOString() });
                msgStore.save(sent.message_id, buf.zaloMsgIds, {
                  msgId: buf.zaloMsgIds[0]!,
                  cliMsgId: '',
                  uidFrom: msg.data.uidFrom,
                  ts: msg.data.ts,
                  msgType,
                  content: msg.data.content as string | Record<string, unknown>,
                  ttl: msg.data.ttl ?? 0,
                  zaloId,
                  threadType: type,
                });
              } finally { await cleanTemp(localPath); }
            } else {
              // Multi-photo album â€” download all and send as media group
              const localPaths: string[] = [];
              try {
                for (const u of buf.urls) {
                  localPaths.push(await downloadToTemp(u, `photo_${Date.now()}.jpg`));
                }
                const captionText = photoCaption
                  ? `${groupCaption(buf.senderName)}
${escapeHtml(photoCaption)}`
                  : groupCaption(buf.senderName);
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const mediaItems: any[] = localPaths.map((lp, i) => ({
                  type: 'photo',
                  media: { source: createReadStream(lp) },
                  ...(i === 0 && captionText ? { caption: captionText, parse_mode: 'HTML' } : {}),
                }));
                const sentMsgs = await tgBot.telegram.sendMediaGroup(
                  config.telegram.groupId,
                  mediaItems,
                  { message_thread_id: buf.topicId } as Parameters<typeof tgBot.telegram.sendMediaGroup>[2],
                );
                // Save mapping for first photo (for reply chain)
                if (sentMsgs.length > 0) {
                  msgStore.save(sentMsgs[0]!.message_id, buf.zaloMsgIds, {
                    msgId: buf.zaloMsgIds[0]!,
                    cliMsgId: '',
                    uidFrom: msg.data.uidFrom,
                    ts: msg.data.ts,
                    msgType,
                    content: msg.data.content as string | Record<string, unknown>,
                    ttl: msg.data.ttl ?? 0,
                    zaloId,
                    threadType: type,
                  });
                }
              } finally {
                for (const lp of localPaths) await cleanTemp(lp);
              }
            }
          },
        );

        // Peek: if childnumber === 0 and no existing buffer, timer fires immediately
        // (actually always deferred 600ms â€” that's fine)
        return;
      }

      // â”€â”€ 2b. Doodle (sketch/drawing) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      if (msgType === ZALO_MSG_TYPES.DOODLE) {
        const url = media.href || media.thumb;
        if (!url) { console.warn('[ZaloHandler] Doodle: no URL'); return; }
        const localPath = await downloadToTemp(url, `doodle_${Date.now()}.jpg`);
        const stream = createReadStream(localPath);
        try {
          const sent = await tgBot.telegram.sendPhoto(config.telegram.groupId, { source: stream }, tgOpts);
          saveTgMapping(sent);
        } finally { await cleanTemp(localPath); }
        return;
      }


      if (msgType === ZALO_MSG_TYPES.GIF) {
        const url = media.href;
        if (!url) {
          console.warn('[ZaloHandler] GIF: no URL found in content:', media);
          return;
        }
        const ext = path.extname(url.split('?')[0] ?? '').toLowerCase() || '.mp4';
        const localPath = await downloadToTemp(url, `gif_${Date.now()}${ext}`);
        const stream = createReadStream(localPath);
        try {
          const sent = await tgBot.telegram.sendAnimation(
            config.telegram.groupId,
            { source: stream },
            tgOpts,
          );
          saveTgMapping(sent);
        } finally { await cleanTemp(localPath); }
        return;
      }

      // â”€â”€ 4. File â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      if (msgType === ZALO_MSG_TYPES.FILE) {
        const url = media.href;
        // title holds the original filename (e.g. "report.pdf")
        const fileName = media.title ?? `file_${Date.now()}`;
        if (!url) {
          console.warn('[ZaloHandler] File: no URL found in content:', media);
          return;
        }
        const localPath = await downloadToTemp(url, fileName);
        const stream = createReadStream(localPath);
        try {
          const sent = await tgBot.telegram.sendDocument(
            config.telegram.groupId,
            { source: stream, filename: fileName },
            tgOpts,
          );
          saveTgMapping(sent);
        } finally { await cleanTemp(localPath); }
        return;
      }

      // â”€â”€ 5. Video â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      if (msgType === ZALO_MSG_TYPES.VIDEO) {
        const url = pickMediaUrl(media);
        if (!url) { console.warn('[ZaloHandler] Video: no URL found in content:', shortContent(msg.data.content)); return; }
        const downloadedPath = await downloadToTemp(url, `video_${Date.now()}.mp4`);
        let localPaths: string[] = [];
        try {
          localPaths = await prepareTelegramVideoPaths([downloadedPath]);
          for (let i = 0; i < localPaths.length; i++) {
            const partPath = localPaths[i]!;
            const videoInfo = await getVideoInfo(partPath).catch(() => ({ durationMs: 30_000, width: 720, height: 1280 }));
            const partCaption = localPaths.length > 1 ? `Part ${i + 1}/${localPaths.length}` : undefined;
            const sent = await tgBot.telegram.sendVideo(config.telegram.groupId, { source: createReadStream(partPath) }, { ...tgOpts, ...(partCaption ? { caption: partCaption } : {}), duration: Math.round(videoInfo.durationMs / 1000), width: videoInfo.width, height: videoInfo.height });
            saveTgMapping(sent);
            console.log(`[Zalo→TG] Video sent part ${i + 1}/${localPaths.length} OK msgId=${sent.message_id}`);
          }
        } finally {
          for (const p of new Set([downloadedPath, ...localPaths])) await cleanTemp(p);
        }
        return;
      }

      // â”€â”€ 6. Voice â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      if (msgType === ZALO_MSG_TYPES.VOICE) {
        const url = media.href;
        if (!url) { console.warn('[ZaloHandler] Voice: no URL found in content:', media); return; }
        const ext = path.extname(url.split('?')[0] ?? '').toLowerCase() || '.m4a';
        const localPath = await downloadToTemp(url, `voice_${Date.now()}${ext}`);
        const stream = createReadStream(localPath);
        try {
          const sent = await tgBot.telegram.sendVoice(config.telegram.groupId, { source: stream }, tgOpts);
          saveTgMapping(sent);
        } finally { await cleanTemp(localPath); }
        return;
      }

      // â”€â”€ 7. Sticker â€“ fetch real URL via getStickersDetail â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      if (msgType === ZALO_MSG_TYPES.STICKER) {
        const stickerId = media.id;
        if (!stickerId) {
          console.warn('[ZaloHandler] Sticker: no id in content:', media);
          return;
        }
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const details: any[] = await api.getStickersDetail([stickerId]);
          const detail = details?.[0];
          const url: string | undefined =
            detail?.stickerWebpUrl ?? detail?.stickerUrl ?? detail?.stickerSpriteUrl;
          if (!url) {
            console.warn('[ZaloHandler] Sticker: no URL in detail:', detail);
            return;
          }
          const ext = path.extname(url.split('?')[0] ?? '').toLowerCase() || '.webp';
          const localPath = await downloadToTemp(url, `sticker_${Date.now()}${ext}`);
          try {
            let sent: { message_id: number };
            let nativeSticker = false;
            try {
              // Try native TG sticker (webp â‰¤512 KB displays as a proper sticker)
              const stream = createReadStream(localPath);
              sent = await tgBot.telegram.sendSticker(
                config.telegram.groupId,
                { source: stream },
                tgBase as Parameters<typeof tgBot.telegram.sendSticker>[2],
              );
              nativeSticker = true;
            } catch {
              // Fall back to photo if file is too large or format unsupported
              const stream = createReadStream(localPath);
              sent = await tgBot.telegram.sendPhoto(config.telegram.groupId, { source: stream }, tgOpts);
            }
            saveTgMapping(sent);
            if (nativeSticker) {
              try {
                await tgBot.telegram.sendMessage(
                  config.telegram.groupId,
                  groupCaption(senderName),
                  { ...tgBase, parse_mode: 'HTML' },
                );
              } catch (labelErr) {
                console.warn('[ZaloHandler] Sticker sender label failed:', labelErr);
              }
            }
          } finally { await cleanTemp(localPath); }
        } catch (stickerErr) {
          console.error('[ZaloHandler] Sticker fetch error:', stickerErr);
        }
        return;
      }

      // Link
      if (msgType === ZALO_MSG_TYPES.LINK) {
        const rawContent = typeof msg.data.content === 'string'
          ? msg.data.content
          : JSON.stringify(msg.data.content);
        const socialHref = extractSocialVideoUrl(rawContent);
        const href  = pickMediaUrl(media) ?? socialHref;
        const title = media.title ?? href;
        if (!href) {
          console.warn(`[ZaloHandler] Link: no URL msgId=${msg.data.msgId} content=${shortContent(msg.data.content)}`);
          return;
        }
        const safeHref = escapeHtml(href);
        const safeTitle = escapeHtml(title ?? href);
        const linkText = `${groupCaption(senderName)}\n<a href="${safeHref}">${safeTitle}</a>\n${safeHref}`;
        const sent = await tgBot.telegram.sendMessage(config.telegram.groupId, linkText, {
          ...tgBase,
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: false },
        });
        saveTgMapping(sent);
        maybeAutoRepostSocialVideo(socialHref ?? href, 'link');
        return;
      }

      // Web content (Zalo instant: bank card, mini app, etc.)
      if (msgType === ZALO_MSG_TYPES.WEBCONTENT) {
        // For bank cards: fetch HTML, parse data, send QR image + caption
        if (media.action === 'zinstant.bankcard' && media.params) {
          try {
            const parsedParams = JSON.parse(media.params) as {
              pcItem?: { data_url?: string };
              item?:   { data_url?: string };
            };
            const dataUrl = parsedParams.pcItem?.data_url ?? parsedParams.item?.data_url;
            if (dataUrl) {
              const htmlResp = await fetch(`${dataUrl}?data=html`);
              const html = await htmlResp.text();
              const info = parseBankCardHtml(html);
              if (info) {
                const qrBuf = await QRCode.toBuffer(info.vietqr, {
                  width: 300, margin: 2,
                  color: { dark: '#000000ff', light: '#ffffffff' },
                });
                let caption = `ðŸ¦ <b>TÃ i khoáº£n ngÃ¢n hÃ ng</b>`;
                if (info.bankName)      caption += `\nNgÃ¢n hÃ ng: <b>${info.bankName}</b>`;
                if (info.accountNumber) caption += `\nSTK: <code>${info.accountNumber}</code>`;
                if (info.holderName)    caption += `\nChá»§ TK: <b>${info.holderName}</b>`;
                const fullCaption = `${groupCaption(senderName)}\n${caption}`;
                const sent = await tgBot.telegram.sendPhoto(
                  config.telegram.groupId,
                  { source: qrBuf },
                  { ...tgBase, caption: fullCaption, parse_mode: 'HTML' },
                );
                saveTgMapping(sent);
                return;
              }
            }
          } catch (err) {
            console.error('[ZaloHandler] bankcard parse error:', err);
          }
        }

        // Generic webcontent fallback
        let label = media.title || '';
        try {
          if (media.params) {
            const p = JSON.parse(media.params) as {
              customMsg?: { msg?: { vi?: string; en?: string } };
            };
            const vi = p.customMsg?.msg?.vi;
            const en = p.customMsg?.msg?.en;
            if (vi && vi.trim()) label = vi.trim();
            else if (en && en.trim()) label = en.trim();
          }
        } catch { /* use fallback */ }
        if (!label) label = '[Ná»™i dung web]';

        const ACTION_ICONS: Record<string, string> = {
          'zinstant.bankcard': 'ðŸ¦',
          'zinstant.transfer': 'ðŸ’¸',
          'zinstant.invoice':  'ðŸ§¾',
          'zinstant.qr':       'ðŸ“·',
        };
        const icon = ACTION_ICONS[media.action ?? ''] ?? '📋';
        const href = media.href;
        if (!href) console.warn('[ZaloHandler] Webcontent has no href:', JSON.stringify({ action: media.action, title: media.title, params: media.params?.slice(0, 300) }));

        const meta = href ? await fetchLinkMeta(href) : null;
        const finalUrl = meta?.finalUrl ?? href;
        const displayTitle = meta?.title || label;
        const description = meta?.description;
        const lines = [
          `${icon} ${escapeHtml(displayTitle)}`,
          description ? escapeHtml(truncate(description, 500)) : undefined,
          finalUrl ? escapeHtml(finalUrl) : undefined,
        ].filter((v): v is string => Boolean(v));
        const caption = `${groupCaption(senderName)}\n${lines.join('\n')}`;

        if (meta?.image) {
          try {
            const localPath = await downloadToTemp(meta.image, `link_thumb_${Date.now()}.jpg`);
            try {
              const stream = createReadStream(localPath);
              const sent = await tgBot.telegram.sendPhoto(config.telegram.groupId, { source: stream }, {
                ...tgBase,
                caption,
                parse_mode: 'HTML',
              });
              saveTgMapping(sent);
              return;
            } finally { await cleanTemp(localPath); }
          } catch (err) {
            console.warn('[ZaloHandler] link thumbnail send failed:', err);
          }
        }

        const sent = await tgBot.telegram.sendMessage(config.telegram.groupId, caption, {
          ...tgBase,
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: false },
        });
        saveTgMapping(sent);
        maybeAutoRepostSocialVideo(
          extractSocialVideoUrl([
            href,
            media.description,
            media.params,
          ].filter((value): value is string => Boolean(value)).join('\n')),
          'webcontent',
        );
        return;
      }

      // â”€â”€ 10. Location â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      if (msgType === ZALO_MSG_TYPES.ECARD) {
        let params: Record<string, unknown> | undefined;
        try { params = media.params ? JSON.parse(media.params) as Record<string, unknown> : undefined; }
        catch { params = undefined; }

        const actionId = typeof params?.actionId === 'string' ? params.actionId : '';
        const isReminder = actionId.includes('reminder') || media.action === 'show.profile';
        const icon = isReminder ? '??' : '??';
        const title = media.title || (typeof params?.notifyTxt === 'string' ? params.notifyTxt : undefined) || 'Zalo card';
        const description = media.description || (typeof params?.previewTxt === 'string' ? params.previewTxt : undefined);
        const href = media.href;
        const lines = [
          `${icon} ${escapeHtml(title)}`,
          description ? escapeHtml(description) : undefined,
          href ? escapeHtml(href) : undefined,
        ].filter((v): v is string => Boolean(v));
          const caption = `${groupCaption(senderName)}\n${lines.join('\n')}`;

        if (media.thumb || media.href) {
          const imageUrl = media.thumb || media.href;
          try {
            const localPath = await downloadToTemp(imageUrl!, `ecard_${Date.now()}.jpg`);
            try {
              const stream = createReadStream(localPath);
              const sent = await tgBot.telegram.sendPhoto(config.telegram.groupId, { source: stream }, {
                ...tgBase,
                caption,
                parse_mode: 'HTML',
              });
              saveTgMapping(sent);
              return;
            } finally { await cleanTemp(localPath); }
          } catch (err) {
            console.warn('[ZaloHandler] ecard thumbnail send failed:', err);
          }
        }

        const sent = await tgBot.telegram.sendMessage(config.telegram.groupId, caption, {
          ...tgBase,
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: false },
        });
        saveTgMapping(sent);
        return;
      }

      if (msgType === ZALO_MSG_TYPES.LOCATION) {
        let lat: number | undefined;
        let lng: number | undefined;
        try {
          const p = JSON.parse(media.params ?? '{}') as { latitude?: number; longitude?: number };
          lat = p.latitude;
          lng = p.longitude;
        } catch { /* ignore */ }

        if (lat !== undefined && lng !== undefined) {
          // Send as native TG location â€” shows map preview with Maps button
          const sent = await tgBot.telegram.sendLocation(
            config.telegram.groupId,
            lat,
            lng,
            { ...tgBase } as Parameters<typeof tgBot.telegram.sendLocation>[3],
          );
          if (type === ThreadType.Group || type === ThreadType.User) {
            // Send sender name as a follow-up caption since sendLocation has no HTML caption
            await tgBot.telegram.sendMessage(
              config.telegram.groupId,
              `${groupCaption(senderName)}ðŸ“ Vá»‹ trÃ­`,
              { ...tgBase, parse_mode: 'HTML' },
            );
          }
          saveTgMapping(sent);
        } else {
          // Fallback: Google Maps link
          const mapsUrl = media.href || '#';
          const body    = `ðŸ“ <a href="${mapsUrl}">Vá»‹ trÃ­</a>`;
          const text    = `${groupCaption(senderName)}\n${body}`;
          const sent    = await tgBot.telegram.sendMessage(config.telegram.groupId, text, { ...tgBase, parse_mode: 'HTML' });
          saveTgMapping(sent);
        }
        return;
      }

      // â”€â”€ 11. Poll â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      if (msgType === ZALO_MSG_TYPES.POLL) {
        let pollId: number | undefined;
        let question = '';
        let isAnonymous = false;
        let action = '';
        try {
          const p = JSON.parse(media.params ?? '{}') as {
            pollId?: number;
            question?: string;
            isAnonymous?: boolean;
            action?: string;
          };
          pollId      = p.pollId;
          question    = p.question ?? '';
          isAnonymous = p.isAnonymous ?? false;
          action      = media.action ?? '';
        } catch { /* ignore */ }

        console.log(`[ZaloHandler] Poll event: action="${action}" pollId=${pollId}`);

        if (!pollId) return;

        // Fetch full poll details (options + vote counts)
        let pollDetail: Awaited<ReturnType<typeof api.getPollDetail>> | undefined;
        try {
          pollDetail = await api.getPollDetail(pollId);
          console.log(`[ZaloHandler] Poll detail: num_vote=${pollDetail?.num_vote} options=`, pollDetail?.options?.map((o: { content: string; votes: number }) => `${o.content}=${o.votes}`).join(','));
        } catch (e) {
          console.warn('[ZaloHandler] getPollDetail failed:', e);
        }

        const existingEntry = pollStore.getByPollId(pollId);
        console.log(`[ZaloHandler] Poll existingEntry=${existingEntry ? 'found' : 'NOT found'}`);
        type ZaloPollOption = { option_id: number; content: string; votes: number; voted: boolean; voters: string[] };

        if (action === 'create' && !existingEntry) {
          const options: ZaloPollOption[] = pollDetail?.options ?? [];
          if (options.length < 2) {
            // Can't create TG poll with < 2 options, send as text
            const text = type === ThreadType.Group || type === ThreadType.User
              ? `${groupCaption(senderName)}ðŸ“Š <b>${escapeHtml(question)}</b>\n<i>Cuá»™c bÃ¬nh chá»n má»›i (${options.length} lá»±a chá»n)</i>`
              : `ðŸ“Š <b>${escapeHtml(question)}</b>`;
            const sent = await tgBot.telegram.sendMessage(config.telegram.groupId, text, { ...tgBase, parse_mode: 'HTML' });
            saveTgMapping(sent);
            return;
          }

          const header = type === ThreadType.Group || type === ThreadType.User
            ? `${senderName} táº¡o bÃ¬nh chá»n`
            : 'BÃ¬nh chá»n má»›i';

          const tgPollMsg = await tgBot.telegram.sendPoll(
            config.telegram.groupId,
            question,
            options.map(o => o.content),
            {
              ...tgBase,
              is_anonymous:        isAnonymous,
              allows_multiple_answers: pollDetail?.allow_multi_choices ?? false,
              question_parse_mode: undefined,
            } as Parameters<typeof tgBot.telegram.sendPoll>[3],
          );

          // Send editable score message below
          const scoreText = buildScoreText(header, pollDetail?.options ?? [], pollDetail?.closed ?? false);
          const tgScoreMsg = await tgBot.telegram.sendMessage(
            config.telegram.groupId,
            scoreText,
            { message_thread_id: topicId, parse_mode: 'HTML' },
          );

          pollStore.save({
            pollId,
            zaloGroupId:  zaloId,
            tgPollMsgId:  tgPollMsg.message_id,
            tgPollUUID:   (tgPollMsg as { poll?: { id?: string } }).poll?.id ?? '',
            tgScoreMsgId: tgScoreMsg.message_id,
            tgThreadId:   topicId,
            options: options.map(o => ({ option_id: o.option_id, content: o.content })),
          });
          saveTgMapping(tgPollMsg);
        } else {
          // â”€â”€ Vote update (or unknown existing poll after restart) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
          // Small delay so Zalo server has time to record the vote before we fetch
          await new Promise(r => setTimeout(r, 800));
          let updatedDetail = pollDetail;
          try { updatedDetail = await api.getPollDetail(pollId); } catch { /* use existing */ }
          const header = type === ThreadType.Group || type === ThreadType.User
            ? `${senderName} vá»«a bÃ¬nh chá»n`
            : 'Cáº­p nháº­t bÃ¬nh chá»n';
          const detailOptions = updatedDetail?.options ?? [];
          const scoreText = buildScoreText(
            header,
            detailOptions.length > 0 ? detailOptions : (existingEntry?.options.map(o => ({ ...o, votes: 0, voted: false, voters: [] })) ?? []),
            updatedDetail?.closed ?? false,
          );
          console.log(`[ZaloHandler] Poll ${pollId} score:`, detailOptions.map((o: { content: string; votes: number }) => `${o.content}=${o.votes}`).join(', '));

          if (existingEntry) {
            try {
              await tgBot.telegram.editMessageText(
                config.telegram.groupId,
                existingEntry.tgScoreMsgId,
                undefined,
                scoreText,
                {
                  parse_mode: 'HTML',
                  reply_markup: updatedDetail?.closed
                    ? { inline_keyboard: [] }
                    : { inline_keyboard: [[{ text: 'ðŸ”’ KhoÃ¡ bÃ¬nh chá»n', callback_data: `lock_poll:${pollId}` }]] },
                },
              );
              console.log(`[ZaloHandler] Poll ${pollId} score message edited OK`);
            } catch (editErr) {
              console.warn(`[ZaloHandler] Poll ${pollId} edit failed, sending new:`, editErr);
              const newScore = await tgBot.telegram.sendMessage(
                config.telegram.groupId,
                scoreText,
                { message_thread_id: existingEntry.tgThreadId, parse_mode: 'HTML',
                  reply_parameters: { message_id: existingEntry.tgPollMsgId, allow_sending_without_reply: true } },
              );
              pollStore.updateScoreMsg(pollId, newScore.message_id);
            }
          } else {
            // existingEntry lost (bot restarted) â€” just send score as standalone message
            const sent = await tgBot.telegram.sendMessage(
              config.telegram.groupId,
              scoreText,
              { ...tgBase, parse_mode: 'HTML' },
            );
            saveTgMapping(sent);
          }
        }
        return;
      }

      // â”€â”€ Fallback â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      // Before fallback: detect contact card by content shape (contactUid field)
      // Zalo sends contact cards as msgType 'chat.forward' with contactUid in content
      {
        const rawContent = msg.data.content;
        const contactUid: string | undefined =
          (typeof rawContent === 'object' && rawContent !== null && 'contactUid' in rawContent)
            ? String((rawContent as Record<string, unknown>).contactUid)
            : (media.contactUid ? String(media.contactUid) : undefined);

        if (contactUid || msgType === ZALO_MSG_TYPES.CONTACT) {
          const uid = contactUid ?? '';
          // Fetch display name from userCache or API
          let contactName = userCache.getName(uid) ?? uid;
          if (uid && contactName === uid) {
            try {
              const resp = await api.getUserInfo(uid) as {
                changed_profiles?: Record<string, { displayName?: string }>;
              };
              contactName = resp?.changed_profiles?.[uid]?.displayName ?? uid;
              if (contactName !== uid) userCache.save(uid, contactName);
            } catch { /* non-fatal */ }
          }
          const qrUrl: string | undefined =
            (typeof rawContent === 'object' && rawContent !== null && 'qrCodeUrl' in rawContent)
              ? String((rawContent as Record<string, unknown>).qrCodeUrl)
              : media.qrCodeUrl;

          const body = `ðŸ‘¤ <b>Danh thiáº¿p</b>\nTÃªn: <b>${escapeHtml(contactName)}</b>\nZalo ID: <code>${uid}</code>`;
          const fullText = `${groupCaption(senderName)}\n${body}`;

          if (qrUrl) {
            // Send QR code image + caption
            try {
              const localPath = await downloadToTemp(qrUrl, `qr_${Date.now()}.jpg`);
              const stream = createReadStream(localPath);
              const sent = await tgBot.telegram.sendPhoto(
                config.telegram.groupId,
                { source: stream },
                { ...tgBase, caption: fullText, parse_mode: 'HTML' },
              );
              saveTgMapping(sent);
              await cleanTemp(localPath);
            } catch {
              const sent = await tgBot.telegram.sendMessage(config.telegram.groupId, fullText, { ...tgBase, parse_mode: 'HTML' });
              saveTgMapping(sent);
            }
          } else {
            const sent = await tgBot.telegram.sendMessage(config.telegram.groupId, fullText, { ...tgBase, parse_mode: 'HTML' });
            saveTgMapping(sent);
          }
          return;
        }
      }

      console.log(`[ZaloHandler] Unhandled msgType="${msgType}" content:`, JSON.stringify(msg.data.content));
      const fallback = `${groupCaption(senderName)}\n<i>[${msgType}]</i>`;
      const sentFallback = await tgBot.telegram.sendMessage(config.telegram.groupId, fallback, {
        ...tgBase,
        parse_mode: 'HTML',
      });
      saveTgMapping(sentFallback);
    } catch (err) {
      console.error('[ZaloHandler] Error:', err);
    }
  });

  // â”€â”€ Undo (thu há»“i tin nháº¯n) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api.listener.on('undo', async (undo: any) => {
    try {
      const data = undo?.data;
      // The recalled Zalo message ID
      const zaloMsgId = String(data?.content?.globalMsgId ?? data?.msgId ?? '');
      if (!zaloMsgId) return;

      const tgMsgId = msgStore.getTgMsgId(zaloMsgId) ?? sentMsgStore.getByZaloMsgId(zaloMsgId);
      if (tgMsgId === undefined) {
        console.log(`[ZaloHandler] Undo: no TG mapping for zaloMsgId=${zaloMsgId}`);
        return;
      }

      // Find which topic this message belongs to
      const zaloId = undo?.threadId ?? data?.idTo;
      const type   = (undo?.isGroup ? 1 : 0) as 0 | 1;
      const topicId = store.getTopicByZalo(String(zaloId), type);
      if (topicId === undefined) return;

      // Delete the forwarded TG message
      await tgBot.telegram.deleteMessage(config.telegram.groupId, tgMsgId);
      console.log(`[ZaloHandler] Undo: deleted TG msg ${tgMsgId} (zaloMsgId=${zaloMsgId})`);

      // Notify in topic
      await tgBot.telegram.sendMessage(
        config.telegram.groupId,
        `<i>🗑 Tin nhắn đã được thu hồi</i>`,
        { message_thread_id: topicId, parse_mode: 'HTML' },
      );
    } catch (err) {
      console.error('[ZaloHandler] Undo error:', err);
    }
  });

  // â”€â”€ Reaction (cáº£m xÃºc) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const REACTION_EMOJI: Record<string, string> = {
    '/-heart':   '\u2764\ufe0f',
    '/-strong':  '\ud83d\udc4d',
    ':>':        '\ud83d\ude04',
    ':o':        '\ud83d\ude2e',
    ':-(( ':     '\ud83d\ude22',
    ':-((':      '\ud83d\ude22',
    ':-h':       '\ud83d\ude21',
    ':-*':       '\ud83d\ude18',
    ":')":       '\ud83d\ude02',
    '/-shit':    '\ud83d\udca9',
    '/-rose':    '\ud83c\udf39',
    '/-break':   '\ud83d\udc94',
    '/-weak':    '\ud83d\udc4e',
    ';xx':       '\ud83e\udd70',
    ';-/':       '\ud83d\ude15',
    ';-)':       '\ud83d\ude09',
    '/-fade':    '\u2728',
    '/-ok':      '\ud83d\udc4c',
    '/-v':       '\u270c\ufe0f',
    '/-thanks':  '\ud83d\ude4f',
    '/-punch':   '\ud83d\udc4a',
    '/-no':      '\ud83d\ude45',
    '/-loveu':   '\ud83e\udd1f',
    '--b':       '\ud83d\ude1e',
    ':((':       '\ud83d\ude2d',
    'x-)':       '\ud83d\ude0e',
    '_()_':      '\ud83d\ude4f',
    '/-bd':      '\ud83c\udf82',
    '/-bome':    '\ud83d\udca3',
    '/-beer':    '\ud83c\udf7a',
    '/-li':      '\u2600\ufe0f',
    '/-share':   '\ud83d\udd01',
    '/-bad':     '\ud83d\ude24',
    '':          '\u274c',
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api.listener.on('reaction', async (reaction: any) => {
    return;
    try {
      const data = reaction?.data;
      const rIcon: string = data?.content?.rIcon ?? '';
      const emoji = REACTION_EMOJI[rIcon] ?? '💬';

      // If empty reaction icon â†’ user removed reaction; skip notification
      if (!rIcon) return;

      const gMsgIds: Array<{ gMsgID?: string | number }> = data?.content?.rMsg ?? [];
      const zaloMsgId = String(gMsgIds[0]?.gMsgID ?? '');
      if (!zaloMsgId) {
        console.warn('[ZaloHandler] Reaction skipped: missing zaloMsgId', JSON.stringify(data?.content ?? {}));
        return;
      }

      const zaloId = reaction?.threadId ?? data?.idTo;
      const type   = (reaction?.isGroup ? 1 : 0) as 0 | 1;
      const topicId = store.getTopicByZalo(String(zaloId), type);
      if (topicId === undefined) {
        console.warn(`[ZaloHandler] Reaction skipped: no topic for zaloId=${zaloId} type=${type}`);
        return;
      }

      const tgMsgId = msgStore.getTgMsgId(zaloMsgId) ?? sentMsgStore.getByZaloMsgId(zaloMsgId);
      const dName = data?.dName ?? data?.uidFrom ?? 'ai đó';
      const text = tgMsgId === undefined
        ? `${emoji} <b>${escapeHtml(dName)}</b> reacted to a message`
        : `${emoji} <b>${escapeHtml(dName)}</b>`;

      if (tgMsgId === undefined) {
        console.warn(`[ZaloHandler] Reaction fallback: no TG mapping for zaloMsgId=${zaloMsgId}`);
        await tgBot.telegram.sendMessage(
          config.telegram.groupId,
          text,
          { message_thread_id: topicId, parse_mode: 'HTML' },
        );
        return;
      }

      // Send reaction emoji as a reply to the forwarded TG message
      await tgBot.telegram.sendMessage(
        config.telegram.groupId,
        text,
        {
          message_thread_id: topicId,
          parse_mode: 'HTML',
          reply_parameters: { message_id: tgMsgId!, allow_sending_without_reply: true },
        },
      );
    } catch (err) {
      console.error('[ZaloHandler] Reaction error:', err);
    }
  });

  // â”€â”€ Group events (vÃ o/rá»i nhÃ³m) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api.listener.on('group_event', async (event: any) => {
    try {
      const type    = event?.type as string | undefined;
      const data    = event?.data;
      const groupId = String(event?.threadId ?? data?.groupId ?? '');
      if (!groupId) return;

      // â”€â”€ Poll vote: UPDATE_BOARD with BoardType.Poll â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      if (type === 'update_board' || type === 'remove_board') {
        // groupTopic.params is a JSON string containing poll info
        const rawParams = data?.groupTopic?.params ?? data?.topic?.params ?? '';
        let params: { boardType?: number; pollId?: number } = {};
        try { params = JSON.parse(rawParams); } catch { /* ignore */ }
        // BoardType.Poll = 3
        if (params.boardType === 3 && params.pollId) {
          const pollId = params.pollId;
          console.log(`[ZaloHandler] group_event update_board pollId=${pollId}`);
          const entry = pollStore.getByPollId(pollId);
          if (entry) {
            await new Promise(r => setTimeout(r, 600));
            let detail: Awaited<ReturnType<typeof api.getPollDetail>> | undefined;
            try { detail = await api.getPollDetail(pollId); } catch { /* ignore */ }
            if (detail?.options) {
              const actorName = data?.updateMembers?.[0]?.dName ?? data?.creatorId ?? '';
              const header = actorName ? `${actorName} vá»«a bÃ¬nh chá»n` : 'Cáº­p nháº­t bÃ¬nh chá»n';
              const scoreText = buildScoreText(header, detail.options, detail.closed ?? false);
              console.log(`[ZaloHandler] Poll ${pollId} update:`, detail.options.map((o: { content: string; votes: number }) => `${o.content}=${o.votes}`).join(', '));
              try {
                await tgBot.telegram.editMessageText(
                  config.telegram.groupId,
                  entry.tgScoreMsgId,
                  undefined,
                  scoreText,
                  {
                    parse_mode: 'HTML',
                    reply_markup: detail.closed
                      ? { inline_keyboard: [] }
                      : { inline_keyboard: [[{ text: 'ðŸ”’ KhoÃ¡ bÃ¬nh chá»n', callback_data: `lock_poll:${pollId}` }]] },
                  },
                );
              } catch {
                const newScore = await tgBot.telegram.sendMessage(
                  config.telegram.groupId,
                  scoreText,
                  { message_thread_id: entry.tgThreadId, parse_mode: 'HTML',
                    reply_parameters: { message_id: entry.tgPollMsgId, allow_sending_without_reply: true },
                    reply_markup: detail.closed
                      ? { inline_keyboard: [] }
                      : { inline_keyboard: [[{ text: 'ðŸ”’ KhoÃ¡ bÃ¬nh chá»n', callback_data: `lock_poll:${pollId}` }]] } },
                );
                pollStore.updateScoreMsg(pollId, newScore.message_id);
              }
            }
          } else {
            console.log(`[ZaloHandler] update_board pollId=${pollId} not in pollStore (no TG mapping)`);
          }
        }
        return;
      }

      // Only notify for join/leave/remove â€” skip setting changes, pins, etc.
      const NOTIFY_TYPES = new Set(['join', 'leave', 'remove_member', 'block_member']);
      if (!type || !NOTIFY_TYPES.has(type)) return;

      const topicId = store.getTopicByZalo(groupId, 1 /* Group */);
      if (topicId === undefined) return;

      const members: Array<{ dName?: string }> = data?.updateMembers ?? [];
      const names = members.map(m => m.dName ?? '?').join(', ');
      const actor  = data?.creatorId === data?.sourceId ? '' : '';  // unused for now
      void actor;

      let notifText = '';
      if (type === 'join') {
        notifText = `\u2795 <b>${escapeHtml(names)}</b> \u0111\u00e3 tham gia nh\u00f3m`;
      } else if (type === 'leave') {
        notifText = `\u2796 <b>${escapeHtml(names)}</b> \u0111\u00e3 r\u1eddi nh\u00f3m`;
      } else if (type === 'remove_member') {
        notifText = `\ud83d\udeab <b>${escapeHtml(names)}</b> \u0111\u00e3 b\u1ecb x\u00f3a kh\u1ecfi nh\u00f3m`;
      } else if (type === 'block_member') {
        notifText = `\ud83d\udd12 <b>${escapeHtml(names)}</b> \u0111\u00e3 b\u1ecb ch\u1eb7n kh\u1ecfi nh\u00f3m`;
      }

      if (!notifText) return;

      await tgBot.telegram.sendMessage(
        config.telegram.groupId,
        `<i>${notifText}</i>`,
        { message_thread_id: topicId, parse_mode: 'HTML' },
      );
      console.log(`[ZaloHandler] GroupEvent type=${type} group=${groupId}`);
    } catch (err) {
      console.error('[ZaloHandler] GroupEvent error:', err);
    }
  });
}
