import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const [,, input, output] = process.argv;
if (!input || !output) {
  console.error('Usage: node scripts/convert-tiktok-cookies.mjs <chrome-export.json> <netscape-cookies.txt>');
  process.exit(2);
}
const data = JSON.parse(readFileSync(input, 'utf8'));
const cookies = Array.isArray(data) ? data : data.cookies;
if (!Array.isArray(cookies)) throw new Error('No cookies array found');
const lines = ['# Netscape HTTP Cookie File', '# Generated from browser JSON export for yt-dlp. Keep private.'];
for (const c of cookies) {
  const domain = String(c.domain ?? '');
  const includeSubdomains = domain.startsWith('.') ? 'TRUE' : 'FALSE';
  const path = String(c.path ?? '/');
  const secure = c.secure ? 'TRUE' : 'FALSE';
  const exp = c.session ? '0' : String(Math.floor(Number(c.expirationDate ?? 0)) || 0);
  const name = String(c.name ?? '');
  const value = String(c.value ?? '');
  if (!domain || !name) continue;
  lines.push([domain, includeSubdomains, path, secure, exp, name, value].join('\t'));
}
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, lines.join('\n') + '\n', 'utf8');
console.log(`Wrote ${cookies.length} cookies to ${output}`);
