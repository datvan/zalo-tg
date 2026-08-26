import { mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { rm } from 'fs/promises';
import { spawn } from 'child_process';
import path from 'path';

import { cleanTemp, getVideoInfo } from './media.js';
import { SocialVideoMeta } from './socialVideo.js';

const TMP_ROOT = path.join(process.env.TMP || process.env.TEMP || '/tmp', 'zalo-tg-vietsub');
const WHISPER_EXE = 'C:\\Users\\Admin\\AppData\\Roaming\\Subtitle Edit\\Whisper\\Purfview-Whisper-Faster\\faster-whisper-xxl.exe';

type Cue = { n: string; t: string; text: string };

function run(command: string, args: string[], label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', d => { stderr += String(d); });
    p.on('close', code => code === 0 ? resolve() : reject(new Error(`${label} exit ${code}: ${stderr.slice(-4000)}`)));
    p.on('error', reject);
  });
}

function runCapture(command: string, args: string[], label: string, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', d => { stdout += String(d); });
    p.stderr.on('data', d => { stderr += String(d); });
    p.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(`${label} exit ${code}: ${stderr.slice(-4000)}`)));
    p.on('error', reject);
    if (input) p.stdin.end(input, 'utf8'); else p.stdin.end();
  });
}

function parseSrt(srtPath: string): Cue[] {
  const txt = readFileSync(srtPath, 'utf8').replace(/^\uFEFF/, '').trim();
  if (!txt) return [];
  return txt.split(/\r?\n\s*\r?\n/).map(block => {
    const lines = block.split(/\r?\n/);
    const ti = lines.findIndex(l => l.includes('-->'));
    return { n: lines[0] ?? '', t: lines[ti] ?? '', text: lines.slice(ti + 1).join('\n').trim() };
  }).filter(c => c.t && c.text);
}

function buildSrt(en: Cue[], viText: string[]): string {
  return en.map((c, i) => `${c.n}\n${c.t}\n${(viText[i] ?? c.text).trim()}`).join('\n\n') + '\n';
}

function extractJsonArray(text: string): string[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) throw new Error('Gemini did not return JSON array');
  const arr = JSON.parse(text.slice(start, end + 1)) as unknown;
  if (!Array.isArray(arr) || !arr.every(x => typeof x === 'string')) throw new Error('Gemini JSON is not string[]');
  return arr as string[];
}

async function translateCues(cues: Cue[]): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < cues.length; i += 80) {
    const batch = cues.slice(i, i + 80).map((c, j) => ({ id: i + j + 1, text: c.text }));
    const prompt = `Translate these English subtitle cues to natural Vietnamese. Preserve meaning, profanity, names. Return ONLY a JSON array of Vietnamese strings, same order/length.\n${JSON.stringify(batch)}`;
    const raw = await runCapture('gemini', ['--prompt', prompt], 'gemini translate');
    const vi = extractJsonArray(raw);
    if (vi.length !== batch.length) throw new Error(`Gemini length mismatch: ${vi.length}/${batch.length}`);
    out.push(...vi);
  }
  return out;
}

function qa(en: Cue[], vi: string[]): { enCues: number; viCues: number; exact: number; mojibake: number } {
  const bad = ['Ã', 'Â', 'â€', 'â€™', 'â€œ', 'â€�', '�', '??'];
  return {
    enCues: en.length,
    viCues: vi.length,
    exact: en.reduce((n, c, i) => n + (c.text.trim() === (vi[i] ?? '').trim() ? 1 : 0), 0),
    mojibake: vi.reduce((n, x) => n + (bad.some(b => x.includes(b)) ? 1 : 0), 0),
  };
}

function ffSubPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1\\:').replace(/'/g, "\\'");
}

export async function createVietsubVideo(inputPath: string, meta: SocialVideoMeta): Promise<{ path: string; qa: ReturnType<typeof qa> }> {
  const jobDir = path.join(TMP_ROOT, `job_${Date.now()}`);
  mkdirSync(jobDir, { recursive: true });
  const base = path.join(jobDir, 'source');
  const enSrt = `${base}.srt`;
  const viSrt = path.join(jobDir, 'source.vi.srt');
  const outPath = path.join(jobDir, 'source.vietsub.mp4');
  try {
    await run(WHISPER_EXE, [inputPath, '-pp', '-o', base, '--standard', '--beep_off', '--max_line_width', '42', '--max_line_count', '2', '-f', 'srt', '-m', 'large-v2', '-l', 'en'], 'Purfview Whisper');
    const cues = parseSrt(enSrt);
    if (!cues.length) throw new Error('Whisper produced empty SRT');
    const vi = await translateCues(cues);
    const report = qa(cues, vi);
    if (report.enCues !== report.viCues || report.exact > 0 || report.mojibake > 0) throw new Error(`Vietsub QA failed: ${JSON.stringify(report)}`);
    writeFileSync(viSrt, '\uFEFF' + buildSrt(cues, vi), 'utf8');

    const size = statSync(inputPath).size;
    const info = await getVideoInfo(inputPath).catch(() => ({ durationMs: 0, width: 720, height: 1280 }));
    const sec = Math.max(1, info.durationMs / 1000);
    const srcKbps = Math.max(900, Math.min(2500, Math.round((size * 8 / sec / 1000) * 1.2)));
    await run('ffmpeg', [
      '-y', '-hide_banner', '-i', inputPath,
      '-vf', `subtitles='${ffSubPath(viSrt)}':force_style='FontName=Arial,FontSize=9,PrimaryColour=&H0000FFFF,OutlineColour=&H00000000,BackColour=&H00000000,BorderStyle=3,Outline=1,Shadow=0,MarginV=230,Alignment=2'`,
      '-c:v', 'h264_nvenc', '-preset', 'p5', '-b:v', `${srcKbps}k`, '-maxrate', `${Math.round(srcKbps * 1.3)}k`, '-bufsize', `${srcKbps * 2}k`,
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', outPath,
    ], 'ffmpeg burn-in');
    void meta;
    return { path: outPath, qa: report };
  } catch (err) {
    await rm(jobDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

export async function cleanVietsubResult(filePath: string): Promise<void> {
  await cleanTemp(filePath);
  await rm(path.dirname(filePath), { recursive: true, force: true }).catch(() => undefined);
}
