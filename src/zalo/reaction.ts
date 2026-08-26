/** Minimal shape shared by live and catch-up reaction payloads from zca-js. */
export interface ZcaReactionDataLike {
  msgId?: string | number;
  cliMsgId?: string | number;
  content?: {
    rMsg?: Array<{
      gMsgID?: string | number;
      cMsgID?: string | number;
      msgType?: number;
    }>;
  };
}

function normalizeMessageId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const id = String(value).trim();
  return id && id !== '0' ? id : null;
}

/**
 * Return the IDs of the message(s) targeted by a zca-js reaction event.
 *
 * Zalo mobile commonly emits `gMsgID = 0` for direct-message reactions while
 * `cMsgID` still contains the usable target ID. The outer `msgId`/`cliMsgId`
 * identify the reaction event itself on current zca-js payloads, so they are
 * used only as a compatibility fallback when `content.rMsg` is absent/empty.
 */
export function extractReactionTargetMsgIds(data: ZcaReactionDataLike | null | undefined): string[] {
  if (!data) return [];

  const ids: string[] = [];
  for (const target of data.content?.rMsg ?? []) {
    const globalId = normalizeMessageId(target.gMsgID);
    const clientId = normalizeMessageId(target.cMsgID);
    if (globalId) ids.push(globalId);
    if (clientId) ids.push(clientId);
  }

  const normalizedTargets = Array.from(new Set(ids));
  if (normalizedTargets.length > 0) return normalizedTargets;

  return Array.from(new Set([
    normalizeMessageId(data.msgId),
    normalizeMessageId(data.cliMsgId),
  ].filter((id): id is string => id !== null)));
}
