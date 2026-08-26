import assert from 'assert/strict';
import { ThreadType } from 'zca-js';
import { sendZaloVideoWithClientId } from '../dist/utils/zaloSendVideoWithClientId.js';

let params;
const api = {
  zpwServiceMap: { file: ['https://file.example.test'] },
  custom(name, callback) {
    this[name] = (props) => callback({
      ctx: { imei: 'imei' },
      props,
      utils: {
        makeURL: (url) => url,
        encodeAES: (json) => {
          params = JSON.parse(json);
          return 'encrypted';
        },
        request: async (_url, _options, raw) => raw
          ? { ok: true, headers: { get: () => '12345' } }
          : { ok: true },
        resolve: async () => ({ ok: true }),
      },
    });
  },
};

await sendZaloVideoWithClientId(api, {
  msg: 'caption',
  videoUrl: 'https://cdn.example.test/video.mp4',
  thumbnailUrl: 'https://cdn.example.test/thumb.jpg',
}, 'group-id', ThreadType.Group, '424242');

assert.equal(params.clientId, '424242');
assert.equal(params.grid, 'group-id');
assert.equal(JSON.parse(params.msgInfo).title, 'caption');
assert.equal(JSON.parse(params.msgInfo).fileSize, 12345);

let sdkFallbackCalls = 0;
const fallbackApi = {
  zpwServiceMap: { file: ['https://file.example.test'] },
  custom(name, callback) {
    this[name] = (props) => callback({
      ctx: { imei: 'imei' },
      props,
      utils: {
        makeURL: (url) => url,
        encodeAES: () => 'encrypted',
        request: async (_url, _options, raw) => raw
          ? { ok: true, headers: { get: () => '12345' } }
          : { ok: true },
        resolve: async () => {
          const err = new Error('bad params');
          err.code = 114;
          throw err;
        },
      },
    });
  },
  sendVideo: async (options, threadId, type) => {
    sdkFallbackCalls++;
    return { options, threadId, type, fallback: true };
  },
};

const fallbackResult = await sendZaloVideoWithClientId(fallbackApi, {
  msg: 'caption',
  videoUrl: 'https://cdn.example.test/video.mp4',
  thumbnailUrl: 'https://cdn.example.test/thumb.jpg',
}, 'group-id', ThreadType.Group, '424242');

assert.equal(sdkFallbackCalls, 1);
assert.equal(fallbackResult.fallback, true);

console.log('zalo send video clientId ok');
