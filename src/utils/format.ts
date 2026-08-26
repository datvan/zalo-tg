/** Split text into user-perceived characters so truncation never cuts a UTF-16
 * surrogate pair or a combining/ZWJ emoji sequence in half. */
function graphemes(text: string): string[] {
  if (typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    return Array.from(segmenter.segment(text), part => part.segment);
  }
  return Array.from(text);
}

/** Truncate a string to `max` visible characters, appending ellipsis if cut. */
export function truncate(text: string, max = 4096): string {
  if (!Number.isInteger(max) || max < 0) throw new Error('max must be a non-negative integer');
  if (max === 0) return '';
  const chars = graphemes(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
}

/** Escape characters special to Telegram HTML parse mode. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Apply Zalo mention metadata to a plain-text message body, returning an
 * HTML-escaped string with each mention span wrapped in `<b>` tags.
 *
 * @param text     Raw (unescaped) message content.
 * @param mentions Array of {pos, len, type} from TGroupMessage.mentions.
 */
export function applyMentionsHtml(
  text: string,
  mentions: ReadonlyArray<{ pos: number; len: number; type: number }>,
): string {
  if (!mentions.length) return escapeHtml(text);

  const sorted = [...mentions].sort((a, b) => a.pos - b.pos);
  let result = '';
  let cursor = 0;

  for (const m of sorted) {
    // Guard against out-of-range, empty or overlapping mentions.
    if (m.len <= 0 || m.pos < cursor || m.pos < 0 || m.pos >= text.length) continue;
    if (m.pos > cursor) result += escapeHtml(text.slice(cursor, m.pos));
    const end = Math.min(m.pos + m.len, text.length);
    const span = text.slice(m.pos, end);
    result += `<b>${escapeHtml(span)}</b>`;
    cursor = end;
  }

  if (cursor < text.length) result += escapeHtml(text.slice(cursor));
  return result;
}

// ── Zalo rich text markup ────────────────────────────────────────────────────

/** Zalo style code → HTML tag mapping (only tags valid in Telegram HTML mode). */
const ZALO_STYLE_TAGS: Readonly<Record<string, string>> = {
  b: 'b',
  i: 'i',
  u: 'u',
  s: 's',
};
const TAG_ORDER = ['b', 'i', 'u', 's'] as const;
type TelegramTag = typeof TAG_ORDER[number];

export interface ZaloStyle {
  start: number;
  len: number;
  /** 'b' | 'i' | 'u' | 's' | 'c_xxxxxx' | 'f_xx' | 'lst_x' | 'ind_xx' */
  st: string;
}

/**
 * Apply both Zalo text styles (bold/italic/underline/strike) AND mention spans
 * to a raw plain-text string, returning fully escaped, strictly nested HTML.
 *
 * Zalo ranges may overlap in ways that cannot be represented by simply writing
 * independent open/close events. Telegram rejects crossing tags such as
 * `<b>foo<i>bar</b>baz</i>`, so transitions below close and reopen tags to keep
 * the output valid for every overlap shape.
 */
export function applyZaloMarkupHtml(
  text: string,
  mentions?: ReadonlyArray<{ pos: number; len: number; type: number; label?: string }>,
  styles?: ReadonlyArray<ZaloStyle>,
): string {
  const starts = new Map<number, TelegramTag[]>();
  const ends = new Map<number, TelegramTag[]>();
  const addEvent = (map: Map<number, TelegramTag[]>, pos: number, tag: TelegramTag): void => {
    const list = map.get(pos);
    if (list) list.push(tag);
    else map.set(pos, [tag]);
  };

  if (styles?.length) {
    for (const style of styles) {
      const tag = ZALO_STYLE_TAGS[style.st] as TelegramTag | undefined;
      if (!tag || style.len <= 0 || style.start < 0 || style.start >= text.length) continue;
      const end = Math.min(style.start + style.len, text.length);
      addEvent(starts, style.start, tag);
      addEvent(ends, end, tag);
    }
  }

  const replacements = new Map<number, { end: number; label: string }>();
  if (mentions?.length) {
    const occupied: Array<{ start: number; end: number }> = [];
    for (const mention of [...mentions].sort((a, b) => a.pos - b.pos || b.len - a.len)) {
      if (mention.len <= 0 || mention.pos < 0 || mention.pos >= text.length) continue;
      const end = Math.min(mention.pos + mention.len, text.length);
      if (occupied.some(range => mention.pos < range.end && end > range.start)) continue;
      occupied.push({ start: mention.pos, end });
      addEvent(starts, mention.pos, 'b');
      addEvent(ends, end, 'b');
      if (mention.label) replacements.set(mention.pos, { end, label: mention.label });
    }
  }

  if (starts.size === 0 && replacements.size === 0) return escapeHtml(text);

  const counts: Record<TelegramTag, number> = { b: 0, i: 0, u: 0, s: 0 };
  let openTags: TelegramTag[] = [];
  let result = '';

  const applyEvents = (pos: number): void => {
    for (const tag of ends.get(pos) ?? []) counts[tag] = Math.max(0, counts[tag] - 1);
    for (const tag of starts.get(pos) ?? []) counts[tag] += 1;
  };

  const transition = (): void => {
    const desired = TAG_ORDER.filter(tag => counts[tag] > 0);
    let common = 0;
    while (common < openTags.length && common < desired.length && openTags[common] === desired[common]) {
      common++;
    }
    for (let i = openTags.length - 1; i >= common; i--) result += `</${openTags[i]}>`;
    for (let i = common; i < desired.length; i++) result += `<${desired[i]}>`;
    openTags = [...desired];
  };

  let pos = 0;
  while (pos < text.length) {
    applyEvents(pos);
    transition();

    const replacement = replacements.get(pos);
    if (replacement) {
      result += escapeHtml(replacement.label);
      // Consume events inside the replaced source span so state at its end is
      // still correct. Interior transitions are intentionally not emitted.
      for (let skipped = pos + 1; skipped < replacement.end; skipped++) applyEvents(skipped);
      pos = replacement.end;
      continue;
    }

    result += escapeHtml(text[pos]!);
    pos++;
  }

  applyEvents(text.length);
  transition();
  // Defensive close in case malformed input left an unmatched active range.
  for (let i = openTags.length - 1; i >= 0; i--) result += `</${openTags[i]}>`;
  return result;
}

/**
 * Format a sender message as:
 *   <b>SenderName:</b>
 *   content…
 */
export function formatGroupMsg(senderName: string, content: string): string {
  return `<b>${escapeHtml(truncate(senderName, 64))}:</b>\n${escapeHtml(truncate(content))}`;
}

/**
 * Format a group message with pre-escaped HTML body (e.g. when mention spans
 * have already been wrapped in <b> tags).
 */
export function formatGroupMsgHtml(senderName: string, bodyHtml: string): string {
  return `<b>${escapeHtml(truncate(senderName, 64))}:</b>\n${bodyHtml}`;
}

/** Caption for media (bold sender name). */
export function groupCaption(senderName: string): string {
  return `<b>${escapeHtml(truncate(senderName, 64))}</b>`;
}

/**
 * Format a Telegram Topic name:
 *   👤 Name  (DM)
 *   👥 Name  (Group)
 * Telegram's max topic name length is 128 visible characters.
 */
export function topicName(name: string, type: 0 | 1): string {
  return graphemes(`${type === 1 ? '👥' : '👤'} ${name}`).slice(0, 128).join('');
}
