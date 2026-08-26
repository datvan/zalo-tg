import { createHash } from 'crypto';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs';
import path from 'path';
import { canonicalSocialVideoKey, socialVideoLabel } from './socialVideo.js';

export type DurableSocialVideoJobStatus = 'pending' | 'running' | 'done' | 'failed';

export interface DurableSocialVideoJob {
  id: string;
  source: 'telegram' | 'zalo';
  target: 'telegram' | 'zalo';
  sourceMessageId: string;
  topicId: number;
  text: string;
  url: string;
  canonicalKey: string;
  label: string;
  zaloId: string;
  threadType: number;
  status: DurableSocialVideoJobStatus;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
  doneAt?: string;
  mirrorSource?: boolean;
  telegramPartCount?: number;
  sourcePartCount?: number;
  sentParts?: Record<string, { clientId: string; result?: unknown; referenceUrl?: string; sentAt: string }>;
  sourceSentParts?: Record<string, { clientId: string; result?: unknown; referenceUrl?: string; sentAt: string }>;
  partManifest?: Array<{ index: number; sizeBytes: number; sha256?: string }>;
}
export interface CreateDurableSocialVideoJobInput {
  source: 'telegram' | 'zalo';
  target: 'telegram' | 'zalo';
  sourceMessageId: string | number;
  topicId: number;
  text: string;
  url: string;
  zaloId: string;
  threadType: number;
  mirrorSource?: boolean;
}

const MAX_ATTEMPTS = Number(process.env.SOCIAL_VIDEO_DURABLE_MAX_ATTEMPTS || 5);
const QUEUE_DIR = process.env.SOCIAL_VIDEO_QUEUE_DIR
  ? path.resolve(process.env.SOCIAL_VIDEO_QUEUE_DIR)
  : path.resolve(process.cwd(), process.env.DATA_DIR ?? './data', 'social-video-queue');

function ensureQueueDir(): void { mkdirSync(QUEUE_DIR, { recursive: true }); }
function hash(value: string): string { return createHash('sha1').update(value).digest('hex').slice(0, 16); }
function jobPath(id: string): string { return path.join(QUEUE_DIR, `${id}.json`); }

function writeJob(job: DurableSocialVideoJob): void {
  ensureQueueDir();
  const tmp = `${jobPath(job.id)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(job, null, 2), 'utf8');
  renameSync(tmp, jobPath(job.id));
}

function readJobFile(filePath: string): DurableSocialVideoJob | undefined {
  try {
    const job = JSON.parse(readFileSync(filePath, 'utf8')) as DurableSocialVideoJob & { target?: 'telegram' | 'zalo' };
    if (!job.target && job.source === 'telegram') {
      job.target = 'zalo';
      writeJob(job);
    }
    return job as DurableSocialVideoJob;
  } catch (err) {
    console.warn('[SocialVideo][DurableQueue] bad job file:', filePath, err);
    return undefined;
  }
}

export function socialVideoJobId(input: Pick<CreateDurableSocialVideoJobInput, 'source' | 'target' | 'sourceMessageId' | 'topicId' | 'url'>): string {
  return `${input.source}-${input.target}-${input.topicId}-${String(input.sourceMessageId)}-${hash(canonicalSocialVideoKey(input.url))}`;
}

export function socialVideoJobPartClientId(jobId: string, partIndex: number): string {
  const bucket = BigInt(`0x${hash(`${jobId}:${partIndex}`).slice(0, 10)}`) % 100_000_000_000n;
  return String(1_700_000_000_000n + bucket);
}

export function getSocialVideoJob(id: string): DurableSocialVideoJob | undefined {
  const filePath = jobPath(id);
  return existsSync(filePath) ? readJobFile(filePath) : undefined;
}

export function createDurableSocialVideoJob(input: CreateDurableSocialVideoJobInput): DurableSocialVideoJob {
  ensureQueueDir();
  const id = socialVideoJobId(input);
  const existing = getSocialVideoJob(id);
  if (existing) return existing;
  const now = new Date().toISOString();
  const job: DurableSocialVideoJob = {
    id,
    source: input.source,
    target: input.target,
    sourceMessageId: String(input.sourceMessageId),
    topicId: input.topicId,
    text: input.text,
    url: input.url,
    canonicalKey: canonicalSocialVideoKey(input.url),
    label: socialVideoLabel(input.url),
    zaloId: input.zaloId,
    threadType: input.threadType,
    status: 'pending',
    attempts: 0,
    maxAttempts: MAX_ATTEMPTS,
    createdAt: now,
    updatedAt: now,
    mirrorSource: input.mirrorSource ?? false,
  };
  writeJob(job);
  return job;
}

export function beginSocialVideoJob(id: string): DurableSocialVideoJob | undefined {
  const job = getSocialVideoJob(id);
  if (!job || job.status === 'done' || job.status === 'failed') return job;
  if (job.attempts >= job.maxAttempts) {
    const failed = { ...job, status: 'failed' as const, updatedAt: new Date().toISOString(), lastError: job.lastError ?? `Maximum attempts exceeded (${job.maxAttempts})` };
    writeJob(failed);
    return failed;
  }
  const next = { ...job, status: 'running' as const, attempts: job.attempts + 1, updatedAt: new Date().toISOString(), lastError: undefined };
  writeJob(next);
  return next;
}

export function completeSocialVideoJob(id: string): DurableSocialVideoJob | undefined {
  const job = getSocialVideoJob(id);
  if (!job) return undefined;
  if (job.partManifest?.length) {
    const sentParts = job.sentParts ?? {};
    const sourceSentParts = job.sourceSentParts ?? {};
    const complete = job.mirrorSource === true
      ? (job.telegramPartCount === undefined || Object.keys(sentParts).length >= job.telegramPartCount)
        && (job.sourcePartCount === undefined || Object.keys(sourceSentParts).length >= job.sourcePartCount)
      : job.partManifest.every(part => Boolean(sentParts[String(part.index)]));
    if (!complete) return job;
  }
  const now = new Date().toISOString();
  const next = { ...job, status: 'done' as const, updatedAt: now, doneAt: now, lastError: undefined };
  writeJob(next);
  return next;
}

export function markSocialVideoJobPartDone(id: string, partIndex: number, clientId: string, result: unknown, referenceUrl?: string): DurableSocialVideoJob | undefined {
  const job = getSocialVideoJob(id);
  if (!job) return undefined;
  if (job.sentParts?.[String(partIndex)]) return job;
  const next = {
    ...job,
    sentParts: { ...(job.sentParts ?? {}), [String(partIndex)]: { clientId, result, ...(referenceUrl ? { referenceUrl } : {}), sentAt: new Date().toISOString() } },
    updatedAt: new Date().toISOString(),
  };
  writeJob(next);
  return next;
}

export function markSocialVideoJobSourcePartDone(id: string, partIndex: number, clientId: string, result: unknown, referenceUrl?: string): DurableSocialVideoJob | undefined {
  const job = getSocialVideoJob(id);
  if (!job) return undefined;
  if (job.sourceSentParts?.[String(partIndex)]) return job;
  const next = {
    ...job,
    sourceSentParts: { ...(job.sourceSentParts ?? {}), [String(partIndex)]: { clientId, result, ...(referenceUrl ? { referenceUrl } : {}), sentAt: new Date().toISOString() } },
    updatedAt: new Date().toISOString(),
  };
  writeJob(next);
  return next;
}

export function setSocialVideoJobPartManifest(id: string, partManifest: Array<{ index: number; sizeBytes: number; sha256?: string }>, resetSentParts = false): DurableSocialVideoJob | undefined {
  const job = getSocialVideoJob(id);
  if (!job) return undefined;
  const next = { ...job, partManifest, ...(resetSentParts ? { sentParts: undefined, sourceSentParts: undefined } : {}), updatedAt: new Date().toISOString() };
  writeJob(next);
  return next;
}

export function setSocialVideoJobPartCounts(id: string, telegramPartCount: number, sourcePartCount: number): DurableSocialVideoJob | undefined {
  const job = getSocialVideoJob(id);
  if (!job) return undefined;
  const next = { ...job, telegramPartCount, sourcePartCount, updatedAt: new Date().toISOString() };
  writeJob(next);
  return next;
}

export async function buildSocialVideoJobPartManifest(paths: string[]): Promise<Array<{ index: number; sizeBytes: number; sha256: string }>> {
  return Promise.all(paths.map(async (filePath, index) => {
    const sha256 = await new Promise<string>((resolve, reject) => {
      const hashStream = createHash('sha256');
      const input = createReadStream(filePath);
      input.on('error', reject);
      input.on('data', chunk => hashStream.update(chunk));
      input.on('end', () => resolve(hashStream.digest('hex')));
    });
    return { index, sizeBytes: statSync(filePath).size, sha256 };
  }));
}

export function hasSocialVideoJobPartManifestMismatch(job: DurableSocialVideoJob, current: Array<{ index: number; sizeBytes: number; sha256?: string }>): boolean {
  const previous = job.partManifest;
  if (!previous?.length) return false;
  if (current.length !== previous.length) return true;
  return previous.some((part, index) => {
    const next = current[index];
    return !next || part.index !== next.index || part.sizeBytes !== next.sizeBytes || part.sha256 !== next.sha256;
  });
}

export function failSocialVideoJob(id: string, err: unknown): DurableSocialVideoJob | undefined {
  const job = getSocialVideoJob(id);
  if (!job) return undefined;
  const next = { ...job, status: (job.attempts >= job.maxAttempts ? 'failed' : 'pending') as DurableSocialVideoJobStatus, updatedAt: new Date().toISOString(), lastError: err instanceof Error ? err.message : String(err) };
  writeJob(next);
  return next;
}

export function listReplayableSocialVideoJobs(): DurableSocialVideoJob[] {
  ensureQueueDir();
  return readdirSync(QUEUE_DIR)
    .filter(name => name.endsWith('.json'))
    .map(name => readJobFile(path.join(QUEUE_DIR, name)))
    .filter((job): job is DurableSocialVideoJob => !!job && (job.status === 'pending' || job.status === 'running'))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
