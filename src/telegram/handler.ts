import { ThreadType } from 'zca-js';
import path from 'path';
import { createReadStream } from 'fs';

import type { ZaloAPI } from '../zalo/types.js';
import { store, msgStore, userCache, friendsCache, sentMsgStore, pollStore, mediaGroupStore } from '../store.js';
import { tgBot } from './bot.js';
import { config } from '../config.js';
import { downloadToTemp, cleanTemp, convertToM4a, convertToMp4, convertTgsToMp4, getVideoInfo } from '../utils/media.js';
import { extractSocialVideoUrls, enqueueSocialVideo, downloadSocialVideo, prepareTelegramVideoPaths, formatSocialVideoCaption, createSocialVideoThumbnail, withUploadTimeout } from '../utils/socialVideo.js';
import { rememberSelfVideoCaption, rememberSelfVideoFallback } from '../utils/selfVideoCaption.js';
import {
  beginSocialVideoJob,
  buildSocialVideoJobPartManifest,
  completeSocialVideoJob,
  createDurableSocialVideoJob,
  failSocialVideoJob,
  hasSocialVideoJobPartManifestMismatch,
  listReplayableSocialVideoJobs,
  markSocialVideoJobPartDone,
  setSocialVideoJobPartManifest,
  socialVideoJobPartClientId,
  type DurableSocialVideoJob,
} from '../utils/durableSocialVideoQueue.js';
import { sendZaloVideoWithClientId } from '../utils/zaloSendVideoWithClientId.js';
import { canAutoRepostSocialVideoTopic } from '../utils/socialVideoPolicy.js';

import { triggerQRLogin } from '../zalo/client.js';
import { canUseBridge, rejectUnauthorized } from '../security.js';
import { markHealth } from '../health.js';

// ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Mention resolution helper ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬

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
      if (/^(all|everyone|tÃƒÂ¡Ã‚ÂºÃ‚Â¥t\s*cÃƒÂ¡Ã‚ÂºÃ‚Â£)$/i.test(captured)) {
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
      'ÃƒÂ¢Ã‚ÂÃ‚Â³ Ãƒâ€žÃ‚Âang cÃƒÆ’Ã‚Â³ phiÃƒÆ’Ã‚Âªn Ãƒâ€žÃ¢â‚¬ËœÃƒâ€žÃ†â€™ng nhÃƒÂ¡Ã‚ÂºÃ‚Â­p khÃƒÆ’Ã‚Â¡c Ãƒâ€žÃ¢â‚¬Ëœang chÃƒÂ¡Ã‚ÂºÃ‚Â¡y. Vui lÃƒÆ’Ã‚Â²ng chÃƒÂ¡Ã‚Â»Ã‚Â...',
      threadId ? { message_thread_id: threadId } : {},
    );
    return;
  }

  qrLoginInProgress = true;
  const msgOpts = threadId ? { message_thread_id: threadId } : {};

  try {
    await tgBot.telegram.sendMessage(chatId, 'ÃƒÂ°Ã…Â¸Ã¢â‚¬ÂÃ¢â‚¬Å¾ Ãƒâ€žÃ‚Âang tÃƒÂ¡Ã‚ÂºÃ‚Â¡o mÃƒÆ’Ã‚Â£ QR Zalo...', msgOpts);

    const newApi = await triggerQRLogin({
      onQRReady: async (imagePath) => {
        await tgBot.telegram.sendPhoto(
          chatId,
          { source: createReadStream(imagePath) },
          {
            ...msgOpts,
            caption: 'ÃƒÂ°Ã…Â¸Ã¢â‚¬Å“Ã‚Â± MÃƒÂ¡Ã‚Â»Ã…Â¸ ÃƒÂ¡Ã‚Â»Ã‚Â©ng dÃƒÂ¡Ã‚Â»Ã‚Â¥ng <b>Zalo</b> ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ CÃƒÆ’Ã‚Â i Ãƒâ€žÃ¢â‚¬ËœÃƒÂ¡Ã‚ÂºÃ‚Â·t ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ QuÃƒÆ’Ã‚Â©t mÃƒÆ’Ã‚Â£ QR Ãƒâ€žÃ¢â‚¬ËœÃƒÂ¡Ã‚Â»Ã†â€™ Ãƒâ€žÃ¢â‚¬ËœÃƒâ€žÃ†â€™ng nhÃƒÂ¡Ã‚ÂºÃ‚Â­p.',
            parse_mode: 'HTML',
          },
        );
      },
      onExpired: async () => {
        await tgBot.telegram.sendMessage(chatId, 'ÃƒÂ¢Ã‚ÂÃ‚Â° QR hÃƒÂ¡Ã‚ÂºÃ‚Â¿t hÃƒÂ¡Ã‚ÂºÃ‚Â¡n, Ãƒâ€žÃ¢â‚¬Ëœang tÃƒÂ¡Ã‚ÂºÃ‚Â¡o mÃƒÆ’Ã‚Â£ mÃƒÂ¡Ã‚Â»Ã¢â‚¬Âºi...', msgOpts);
      },
      onScanned: async (displayName) => {
        await tgBot.telegram.sendMessage(
          chatId,
          `ÃƒÂ¢Ã…â€œÃ¢â‚¬Â¦ Ãƒâ€žÃ‚ÂÃƒÆ’Ã‚Â£ quÃƒÆ’Ã‚Â©t! ChÃƒÂ¡Ã‚Â»Ã‚Â xÃƒÆ’Ã‚Â¡c nhÃƒÂ¡Ã‚ÂºÃ‚Â­n tÃƒÂ¡Ã‚Â»Ã‚Â« <b>${displayName}</b>...`,
          { ...msgOpts, parse_mode: 'HTML' },
        );
      },
      onDeclined: async () => {
        await tgBot.telegram.sendMessage(chatId, 'ÃƒÂ¢Ã‚ÂÃ…â€™ Ãƒâ€žÃ‚ÂÃƒâ€žÃ†â€™ng nhÃƒÂ¡Ã‚ÂºÃ‚Â­p bÃƒÂ¡Ã‚Â»Ã¢â‚¬Â¹ tÃƒÂ¡Ã‚Â»Ã‚Â« chÃƒÂ¡Ã‚Â»Ã¢â‚¬Ëœi trÃƒÆ’Ã‚Âªn Ãƒâ€žÃ¢â‚¬ËœiÃƒÂ¡Ã‚Â»Ã¢â‚¬Â¡n thoÃƒÂ¡Ã‚ÂºÃ‚Â¡i.', msgOpts);
      },
      onSuccess: async () => {
        await tgBot.telegram.sendMessage(
          chatId,
          'ÃƒÂ°Ã…Â¸Ã…Â½Ã¢â‚¬Â° Ãƒâ€žÃ‚ÂÃƒâ€žÃ†â€™ng nhÃƒÂ¡Ã‚ÂºÃ‚Â­p Zalo thÃƒÆ’Ã‚Â nh cÃƒÆ’Ã‚Â´ng! Bridge Ãƒâ€žÃ¢â‚¬Ëœang hoÃƒÂ¡Ã‚ÂºÃ‚Â¡t Ãƒâ€žÃ¢â‚¬ËœÃƒÂ¡Ã‚Â»Ã¢â€žÂ¢ng.',
          msgOpts,
        );
      },
    });

    onNewApi(newApi);
  } catch (err) {
    await tgBot.telegram.sendMessage(
      chatId,
      `ÃƒÂ¢Ã‚ÂÃ…â€™ Ãƒâ€žÃ‚ÂÃƒâ€žÃ†â€™ng nhÃƒÂ¡Ã‚ÂºÃ‚Â­p thÃƒÂ¡Ã‚ÂºÃ‚Â¥t bÃƒÂ¡Ã‚ÂºÃ‚Â¡i: ${String(err)}`,
      msgOpts,
    ).catch(() => undefined);
  } finally {
    qrLoginInProgress = false;
  }
}

/**
 * Wire up Telegram ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ Zalo forwarding.
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
  const queuedDurableSocialVideoJobs = new Set<string>();

  const notifySocialVideoJobError = async (job: DurableSocialVideoJob, action: string, err: unknown) => {
    const errMsg = err instanceof Error ? err.message : String(err);
    await tgBot.telegram
      .sendMessage(
        config.telegram.groupId,
        `Social video failed: <b>${action}</b>\n<code>${errMsg}</code>\n${job.url}`,
        { message_thread_id: job.topicId, parse_mode: 'HTML' },
      )
      .catch(() => undefined);
  };

  const runDurableSocialVideoJob = async (api: ZaloAPI, job: DurableSocialVideoJob): Promise<void> => {
    const localPaths: string[] = [];
    const downloadedPaths: string[] = [];
    try {
      console.log(`[TG->Zalo][SocialVideo] Downloading ${job.label}: ${job.url}`);
      const downloaded = await downloadSocialVideo(job.url);
      downloadedPaths.push(...downloaded.paths);
      const preparedPaths = await prepareTelegramVideoPaths(downloaded.paths);
      localPaths.push(...preparedPaths);
      const currentManifest = await buildSocialVideoJobPartManifest(preparedPaths);
      if (hasSocialVideoJobPartManifestMismatch(job, currentManifest)) {
        throw new Error(`Durable social video part manifest mismatch for ${job.id}`);
      }
      setSocialVideoJobPartManifest(job.id, currentManifest);
      const sleepSocialUpload = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
      const withSocialUploadTimeout = async <T>(promise: Promise<T>, label: string, timeoutMs = Number(process.env.SOCIAL_UPLOAD_TIMEOUT_MS || 120_000)): Promise<T> => {
        let timer: NodeJS.Timeout | undefined;
        try {
          return await Promise.race([
            promise,
            new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs); }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      };
      const uploadSocialVideoWithRetry = async (localPath: string, partLabel: string) => {
        let lastErr: unknown;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            return await withSocialUploadTimeout(api.uploadAttachment(localPath, job.zaloId, job.threadType) as Promise<Array<{
              fileUrl?: string;
              normalUrl?: string;
              hdUrl?: string;
              thumbUrl?: string;
            }>>, `[TGZalo][SocialVideo] uploadAttachment ${partLabel}`);
          } catch (err) {
            lastErr = err;
            if (attempt >= 3) break;
            const delay = 2000 * attempt;
            console.warn(`[TGZalo][SocialVideo] uploadAttachment ${partLabel} failed (${attempt}/3), retrying in ${delay}ms:`, err);
            await sleepSocialUpload(delay);
          }
        }
        throw lastErr;
      };
      const sendSocialVideoPartWithRetry = async (localPath: string, partIndex: number, partLabel: string, partCaption: string) => {
        let lastErr: unknown;
        const clientId = socialVideoJobPartClientId(job.id, partIndex);
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            if (attempt > 1) console.log(`[TG->Zalo][SocialVideo] Retry upload+send ${partLabel} attempt=${attempt}/3`);
            const uploaded = await uploadSocialVideoWithRetry(localPath, partLabel);
            console.log(`[TG->Zalo][SocialVideo] Upload result ${partLabel} attempt=${attempt}/3:`, JSON.stringify(uploaded[0] ?? {}));
            const nativeVideoUrl = uploaded[0]?.fileUrl ?? uploaded[0]?.normalUrl ?? uploaded[0]?.hdUrl;
            let thumbnailPath: string | undefined;
            let thumbnailUrl: string | undefined;
            const videoInfo = await getVideoInfo(localPath).catch(() => ({ durationMs: 30_000, width: 720, height: 1280 }));
            try {
              thumbnailPath = await createSocialVideoThumbnail(localPath);
              const thumbnailUploaded = await withSocialUploadTimeout(api.uploadAttachment(thumbnailPath, job.zaloId, job.threadType) as Promise<Array<{
                fileUrl?: string;
                normalUrl?: string;
                hdUrl?: string;
                thumbUrl?: string;
              }>>, `[TG->Zalo][SocialVideo] uploadThumbnail ${partLabel}`);
              thumbnailUrl = thumbnailUploaded[0]?.thumbUrl ?? thumbnailUploaded[0]?.normalUrl ?? thumbnailUploaded[0]?.hdUrl ?? thumbnailUploaded[0]?.fileUrl;
              console.log(`[TG->Zalo][SocialVideo] Thumbnail result ${partLabel} attempt=${attempt}/3:`, JSON.stringify(thumbnailUploaded[0] ?? {}));
            } finally {
              if (thumbnailPath) cleanTemp(thumbnailPath);
            }
            if (!nativeVideoUrl || !thumbnailUrl) throw new Error('Missing videoUrl/thumbUrl from uploadAttachment');
            const sendResult = await sendZaloVideoWithClientId(api, {
              msg: '',
              videoUrl: nativeVideoUrl,
              thumbnailUrl,
              duration: videoInfo.durationMs,
              width: videoInfo.width,
              height: videoInfo.height,
            }, job.zaloId, job.threadType, clientId) as { msgId?: number | string; message?: { msgId?: number | string } } | undefined;
            if (partCaption.trim()) {
              try {
                sentMsgStore.markPendingSelf(job.zaloId, job.threadType as 0 | 1, partCaption);
                await api.sendMessage({ msg: partCaption }, job.zaloId, job.threadType);
              } catch (captionErr) {
                console.warn(`[TG->Zalo][SocialVideo] caption send failed ${partLabel}:`, captionErr);
              }
            }
            markSocialVideoJobPartDone(job.id, partIndex, clientId, sendResult);
            return { sendResult, uploaded };
          } catch (err) {
            lastErr = err;
            if (attempt >= 3) break;
            const delay = 3000 * attempt;
            console.warn(`[TGZalo][SocialVideo] upload+send ${partLabel} failed (${attempt}/3), retrying in ${delay}ms:`, err);
            await sleepSocialUpload(delay);
          }
        }
        throw lastErr;
      };
      for (let i = 0; i < localPaths.length; i++) {
        if (job.sentParts?.[String(i)]) {
          console.log(`[TG->Zalo][SocialVideo] Skip already-sent part ${i + 1}/${localPaths.length} job=${job.id}`);
          continue;
        }
        const partLabel = `part ${i + 1}/${localPaths.length}`;
        const partCaption = formatSocialVideoCaption(downloaded.meta, localPaths.length > 1 ? `Part ${i + 1}/${localPaths.length}` : undefined);
        const { sendResult } = await sendSocialVideoPartWithRetry(localPaths[i]!, i, partLabel, partCaption);
        rememberSelfVideoCaption(sendResult, partCaption);
        rememberSelfVideoFallback(sendResult, localPaths[i]!, partCaption);
        console.log(`[TG->Zalo][SocialVideo] Sent native video ${partLabel} target=${job.threadType}:${job.zaloId} result=${JSON.stringify(sendResult ?? {})}`);
      }
    } finally {
      for (const localPath of new Set([...downloadedPaths, ...localPaths])) await cleanTemp(localPath);
    }
  };

  const enqueueDurableSocialVideoJob = (api: ZaloAPI, job: DurableSocialVideoJob): void => {
    if (queuedDurableSocialVideoJobs.has(job.id) || job.status === 'done' || job.status === 'failed') return;
    queuedDurableSocialVideoJobs.add(job.id);
    const scheduleRetry = (delayMs: number) => {
      const timer = setTimeout(() => {
        queuedDurableSocialVideoJobs.delete(job.id);
        if (currentApi) enqueueDurableSocialVideoJob(currentApi, job);
      }, delayMs);
      timer.unref?.();
    };
    void enqueueSocialVideo(`tg:${job.threadType}:${job.zaloId}`, `${job.label}:telegram`, async () => {
      const started = beginSocialVideoJob(job.id);
      if (!started || started.status === 'done' || started.status === 'failed') return;
      try {
        await runDurableSocialVideoJob(api, started);
        completeSocialVideoJob(job.id);
      } catch (err) {
        const failed = failSocialVideoJob(job.id, err);
        if (failed?.status === 'pending') {
          const delay = Math.min(60_000, 10_000 * Math.max(1, failed.attempts));
          console.warn(`[SocialVideo][Durable] retry ${failed.id} in ${delay}ms`);
          scheduleRetry(delay);
          return;
        }
        if (failed) await notifySocialVideoJobError(failed, 'socialVideo', err);
        throw err;
      }
    }, job.id).catch(err => {
      const failed = failSocialVideoJob(job.id, err);
      if (failed?.status === 'pending') scheduleRetry(30_000);
    }).finally(() => {
      queuedDurableSocialVideoJobs.delete(job.id);
    });
  };

  const replayDurableSocialVideoJobs = (api: ZaloAPI): void => {
    const jobs = listReplayableSocialVideoJobs().filter(job => job.source === 'telegram' && job.target === 'zalo');
    if (jobs.length) console.log(`[SocialVideo][Durable] replaying ${jobs.length} job(s)`);
    for (const job of jobs) enqueueDurableSocialVideoJob(api, job);
  };

  /** Exposed setter so index.ts can inject the auto-logged-in API. */
  const setCurrentApi = (api: ZaloAPI) => {
    currentApi = api;
    replayDurableSocialVideoJobs(api);
  };

  if (initialApi) replayDurableSocialVideoJobs(initialApi);

  tgBot.command('login', async (ctx) => {
    if (!canUseBridge(ctx)) { await rejectUnauthorized(ctx); return; }
    const threadId = ctx.message.message_thread_id;
    await handleLoginCommand(ctx.chat.id, threadId, (newApi) => {
      currentApi = newApi;
      replayDurableSocialVideoJobs(newApi);
      void onZaloLogin(newApi).catch((e: unknown) => console.error('[/login] onZaloLogin error:', e));
    });
  });

  // /topic ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Å“ manage bridge topic mappings
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
        await ctx.telegram.sendMessage(config.telegram.groupId, 'ÃƒÂ°Ã…Â¸Ã¢â‚¬Å“Ã‚Â­ ChÃƒâ€ Ã‚Â°a cÃƒÆ’Ã‚Â³ topic nÃƒÆ’Ã‚Â o.', replyOpts);
        return;
      }
      const lines = all.map(e =>
        `ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢ <b>${e.name}</b> ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â topicId=${e.topicId}, zaloId=${e.zaloId}, type=${e.type === 1 ? 'group' : 'dm'}`,
      );
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        `ÃƒÂ°Ã…Â¸Ã¢â‚¬Å“Ã¢â‚¬Â¹ <b>Bridge topics</b> (${all.length}):\n${lines.join('\n')}`,
        { ...replyOpts, parse_mode: 'HTML' },
      );
      return;
    }

    if (!topicId) {
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        'ÃƒÂ¢Ã…Â¡Ã‚Â ÃƒÂ¯Ã‚Â¸Ã‚Â LÃƒÂ¡Ã‚Â»Ã¢â‚¬Â¡nh nÃƒÆ’Ã‚Â y phÃƒÂ¡Ã‚ÂºÃ‚Â£i Ãƒâ€žÃ¢â‚¬ËœÃƒâ€ Ã‚Â°ÃƒÂ¡Ã‚Â»Ã‚Â£c gÃƒÂ¡Ã‚Â»Ã‚Â­i trong mÃƒÂ¡Ã‚Â»Ã¢â€žÂ¢t topic cÃƒÂ¡Ã‚Â»Ã‚Â¥ thÃƒÂ¡Ã‚Â»Ã†â€™.',
        replyOpts,
      );
      return;
    }

    if (arg === 'info') {
      const entry = store.getEntryByTopic(topicId);
      if (!entry) {
        await ctx.telegram.sendMessage(config.telegram.groupId, 'ÃƒÂ¢Ã‚ÂÃ…â€™ Topic nÃƒÆ’Ã‚Â y chÃƒâ€ Ã‚Â°a Ãƒâ€žÃ¢â‚¬ËœÃƒâ€ Ã‚Â°ÃƒÂ¡Ã‚Â»Ã‚Â£c map.', replyOpts);
        return;
      }
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        `ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¹ÃƒÂ¯Ã‚Â¸Ã‚Â <b>${entry.name}</b>\nzaloId: <code>${entry.zaloId}</code>\ntype: ${entry.type === 1 ? 'group' : 'dm'}`,
        { ...replyOpts, parse_mode: 'HTML' },
      );
      return;
    }

    if (arg === 'delete') {
      const removed = store.remove(topicId);
      if (!removed) {
        await ctx.telegram.sendMessage(config.telegram.groupId, 'ÃƒÂ¢Ã‚ÂÃ…â€™ Topic nÃƒÆ’Ã‚Â y chÃƒâ€ Ã‚Â°a Ãƒâ€žÃ¢â‚¬ËœÃƒâ€ Ã‚Â°ÃƒÂ¡Ã‚Â»Ã‚Â£c map.', replyOpts);
        return;
      }
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        `ÃƒÂ°Ã…Â¸Ã¢â‚¬â€Ã¢â‚¬ËœÃƒÂ¯Ã‚Â¸Ã‚Â Ãƒâ€žÃ‚ÂÃƒÆ’Ã‚Â£ xoÃƒÆ’Ã‚Â¡ mapping: <b>${removed.name}</b> (zaloId=${removed.zaloId})`,
        { ...replyOpts, parse_mode: 'HTML' },
      );
      return;
    }

    await ctx.telegram.sendMessage(
      config.telegram.groupId,
      'ÃƒÂ¢Ã‚ÂÃ¢â‚¬Å“ DÃƒÆ’Ã‚Â¹ng: <code>/topic list</code> | <code>/topic info</code> | <code>/topic delete</code>',
      { ...replyOpts, parse_mode: 'HTML' },
    );
  });

  tgBot.command('recall', async (ctx) => {
    if (!canUseBridge(ctx)) { await rejectUnauthorized(ctx); return; }
    if (!currentApi) { await ctx.reply('ÃƒÂ¢Ã‚ÂÃ…â€™ Zalo chÃƒâ€ Ã‚Â°a kÃƒÂ¡Ã‚ÂºÃ‚Â¿t nÃƒÂ¡Ã‚Â»Ã¢â‚¬Ëœi'); return; }

    const replyTo = 'reply_to_message' in ctx.message
      ? (ctx.message as { reply_to_message?: { message_id: number } }).reply_to_message
      : undefined;

    if (!replyTo) {
      await ctx.reply('ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¹ÃƒÂ¯Ã‚Â¸Ã‚Â Reply vÃƒÆ’Ã‚Â o tin nhÃƒÂ¡Ã‚ÂºÃ‚Â¯n mÃƒÆ’Ã‚Â¬nh Ãƒâ€žÃ¢â‚¬ËœÃƒÆ’Ã‚Â£ gÃƒÂ¡Ã‚Â»Ã‚Â­i rÃƒÂ¡Ã‚Â»Ã¢â‚¬Å“i gÃƒÆ’Ã‚Âµ /recall');
      return;
    }

    // Look up from sentMsgStore (TGÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢Zalo messages we sent)
    const sent = sentMsgStore.get(replyTo.message_id);
    if (!sent) {
      await ctx.reply('ÃƒÂ¢Ã‚ÂÃ…â€™ KhÃƒÆ’Ã‚Â´ng tÃƒÆ’Ã‚Â¬m thÃƒÂ¡Ã‚ÂºÃ‚Â¥y tin nhÃƒÂ¡Ã‚ÂºÃ‚Â¯n Ãƒâ€žÃ¢â‚¬ËœÃƒÆ’Ã‚Â£ gÃƒÂ¡Ã‚Â»Ã‚Â­i (chÃƒÂ¡Ã‚Â»Ã¢â‚¬Â° thu hÃƒÂ¡Ã‚Â»Ã¢â‚¬Å“i Ãƒâ€žÃ¢â‚¬ËœÃƒâ€ Ã‚Â°ÃƒÂ¡Ã‚Â»Ã‚Â£c tin mÃƒÆ’Ã‚Â¬nh gÃƒÂ¡Ã‚Â»Ã‚Â­i tÃƒÂ¡Ã‚Â»Ã‚Â« Telegram, vÃƒÆ’Ã‚Â  chÃƒÂ¡Ã‚Â»Ã¢â‚¬Â° trong 300 tin gÃƒÂ¡Ã‚ÂºÃ‚Â§n nhÃƒÂ¡Ã‚ÂºÃ‚Â¥t)');
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
      console.log(`[TGÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢Zalo] Recall msgId=${sent.msgId} zaloId=${sent.zaloId}`);
      await ctx.reply('ÃƒÂ¢Ã…â€œÃ¢â‚¬Â¦ Ãƒâ€žÃ‚ÂÃƒÆ’Ã‚Â£ thu hÃƒÂ¡Ã‚Â»Ã¢â‚¬Å“i tin nhÃƒÂ¡Ã‚ÂºÃ‚Â¯n trÃƒÆ’Ã‚Âªn Zalo');
    } catch (err) {
      console.error('[TGÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢Zalo] Recall error:', err);
      await ctx.reply(`ÃƒÂ¢Ã‚ÂÃ…â€™ Thu hÃƒÂ¡Ã‚Â»Ã¢â‚¬Å“i thÃƒÂ¡Ã‚ÂºÃ‚Â¥t bÃƒÂ¡Ã‚ÂºÃ‚Â¡i: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  tgBot.command('search', async (ctx) => {
    if (!canUseBridge(ctx)) { await rejectUnauthorized(ctx); return; }
    // /search must be in General (no topicId) or any topic ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â reply to same thread
    const threadId = 'message_thread_id' in ctx.message
      ? (ctx.message.message_thread_id as number | undefined)
      : undefined;
    const replyOpts = threadId ? { message_thread_id: threadId } : {};

    const query = (ctx.message.text ?? '').replace(/^\/search\s*/i, '').trim();
    if (!query) {
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        'ÃƒÂ°Ã…Â¸Ã¢â‚¬ÂÃ‚Â CÃƒÆ’Ã‚Âº phÃƒÆ’Ã‚Â¡p: <code>/search TÃƒÆ’Ã‚Âªn</code>',
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
        `ÃƒÂ°Ã…Â¸Ã¢â‚¬ÂÃ‚Â KhÃƒÆ’Ã‚Â´ng tÃƒÆ’Ã‚Â¬m thÃƒÂ¡Ã‚ÂºÃ‚Â¥y ai cÃƒÆ’Ã‚Â³ tÃƒÆ’Ã‚Âªn chÃƒÂ¡Ã‚Â»Ã‚Â©a "<b>${query}</b>".`,
        { ...replyOpts, parse_mode: 'HTML' },
      );
      return;
    }

    // Build inline keyboard ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â each button opens/creates a DM topic
    const buttons = results.map(f => [{
      text: f.displayName,
      callback_data: `sc:${f.userId}`,
    }]);

    await ctx.telegram.sendMessage(
      config.telegram.groupId,
      `ÃƒÂ°Ã…Â¸Ã¢â‚¬ÂÃ‚Â KÃƒÂ¡Ã‚ÂºÃ‚Â¿t quÃƒÂ¡Ã‚ÂºÃ‚Â£ "<b>${query}</b>" (${results.length} ngÃƒâ€ Ã‚Â°ÃƒÂ¡Ã‚Â»Ã‚Âi):`,
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
        await ctx.answerCbQuery('ÃƒÂ¢Ã‚ÂÃ…â€™ KhÃƒÆ’Ã‚Â´ng tÃƒÆ’Ã‚Â¬m thÃƒÂ¡Ã‚ÂºÃ‚Â¥y bÃƒÆ’Ã‚Â¬nh chÃƒÂ¡Ã‚Â»Ã‚Ân.');
        return;
      }
      try {
        await doLockPoll(entry, currentApi);
        await ctx.answerCbQuery('ÃƒÂ¢Ã…â€œÃ¢â‚¬Â¦ Ãƒâ€žÃ‚ÂÃƒÆ’Ã‚Â£ khoÃƒÆ’Ã‚Â¡ bÃƒÆ’Ã‚Â¬nh chÃƒÂ¡Ã‚Â»Ã‚Ân');
      } catch (err) {
        console.error('[TGÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢Zalo] lock_poll callback error:', err);
        try { await ctx.answerCbQuery('ÃƒÂ¢Ã‚ÂÃ…â€™ LÃƒÂ¡Ã‚Â»Ã¢â‚¬â€i khoÃƒÆ’Ã‚Â¡ bÃƒÆ’Ã‚Â¬nh chÃƒÂ¡Ã‚Â»Ã‚Ân'); } catch { /* ignore */ }
      }
      return;
    }

    if (!data?.startsWith('sc:')) return;

    const userId = data.slice(3);
    if (!userId) { await ctx.answerCbQuery('ÃƒÂ¢Ã‚ÂÃ…â€™ DÃƒÂ¡Ã‚Â»Ã‚Â¯ liÃƒÂ¡Ã‚Â»Ã¢â‚¬Â¡u khÃƒÆ’Ã‚Â´ng hÃƒÂ¡Ã‚Â»Ã‚Â£p lÃƒÂ¡Ã‚Â»Ã¢â‚¬Â¡'); return; }

    // Check if topic already exists
    const existing = store.getTopicByZalo(userId, 0 /* DM */);
    if (existing !== undefined) {
      await ctx.answerCbQuery('ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¹ÃƒÂ¯Ã‚Â¸Ã‚Â Topic Ãƒâ€žÃ¢â‚¬ËœÃƒÆ’Ã‚Â£ tÃƒÂ¡Ã‚Â»Ã¢â‚¬Å“n tÃƒÂ¡Ã‚ÂºÃ‚Â¡i');
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        `ÃƒÂ°Ã…Â¸Ã¢â‚¬â„¢Ã‚Â¬ Topic cho ngÃƒâ€ Ã‚Â°ÃƒÂ¡Ã‚Â»Ã‚Âi nÃƒÆ’Ã‚Â y Ãƒâ€žÃ¢â‚¬ËœÃƒÆ’Ã‚Â£ cÃƒÆ’Ã‚Â³ sÃƒÂ¡Ã‚ÂºÃ‚Âµn (topicId=${existing}).`,
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
        `ÃƒÂ°Ã…Â¸Ã¢â‚¬ËœÃ‚Â¤ ${displayName}`.slice(0, 128),
        { icon_color: 0x6FB9F0 },
      );
      const topicId = topic.message_thread_id;
      store.set({ topicId, zaloId: userId, type: 0, name: displayName });
      console.log(`[/search] Created DM topic "${displayName}" (topicId=${topicId})`);

      await ctx.answerCbQuery('ÃƒÂ¢Ã…â€œÃ¢â‚¬Â¦ Ãƒâ€žÃ‚ÂÃƒÆ’Ã‚Â£ tÃƒÂ¡Ã‚ÂºÃ‚Â¡o topic!');
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        `ÃƒÂ¢Ã…â€œÃ¢â‚¬Â¦ Ãƒâ€žÃ‚ÂÃƒÆ’Ã‚Â£ tÃƒÂ¡Ã‚ÂºÃ‚Â¡o topic cho <b>${displayName}</b>.\nNhÃƒÂ¡Ã‚ÂºÃ‚Â¯n tin tÃƒÂ¡Ã‚ÂºÃ‚Â¡i Ãƒâ€žÃ¢â‚¬ËœÃƒÆ’Ã‚Â¢y Ãƒâ€žÃ¢â‚¬ËœÃƒÂ¡Ã‚Â»Ã†â€™ chat vÃƒÂ¡Ã‚Â»Ã¢â‚¬Âºi hÃƒÂ¡Ã‚Â»Ã‚Â qua Zalo.`,
        { message_thread_id: topicId, parse_mode: 'HTML' },
      );
    } catch (err) {
      console.error('[/search] createForumTopic failed:', err);
      await ctx.answerCbQuery('ÃƒÂ¢Ã‚ÂÃ…â€™ TÃƒÂ¡Ã‚ÂºÃ‚Â¡o topic thÃƒÂ¡Ã‚ÂºÃ‚Â¥t bÃƒÂ¡Ã‚ÂºÃ‚Â¡i');
    }
  });

  // Bot phÃƒÂ¡Ã‚ÂºÃ‚Â£i lÃƒÆ’Ã‚Â  admin vÃƒÆ’Ã‚Â  allowed_updates phÃƒÂ¡Ã‚ÂºÃ‚Â£i cÃƒÆ’Ã‚Â³ "message_reaction"
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

      // Map TG emoji ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ Zalo Reactions icon
      // Zalo Reactions enum values are the icon strings used in addReaction
      const TG_TO_ZALO: Record<string, string> = {
        'ÃƒÂ¢Ã‚ÂÃ‚Â¤':  '/-heart',
        'ÃƒÂ¢Ã‚ÂÃ‚Â¤ÃƒÂ¯Ã‚Â¸Ã‚Â': '/-heart',
        'ÃƒÂ°Ã…Â¸Ã¢â‚¬ËœÃ‚Â':  '/-strong',
        'ÃƒÂ°Ã…Â¸Ã¢â‚¬ËœÃ…Â½':  '/-weak',
        'ÃƒÂ°Ã…Â¸Ã‹Å“Ã¢â‚¬Å¾':  ':>',
        'ÃƒÂ°Ã…Â¸Ã‹Å“Ã‚Â':  ':>',
        'ÃƒÂ°Ã…Â¸Ã‹Å“Ã‚Â¢':  ':-((',
        'ÃƒÂ°Ã…Â¸Ã‹Å“Ã‚Â­':  ':((',
        'ÃƒÂ°Ã…Â¸Ã‹Å“Ã‚Â®':  ':o',
        'ÃƒÂ°Ã…Â¸Ã‹Å“Ã‚Â±':  ':o',
        'ÃƒÂ°Ã…Â¸Ã‹Å“Ã‚Â¡':  ':-h',
        'ÃƒÂ°Ã…Â¸Ã‚Â¤Ã‚Â¬':  ':-h',
        'ÃƒÂ°Ã…Â¸Ã‹Å“Ã‹Å“':  ':-*',
        'ÃƒÂ°Ã…Â¸Ã‚Â¥Ã‚Â°':  ';xx',
        'ÃƒÂ°Ã…Â¸Ã‹Å“Ã‚Â':  ';xx',
        'ÃƒÂ°Ã…Â¸Ã‚Â¤Ã‚Â£':  ":'>",
        'ÃƒÂ°Ã…Â¸Ã‹Å“Ã¢â‚¬Å¡':  ":'>",
        'ÃƒÂ°Ã…Â¸Ã¢â‚¬â„¢Ã‚Â©':  '/-shit',
        'ÃƒÂ°Ã…Â¸Ã…â€™Ã‚Â¹':  '/-rose',
        'ÃƒÂ°Ã…Â¸Ã¢â‚¬â„¢Ã¢â‚¬Â':  '/-break',
        'ÃƒÂ°Ã…Â¸Ã‹Å“Ã¢â‚¬Â¢':  ';-/',
        'ÃƒÂ°Ã…Â¸Ã‚Â¤Ã¢â‚¬Â':  ';-/',
        'ÃƒÂ°Ã…Â¸Ã‹Å“Ã¢â‚¬Â°':  ';-)',
        'ÃƒÂ°Ã…Â¸Ã¢â‚¬ËœÃ…â€™':  '/-ok',
        'ÃƒÂ¢Ã…â€œÃ…â€™ÃƒÂ¯Ã‚Â¸Ã‚Â':  '/-v',
        'ÃƒÂ¢Ã…â€œÃ…â€™':  '/-v',
        'ÃƒÂ°Ã…Â¸Ã¢â€žÂ¢Ã‚Â':  '_()_',
        'ÃƒÂ°Ã…Â¸Ã¢â‚¬ËœÃ…Â ':  '/-punch',
        'ÃƒÂ°Ã…Â¸Ã‚Â¤Ã‚Â¯':  ':o',
        'ÃƒÂ°Ã…Â¸Ã…Â½Ã¢â‚¬Â°':  '/-bd',
        'ÃƒÂ°Ã…Â¸Ã‚ÂÃ¢â‚¬Â ':  '/-ok',
        'ÃƒÂ°Ã…Â¸Ã¢â‚¬â„¢Ã‚Â¯':  '/-ok',
        'ÃƒÂ°Ã…Â¸Ã‹Å“Ã…Â½':  'x-)',
        'ÃƒÂ°Ã…Â¸Ã‚Â¤Ã‚Â©':  'x-)',
        'ÃƒÂ°Ã…Â¸Ã¢â‚¬ÂÃ‚Â¥':  '/-heart',
      };

      const zaloIcon = TG_TO_ZALO[tgEmoji];
      if (!zaloIcon) {
        console.log(`[TGÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢Zalo] Reaction: no Zalo map for TG emoji "${tgEmoji}"`);
        return;
      }

      // Look up Zalo quote data for this TG message
      const tgMsgId = update.message_id;
      const quote   = msgStore.getQuote(tgMsgId);
      if (!quote) {
        console.log(`[TGÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢Zalo] Reaction: no Zalo quote for TG msg ${tgMsgId}`);
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
      console.log(`[TGÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢Zalo] Reaction "${tgEmoji}" ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ Zalo "${zaloIcon}" on msg ${quote.msgId}`);
    } catch (err) {
      console.error('[TGÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢Zalo] Reaction error:', err);
    }
  });

  tgBot.on('message', async (ctx) => {
    markHealth({ status: 'ok', lastTelegramUpdateAt: new Date().toISOString() });
    try {
      const msg = ctx.message;
      // Only handle messages from our bridge group
      if (!canUseBridge(ctx)) { await rejectUnauthorized(ctx); return; }

      // Must originate from a topic (all bridged conversations live in topics)
      const topicId =
        'message_thread_id' in msg ? (msg.message_thread_id as number | undefined) : undefined;
      if (!topicId) return;



      // Look up the corresponding Zalo conversation
      const entry = store.getEntryByTopic(topicId);
      if (!entry) {
        console.warn(`[TGÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢Zalo] No Zalo mapping for topicId=${topicId}`);
        return;
      }

      const { zaloId } = entry;
      // Ensure numeric value is correctly mapped to ThreadType enum at runtime
      const threadType: ThreadType = entry.type === 1 ? ThreadType.Group : ThreadType.User;

      const notifyError = async (action: string, err: unknown) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        const code = (err as { code?: number }).code;
        console.error(`[TG→Zalo] ${action} failed (zaloId=${zaloId}, type=${threadType}):`, err);

        // Provide a friendlier explanation for common Zalo error codes
        let hint = '';
        if (code === 114) {
          hint = threadType === ThreadType.User
            ? '\n💡 <i>Zalo từ chối: chưa kết bạn hoặc người dùng đã bật giới hạn tin nhắn từ người lạ.</i>'
            : '\n💡 <i>Zalo từ chối tham số (code 114).</i>';
        } else if (code === -216) {
          hint = '\n💡 <i>Phiên đăng nhập Zalo hết hạn. Dùng /login để đăng nhập lại.</i>';
        }

        await tgBot.telegram
          .sendMessage(
            config.telegram.groupId,
            `⚠️ Gửi thất bại: <b>${action}</b>\n<code>${errMsg}${code != null ? ` (code ${code})` : ''}</code>${hint}`,
            { message_thread_id: topicId, parse_mode: 'HTML' },
          )
          .catch(() => undefined);
      };

      if ('text' in msg && msg.text) {
        // Skip bot commands that were already handled above
        if (msg.text.startsWith('/')) return;
        const socialVideoUrls = extractSocialVideoUrls(msg.text);
        if (socialVideoUrls.length > 0) {
          if (!canAutoRepostSocialVideoTopic(topicId)) {
            console.log(`[TG->Zalo][SocialVideo] Disabled by allowlist for topicId=${topicId}; forwarding link text only`);
          } else {
            for (const socialVideoUrl of socialVideoUrls) {
              const job = createDurableSocialVideoJob({
                source: 'telegram',
                target: 'zalo',
                sourceMessageId: msg.message_id,
                topicId,
                text: msg.text,
                url: socialVideoUrl,
                zaloId,
                threadType,
              });
              if (currentApi) enqueueDurableSocialVideoJob(currentApi, job);
            }
            return;
          }
        }
        if (!currentApi) {
          console.warn('[TG→Zalo][SocialVideo] currentApi is null; queued social jobs await replay, plain text ignored');
          return;
        }
        const api = currentApi;
        console.log(`[TG→Zalo] sendMessage → zaloId=${zaloId} type=${threadType} text="${msg.text.slice(0, 80)}"`);
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
              console.warn('[TGÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢Zalo] code 114 with quote, retrying without quote');
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
          sentMsgStore.markPendingSelf(zaloId, threadType, msg.text);
          const typedSendResult = sendResult as { message?: { msgId?: number | string } | null; msgId?: number | string } | undefined;
          const zaloMsgId = typedSendResult?.message?.msgId ?? typedSendResult?.msgId;
          if (zaloMsgId !== undefined) {
            sentMsgStore.save(msg.message_id, { msgId: zaloMsgId, zaloId, threadType });
          }
          markHealth({ status: 'ok', lastTgToZaloSuccessAt: new Date().toISOString() });
        } catch (err) {
          await notifyError('sendMessage', err);
        }
        return;
      }
      // Non-text media still requires a live Zalo API.
      if (!currentApi) {
        console.warn('[TG→Zalo] currentApi is null; ignoring non-social-video message');
        return;
      }
      const api = currentApi;

      // helper: download TG file ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ send via uploadAttachment ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ cleanup
      const TG_FILE_LIMIT = 20 * 1024 * 1024; // 20 MB ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â Telegram Bot API hard limit
      const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
      const withRetry = async <T>(label: string, fn: () => Promise<T>, attempts = 5): Promise<T> => {
        let lastErr: unknown;
        for (let i = 1; i <= attempts; i++) {
          try { return await fn(); }
          catch (err) {
            lastErr = err;
            if (i === attempts) break;
            const delay = Math.min(5000, 500 * 2 ** (i - 1));
            console.warn(`[TGÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢Zalo] ${label} failed (${i}/${attempts}), retrying in ${delay}ms:`, err);
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
          new Error(`File${sizeMb} vÃƒâ€ Ã‚Â°ÃƒÂ¡Ã‚Â»Ã‚Â£t giÃƒÂ¡Ã‚Â»Ã¢â‚¬Âºi hÃƒÂ¡Ã‚ÂºÃ‚Â¡n 20 MB cÃƒÂ¡Ã‚Â»Ã‚Â§a Telegram Bot API ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â khÃƒÆ’Ã‚Â´ng thÃƒÂ¡Ã‚Â»Ã†â€™ tÃƒÂ¡Ã‚ÂºÃ‚Â£i xuÃƒÂ¡Ã‚Â»Ã¢â‚¬Ëœng`),
        );
      };

      const sendNativeVideoAttachment = async (
        fileId: string,
        filename: string,
        fileSize?: number,
        caption?: string,
      ) => {
        if (fileSize !== undefined && fileSize > TG_FILE_LIMIT) {
          await notifyTooBig(filename, fileSize);
          return;
        }
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
          const withVideoTimeout = async <T>(label: string, p: Promise<T>, timeoutMs = 180_000): Promise<T> => {
            let timer: NodeJS.Timeout | undefined;
            try {
              return await Promise.race([
                p,
                new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs); }),
              ]);
            } finally {
              if (timer) clearTimeout(timer);
            }
          };
          console.log(`[TG?Zalo][Video] Native upload ${filename} ? zaloId=${zaloId} type=${threadType}`);
          const uploaded = await withVideoTimeout(`[TG?Zalo][Video] uploadAttachment ${filename}`, api.uploadAttachment(localPath, zaloId, threadType) as Promise<Array<{
            fileUrl?: string;
            normalUrl?: string;
            hdUrl?: string;
            thumbUrl?: string;
          }>>);
          const nativeVideoUrl = uploaded[0]?.fileUrl ?? uploaded[0]?.normalUrl ?? uploaded[0]?.hdUrl;
          const thumbnailUrl = uploaded[0]?.thumbUrl ?? nativeVideoUrl;
          if (!nativeVideoUrl || !thumbnailUrl) throw new Error('Missing videoUrl/thumbUrl from uploadAttachment');
          const sendResult = await api.sendVideo({
            msg: caption ?? '',
            videoUrl: nativeVideoUrl,
            thumbnailUrl,
            duration: 30_000,
            width: 720,
            height: 1280,
          }, zaloId, threadType);
          rememberSelfVideoCaption(sendResult, caption ?? '');
          const zaloMsgId = (sendResult as { msgId?: number })?.msgId;
          if (zaloMsgId !== undefined) sentMsgStore.save(msg.message_id, { msgId: zaloMsgId, zaloId, threadType });
          markHealth({ status: 'ok', lastTgToZaloSuccessAt: new Date().toISOString() });
          console.log(`[TG?Zalo][Video] Send OK: ${filename} result=${JSON.stringify(sendResult ?? {})}`);
        } catch (err) {
          await notifyError(`sendVideoAttachment(${filename})`, err);
        } finally {
          await cleanTemp(localPath);
        }
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
          console.log(`[TGÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢Zalo] Sending ${filename} ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ zaloId=${zaloId} type=${threadType}`);
          const withTimeout = <T>(p: Promise<T>) => Promise.race([
            p,
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('Send timeout (30s)')), 30_000),
            ),
          ]);

          // zca-js splits internally when msg is non-empty + quote is set:
          //   1) sends caption+quote as text (reply indicator in Zalo)
          //   2) sends attachment without quote
          // When no caption, skip the quote ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â adding a placeholder text just to
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
              console.warn('[TGÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢Zalo] code 114 on attachment+quote, retrying without quote');
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
          markHealth({ status: 'ok', lastTgToZaloSuccessAt: new Date().toISOString() });
          console.log(`[TGÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢Zalo] Send OK: ${filename}`);
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

      // Helper: flush a media group ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â download all files and send as single Zalo message
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
            console.log(`[TGÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢Zalo] Media group sent: ${localPaths.length} files, zaloMsgId=${zaloMsgId}`);
          }
        } catch (err) {
          console.error('[TGÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢Zalo] Media group send failed:', err);
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
        await sendNativeVideoAttachment(vid.file_id, fname, vid.file_size, cap);
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
          const uploaded = await withUploadTimeout(api.uploadAttachment(m4aPath, zaloId, threadType), '[TG?Zalo][Voice] uploadAttachment') as Array<{ fileUrl?: string }>;
          const voiceUrl = uploaded[0]?.fileUrl;
          if (!voiceUrl) throw new Error('No fileUrl from uploadAttachment');
          console.log(`[TGÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢Zalo] Sending voice ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ ${voiceUrl}`);
          await api.sendVoice({ voiceUrl }, zaloId, threadType);
          console.log(`[TGÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢Zalo] Voice sent OK`);
        } catch (err) {
          console.error('[TGÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢Zalo] Voice convert/send failed, falling back to file:', err);
          await sendAttachment(msg.voice.file_id, `voice_${Date.now()}.ogg`);
        } finally {
          await cleanTemp(oggPath);
          if (m4aPath) await cleanTemp(m4aPath);
        }
        return;
      }

      if ('sticker' in msg && msg.sticker) {
        const sticker = msg.sticker;
        console.log('[TGÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢Zalo] Sticker meta:', JSON.stringify({
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
            console.log(`[TGÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢Zalo] Uploading video sticker MP4 ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ zaloId=${zaloId} type=${threadType}`);
            const uploaded = await withUploadTimeout(api.uploadAttachment(mp4Path, zaloId, threadType), '[TG?Zalo][VideoSticker] uploadAttachment') as Array<{
              fileUrl?: string;
              normalUrl?: string;
              hdUrl?: string;
              thumbUrl?: string;
              fileName?: string;
            }>;
            console.log('[TGÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢Zalo] Video sticker upload result:', JSON.stringify(uploaded[0] ?? {}));
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
            console.log('[TGÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢Zalo] Video sticker sent as native video OK');
          } catch (err) {
            console.error('[TGÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢Zalo] Video sticker convert/send failed, falling back to thumbnail:', err);
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
            console.log(`[TGÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢Zalo] Uploading animated sticker MP4 ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ zaloId=${zaloId} type=${threadType}`);
            const uploaded = await withUploadTimeout(api.uploadAttachment(mp4Path, zaloId, threadType), '[TG?Zalo][AnimatedSticker] uploadAttachment') as Array<{
              fileUrl?: string;
              normalUrl?: string;
              hdUrl?: string;
              thumbUrl?: string;
            }>;
            console.log('[TGÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢Zalo] Animated sticker upload result:', JSON.stringify(uploaded[0] ?? {}));
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
            console.log('[TGÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢Zalo] Animated sticker sent as native video OK');
          } catch (err) {
            console.error('[TGÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢Zalo] Animated sticker render/send failed, falling back to thumbnail:', err);
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
        console.log(`[TGÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢Zalo] Received TG poll: id=${tgPoll.id} question="${tgPoll.question}" is_anonymous=${tgPoll.is_anonymous}`);

        if (threadType !== 1) {
          await ctx.reply('ÃƒÂ¢Ã‚ÂÃ…â€™ ChÃƒÂ¡Ã‚Â»Ã¢â‚¬Â° tÃƒÂ¡Ã‚ÂºÃ‚Â¡o bÃƒÆ’Ã‚Â¬nh chÃƒÂ¡Ã‚Â»Ã‚Ân Ãƒâ€žÃ¢â‚¬ËœÃƒâ€ Ã‚Â°ÃƒÂ¡Ã‚Â»Ã‚Â£c trong nhÃƒÆ’Ã‚Â³m Zalo.', { message_thread_id: topicId });
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
          console.log(`[TGÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢Zalo] Zalo poll created: pollId=${created?.poll_id}`);

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
          console.log(`[TGÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢Zalo] Bot TG poll sent: msgId=${botPollMsg.message_id} uuid=${tgPollUUID}`);

          // 3. Build option list from Zalo response
          const zaloPollOptions = created?.options ?? tgPoll.options.map((o: { text: string }, i: number) => ({
            option_id: i, content: o.text, votes: 0,
          }));

          // 4. Send score message below bot's poll
          const scoreLines = zaloPollOptions.map((o: { content: string }) =>
            `${o.content}\n  ${'ÃƒÂ¢Ã¢â‚¬â€œÃ¢â‚¬Ëœ'.repeat(10)} 0 phiÃƒÂ¡Ã‚ÂºÃ‚Â¿u (0%)`,
          );
          const scoreText = `ÃƒÂ°Ã…Â¸Ã¢â‚¬Å“Ã…Â  <b>KÃƒÂ¡Ã‚ÂºÃ‚Â¿t quÃƒÂ¡Ã‚ÂºÃ‚Â£ bÃƒÆ’Ã‚Â¬nh chÃƒÂ¡Ã‚Â»Ã‚Ân</b>\n<i>(tÃƒÂ¡Ã‚ÂºÃ‚Â¡o tÃƒÂ¡Ã‚Â»Ã‚Â« Telegram)</i>\n\nTÃƒÂ¡Ã‚Â»Ã¢â‚¬Â¢ng: 0 phiÃƒÂ¡Ã‚ÂºÃ‚Â¿u\n\n${scoreLines.join('\n\n')}`;
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
                  { text: 'ÃƒÂ°Ã…Â¸Ã¢â‚¬ÂÃ¢â‚¬â„¢ KhoÃƒÆ’Ã‚Â¡ bÃƒÆ’Ã‚Â¬nh chÃƒÂ¡Ã‚Â»Ã‚Ân', callback_data: `lock_poll:${lockPollId}` },
                ]],
              },
            },
          );

          // 5. Save to pollStore ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â keyed by both pollId and tgPollUUID
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
          console.error('[TGÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢Zalo] createPoll failed:', err);
          await tgBot.telegram.sendMessage(
            config.telegram.groupId,
            'ÃƒÂ¢Ã‚ÂÃ…â€™ KhÃƒÆ’Ã‚Â´ng thÃƒÂ¡Ã‚Â»Ã†â€™ tÃƒÂ¡Ã‚ÂºÃ‚Â¡o bÃƒÆ’Ã‚Â¬nh chÃƒÂ¡Ã‚Â»Ã‚Ân trÃƒÆ’Ã‚Âªn Zalo.',
            { message_thread_id: topicId },
          );
        }
        return;
      }

      if ('location' in msg && msg.location) {
        const { latitude, longitude } = msg.location;
        const mapsUrl = `https://www.google.com/maps?q=${latitude},${longitude}`;
        try {
          // zca-js has no sendLocation ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â use sendLink for a map preview bubble in Zalo
          await api.sendLink(
            { msg: '', link: mapsUrl },
            zaloId,
            threadType,
          );
          console.log(`[TGÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢Zalo] Location sent: ${latitude},${longitude}`);
        } catch (err) {
          // Fallback: send as plain text link
          await api.sendMessage({ msg: `ÃƒÂ°Ã…Â¸Ã¢â‚¬Å“Ã‚Â ${mapsUrl}` }, zaloId, threadType);
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
          const body = `ÃƒÂ°Ã…Â¸Ã¢â‚¬ËœÃ‚Â¤ <b>Danh thiÃƒÂ¡Ã‚ÂºÃ‚Â¿p</b>\nTÃƒÆ’Ã‚Âªn: <b>${fullName}</b>\nSÃƒâ€žÃ‚ÂT: <code>${contact.phone_number}</code>`;
          try {
            await api.sendMessage({ msg: `ÃƒÂ°Ã…Â¸Ã¢â‚¬ËœÃ‚Â¤ ${fullName} ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â ${contact.phone_number}` }, zaloId, threadType);
          } catch (err) {
            await notifyError('sendContact', err);
          }
          // Also send formatted version on TG side as confirmation (just log)
          void body;
        }
        return;
      }
    } catch (err) {
      console.error('[TGÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢Zalo] Error:', err);
    }
  });

  async function doLockPoll(entry: import('../store.js').PollEntry, api: ZaloAPI): Promise<void> {
    await api.lockPoll(entry.pollId);
    console.log(`[TGÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢Zalo] Locked Zalo poll ${entry.pollId}`);
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
    // Update score message: show [Ãƒâ€žÃ‚ÂÃƒÆ’Ã‚Â£ Ãƒâ€žÃ¢â‚¬ËœÃƒÆ’Ã‚Â³ng], remove lock button
    try {
      const detail = await api.getPollDetail(entry.pollId);
      if (detail?.options) {
        const total = detail.options.reduce((s: number, o: { votes: number }) => s + (o.votes ?? 0), 0);
        const lines = (detail.options as Array<{ content: string; votes: number }>).map(o => {
          const pct = total > 0 ? Math.round((o.votes / total) * 100) : 0;
          const bar = 'ÃƒÂ¢Ã¢â‚¬â€œÃ‹â€ '.repeat(Math.round(pct / 10)) + 'ÃƒÂ¢Ã¢â‚¬â€œÃ¢â‚¬Ëœ'.repeat(10 - Math.round(pct / 10));
          return `${o.content}\n  ${bar} ${o.votes} phiÃƒÂ¡Ã‚ÂºÃ‚Â¿u (${pct}%)`;
        });
        const scoreText = `ÃƒÂ°Ã…Â¸Ã¢â‚¬Å“Ã…Â  <b>KÃƒÂ¡Ã‚ÂºÃ‚Â¿t quÃƒÂ¡Ã‚ÂºÃ‚Â£ bÃƒÆ’Ã‚Â¬nh chÃƒÂ¡Ã‚Â»Ã‚Ân <i>[Ãƒâ€žÃ‚ÂÃƒÆ’Ã‚Â£ Ãƒâ€žÃ¢â‚¬ËœÃƒÆ’Ã‚Â³ng]</i></b>\n\nTÃƒÂ¡Ã‚Â»Ã¢â‚¬Â¢ng: ${total} phiÃƒÂ¡Ã‚ÂºÃ‚Â¿u\n\n${lines.join('\n\n')}`;
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
      console.error('[TGÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢Zalo] lockPoll error:', err);
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
      // Telegraf ctx.pollAnswer.poll_id is the TG poll identifier ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â we stored tgPollMsgId.
      // Workaround: iterate pollStore (small set) by checking tgPollUUID stored during creation.

      // Since we can only look up by tgPollMsgId but TG gives us poll_id (a string UUID),
      // we store the mapping tgPollUUID ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ pollId when the poll is sent.
      const tgPollUUID = answer.poll_id;
      console.log(`[TGÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢Zalo] poll_answer: poll_id=${tgPollUUID} option_ids=[${answer.option_ids}]`);
      const entry = pollStore.getByTgPollUUID(tgPollUUID);
      if (!entry) {
        console.log('[TGÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢Zalo] poll_answer: unknown poll UUID', tgPollUUID);
        return;
      }

      if (!currentApi) return;
      const api = currentApi;

      // Map TG 0-based option indices ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ Zalo option_ids
      const optionIds = answer.option_ids
        .map(idx => entry.options[idx]?.option_id)
        .filter((id): id is number => id !== undefined);

      // empty option_ids = user retracted vote ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â refresh score only, no Zalo call
      const refreshScore = async () => {
        try {
          const detail = await api.getPollDetail(entry.pollId);
          if (!detail?.options) return;
          const total = detail.options.reduce((s: number, o: { votes: number }) => s + (o.votes ?? 0), 0);
          const lines = (detail.options as Array<{ content: string; votes: number }>).map(o => {
            const pct = total > 0 ? Math.round((o.votes / total) * 100) : 0;
            const bar = 'ÃƒÂ¢Ã¢â‚¬â€œÃ‹â€ '.repeat(Math.round(pct / 10)) + 'ÃƒÂ¢Ã¢â‚¬â€œÃ¢â‚¬Ëœ'.repeat(10 - Math.round(pct / 10));
            return `${o.content}\n  ${bar} ${o.votes} phiÃƒÂ¡Ã‚ÂºÃ‚Â¿u (${pct}%)`;
          });
          const status = detail.closed ? ' <i>[Ãƒâ€žÃ‚ÂÃƒÆ’Ã‚Â£ Ãƒâ€žÃ¢â‚¬ËœÃƒÆ’Ã‚Â³ng]</i>' : '';
          const scoreText = `ÃƒÂ°Ã…Â¸Ã¢â‚¬Å“Ã…Â  <b>KÃƒÂ¡Ã‚ÂºÃ‚Â¿t quÃƒÂ¡Ã‚ÂºÃ‚Â£ bÃƒÆ’Ã‚Â¬nh chÃƒÂ¡Ã‚Â»Ã‚Ân${status}</b>\n\nTÃƒÂ¡Ã‚Â»Ã¢â‚¬Â¢ng: ${total} phiÃƒÂ¡Ã‚ÂºÃ‚Â¿u\n\n${lines.join('\n\n')}`;
          const replyMarkup = detail.closed
            ? { inline_keyboard: [] as { text: string; callback_data: string }[][] }
            : { inline_keyboard: [[{ text: 'ÃƒÂ°Ã…Â¸Ã¢â‚¬ÂÃ¢â‚¬â„¢ KhoÃƒÆ’Ã‚Â¡ bÃƒÆ’Ã‚Â¬nh chÃƒÂ¡Ã‚Â»Ã‚Ân', callback_data: `lock_poll:${entry.pollId}` }]] };
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
          console.warn('[TGÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢Zalo] poll score refresh failed:', e);
        }
      };

      if (optionIds.length === 0) {
        // Vote retracted ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â unvote on Zalo then refresh score
        try {
          await api.votePoll(entry.pollId, []);
          console.log(`[TGÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢Zalo] Unvoted poll ${entry.pollId}`);
        } catch (e) {
          console.warn('[TGÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢Zalo] unvote failed:', e);
        }
        await refreshScore();
        return;
      }

      // votePoll accepts single id or array
      await api.votePoll(entry.pollId, optionIds.length === 1 ? optionIds[0] : optionIds);
      console.log(`[TGÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢Zalo] Voted poll ${entry.pollId} options [${optionIds}]`);

      // Immediately refresh score message
      await refreshScore();
    } catch (err) {
      console.error('[TGÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢Zalo] poll_answer error:', err);
    }
  });

  return setCurrentApi;
}

// Called by setupTelegramHandler, but defined after so we can reference tgBot directly.
