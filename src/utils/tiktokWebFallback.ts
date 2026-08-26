import { createWriteStream } from 'fs';
import { spawn } from 'child_process';
import { Readable } from 'stream';

export async function fetchText(url: string): Promise<string> {
  const js = `fetch(process.argv[1],{headers:{'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36','referer':'https://www.tiktok.com/'}}).then(r=>r.text()).then(t=>process.stdout.write(t)).catch(e=>{console.error(e);process.exit(1)})`;
  return new Promise((resolve, reject) => {
    const p = spawn('node', ['-e', js, url], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', d => { stdout += String(d); });
    p.stderr.on('data', d => { stderr += String(d); });
    p.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(`fetch text exit ${code}: ${stderr.slice(-1000)}`)));
    p.on('error', reject);
  });
}

export async function downloadBinary(url: string, outPath: string): Promise<void> {
  const headers: Record<string, string> = {
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'referer': 'https://www.tiktok.com/',
    'accept': '*/*',
    'accept-language': 'en-US,en;q=0.9,vi;q=0.8',
    'range': 'bytes=0-',
    'sec-fetch-dest': 'video',
    'sec-fetch-mode': 'no-cors',
    'sec-fetch-site': 'cross-site',
  };
  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`download ${res.status} ${res.statusText}`);
  await new Promise<void>((resolve, reject) => {
    const file = createWriteStream(outPath);
    const nodeStream = Readable.fromWeb(res.body as any);
    nodeStream.pipe(file);
    nodeStream.on('error', reject);
    file.on('finish', resolve);
    file.on('error', reject);
  });
}
