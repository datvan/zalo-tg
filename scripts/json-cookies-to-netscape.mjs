import fs from 'fs';

const [,, input, output] = process.argv;
if (!input || !output) {
  console.error('Usage: node scripts/json-cookies-to-netscape.mjs input.json output.txt');
  process.exit(2);
}
const raw = JSON.parse(fs.readFileSync(input, 'utf8'));
const cookies = Array.isArray(raw) ? raw : raw.cookies;
if (!Array.isArray(cookies)) throw new Error('No cookies array found');
const lines = ['# Netscape HTTP Cookie File'];
for (const c of cookies) {
  if (!c?.domain || !c?.name) continue;
  const domain = String(c.domain);
  const includeSubdomains = domain.startsWith('.') ? 'TRUE' : 'FALSE';
  const path = c.path || '/';
  const secure = c.secure ? 'TRUE' : 'FALSE';
  const expiry = c.session ? '0' : String(Math.floor(Number(c.expirationDate || 0)) || 0);
  const name = String(c.name).replace(/[\t\r\n]/g, '');
  const value = String(c.value ?? '').replace(/[\t\r\n]/g, '');
  lines.push([domain, includeSubdomains, path, secure, expiry, name, value].join('\t'));
}
fs.writeFileSync(output, lines.join('\n') + '\n', 'utf8');
console.log(`Wrote ${cookies.length} cookies to ${output}`);
