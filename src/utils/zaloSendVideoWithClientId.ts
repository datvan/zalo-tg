import { ThreadType } from 'zca-js';

const CUSTOM_METHOD = '__zaloTgSendVideoWithClientId';

export type ZaloSendVideoOptions = {
  msg?: string;
  videoUrl: string;
  thumbnailUrl: string;
  duration?: number;
  width?: number;
  height?: number;
  ttl?: number;
};

export async function sendZaloVideoWithClientId(
  api: any,
  options: ZaloSendVideoOptions,
  threadId: string,
  type: ThreadType,
  clientId: string,
): Promise<unknown> {
  if (typeof api[CUSTOM_METHOD] !== 'function') {
    api.custom(CUSTOM_METHOD, async ({ ctx, utils, props }: any) => {
      const serviceURL = {
        [ThreadType.User]: utils.makeURL(`${api.zpwServiceMap.file[0]}/api/message/forward`),
        [ThreadType.Group]: utils.makeURL(`${api.zpwServiceMap.file[0]}/api/group/forward`),
      };
      const { options, threadId, type, clientId } = props as {
        options: ZaloSendVideoOptions;
        threadId: string;
        type: ThreadType;
        clientId: string;
      };
      let fileSize = 0;
      const headResponse = await utils.request(options.videoUrl, { method: 'HEAD' }, true);
      if (headResponse.ok) fileSize = parseInt(headResponse.headers.get('content-length') || '0', 10);
      if (type !== ThreadType.User && type !== ThreadType.Group) throw new Error('Thread type is invalid');
      const msgInfo = JSON.stringify({
        videoUrl: options.videoUrl,
        thumbUrl: options.thumbnailUrl,
        duration: options.duration ?? 0,
        width: options.width ?? 1280,
        height: options.height ?? 720,
        fileSize,
        properties: {
          color: -1,
          size: -1,
          type: 1003,
          subType: 0,
          ext: {
            sSrcType: -1,
            sSrcStr: '',
            msg_warning_type: 0,
          },
        },
        title: options.msg ?? '',
      });
      const params = type === ThreadType.User
        ? {
            toId: threadId,
            clientId,
            ttl: options.ttl ?? 0,
            zsource: 704,
            msgType: 5,
            msgInfo,
            imei: ctx.imei,
          }
        : {
            grid: threadId,
            visibility: 0,
            clientId,
            ttl: options.ttl ?? 0,
            zsource: 704,
            msgType: 5,
            msgInfo,
            imei: ctx.imei,
          };
      const encryptedParams = utils.encodeAES(JSON.stringify(params));
      if (!encryptedParams) throw new Error('Failed to encrypt params');
      const response = await utils.request(serviceURL[type], {
        method: 'POST',
        body: new URLSearchParams({ params: encryptedParams }),
      });
      return utils.resolve(response);
    });
  }
  try {
    return await api[CUSTOM_METHOD]({ options, threadId, type, clientId });
  } catch (err) {
    if ((err as { code?: number })?.code === 114 && typeof api.sendVideo === 'function') {
      console.warn('[SocialVideo] Fixed clientId sendVideo rejected with code 114; falling back to SDK sendVideo');
      return api.sendVideo(options, threadId, type);
    }
    throw err;
  }
}
