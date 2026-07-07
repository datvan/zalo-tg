// ── Zalo Worker: thin JSON stdio wrapper around zca-js ──────────────────────
// Spawned by Rust ZaloClient. Communicates via stdin/stdout JSON lines.

import { Zalo } from 'zca-js';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { createInterface } from 'readline';

const CREDENTIALS_PATH = process.env.ZALO_CREDENTIALS_PATH || 'credentials.json';

let _api = null;
let _listenerActive = false;

function writeResponse(cmd, result, error) {
  process.stdout.write(JSON.stringify({ type: 'response', cmd, result, error }) + '\n');
}

function writeEvent(eventType, data) {
  process.stdout.write(JSON.stringify({ type: 'event', event: eventType, data }) + '\n');
}

async function loginWithCredentials() {
  if (!existsSync(CREDENTIALS_PATH)) {
    writeResponse('login', null, 'No credentials file');
    writeEvent('state', 'need_login');
    return null;
  }

  const creds = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf8'));
  const zalo = new Zalo({
    logging: false,
    checkUpdate: false,
    selfListen: true,
  });

  _api = await zalo.login({
    imei: creds.imei,
    cookie: creds.cookie,
    userAgent: creds.userAgent,
  });

  writeEvent('state', 'ready');
  return _api;
}

function startListener(api) {
  if (_listenerActive) return;
  _listenerActive = true;

  api.listener.on('message', (msg) => {
    writeEvent('message', msg);
  });

  api.listener.on('reaction', (data) => {
    writeEvent('reaction', data);
  });

  api.listener.on('group_event', (data) => {
    writeEvent('group_event', data);
  });

  api.listener.on('disconnected', (code, reason) => {
    writeEvent('disconnected', { code, reason });
    _listenerActive = false;
  });

  api.listener.start();
}

// ── Command handlers ──────────────────────────────────────────────────────

const handlers = {
  async login() {
    await loginWithCredentials();
    if (_api) startListener(_api);
  },

  async sendMessage({ threadId, text, msgType, mentions, quote }) {
    if (!_api) return { error: 'Not logged in' };
    return await _api.sendMessage(threadId, text, { msgType, mentions, quote });
  },

  async sendAttachment({ threadId, attachments, msgType }) {
    if (!_api) return { error: 'Not logged in' };
    return await _api.sendAttachment(threadId, attachments, msgType);
  },

  async addReaction({ msgId, reactionType }) {
    if (!_api) return { error: 'Not logged in' };
    return await _api.addReaction(msgId, reactionType);
  },

  async deleteMessage({ msgId }) {
    if (!_api) return { error: 'Not logged in' };
    return await _api.deleteMessage(msgId);
  },

  async getUserInfo({ userId }) {
    if (!_api) return { error: 'Not logged in' };
    return await _api.getUserInfo(userId);
  },

  async getGroupInfo({ groupId }) {
    if (!_api) return { error: 'Not logged in' };
    return await _api.getGroupInfo(groupId);
  },

  async getAllGroups() {
    if (!_api) return { error: 'Not logged in' };
    return await _api.getAllGroups();
  },

  async getAllFriends() {
    if (!_api) return { error: 'Not logged in' };
    return await _api.getAllFriends();
  },

  async getAliasList() {
    if (!_api) return { error: 'Not logged in' };
    return await _api.getAliasList();
  },
};

// ── Main loop ──────────────────────────────────────────────────────────────

async function main() {
  writeEvent('started', { version: process.version, pid: process.pid });

  // Auto-login on start
  try {
    await loginWithCredentials();
    if (_api) startListener(_api);
  } catch (err) {
    writeEvent('state', 'need_login');
  }

  // Read commands from stdin
  const rl = createInterface({ input: process.stdin, terminal: false });
  for await (const line of rl) {
    try {
      const { cmd, id, ...params } = JSON.parse(line);
      const handler = handlers[cmd];
      if (!handler) {
        writeResponse(cmd, null, `Unknown command: ${cmd}`);
        continue;
      }
      const result = await handler(params);
      writeResponse(cmd, result, null);
    } catch (err) {
      try {
        const { cmd } = JSON.parse(line);
        writeResponse(cmd, null, err.message || String(err));
      } catch {
        writeResponse('unknown', null, String(err));
      }
    }
  }
}

main().catch((err) => {
  writeEvent('error', { message: err.message });
  process.exit(1);
});
