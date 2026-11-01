import { createHash } from 'node:crypto';

export const JSON_EXPANSION_TRUNCATION_MARKER = '\n…[sumidx: json arguments truncated]…';

/**
 * Convert DSH content blocks into searchable plain text without touching
 * provider-private replay state. Reasoning blocks are intentionally omitted:
 * the index must be grounded in model-visible conversation content.
 *
 * @param {unknown} content
 * @returns {string}
 */
export function contentBlocksToText(content) {
  if (typeof content === 'string') return content;
  if (content === null || content === undefined) return '';
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (typeof block === 'string') {
        parts.push(block);
        continue;
      }
      if (block === null || typeof block !== 'object') continue;
      if (block.type === 'reasoning') continue;
      if (block.type === 'tool-call') {
        if (typeof block.name === 'string') parts.push('tool-call ' + block.name);
        if (typeof block.arguments === 'string') {
          const expanded = expandJsonText(block.arguments);
          parts.push(expanded.length > 0 ? expanded : block.arguments);
        }
        continue;
      }
      if (typeof block.text === 'string') {
        parts.push(block.text);
        continue;
      }
      if (block.content !== undefined) {
        const nested = contentBlocksToText(block.content);
        if (nested.length > 0) parts.push(nested);
      }
    }
    return parts.join('\n').trim();
  }
  if (typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    if (content.content !== undefined) return contentBlocksToText(content.content);
  }
  return '';
}

/**
 * Extract only the model-visible/source-relevant text of one session event.
 * The result is bounded and samples the head, middle and tail so long tool
 * output keeps its diagnostic middle section instead of being head-truncated.
 *
 * @param {any} event
 * @param {{maxChars?: number}} [options]
 * @returns {string}
 */
export function eventText(event, options = {}) {
  return eventTextDetailed(event, options).text;
}

/**
 * Same extraction as {@link eventText}, plus an explicit sampling flag for
 * guards that must know whether part of the source event was omitted.
 *
 * @param {any} event
 * @param {{maxChars?: number}} [options]
 * @returns {{text: string, sampled: boolean}}
 */
export function eventTextDetailed(event, options = {}) {
  const maxChars = positiveInt(options.maxChars, 1_000_000);
  const data = event?.data;
  let raw = '';
  switch (event?.type) {
    case 'user/message':
      raw = contentBlocksToText(data?.content ?? data?.message?.content);
      break;
    case 'system/message':
    case 'assistant/message':
      raw = contentBlocksToText(data?.message?.content ?? data?.content);
      break;
    case 'tool/result':
      raw = contentBlocksToText(data?.message?.content ?? data?.content);
      break;
    case 'tool/call': {
      const args = typeof data?.arguments === 'string' ? expandJsonText(data.arguments) : '';
      raw = [data?.name, args || data?.arguments].filter((value) => typeof value === 'string').join('\n');
      break;
    }
    case 'compaction/summary':
      raw = contentBlocksToText(data?.summary);
      break;
    default:
      raw = '';
  }
  return {
    text: sampleTranscript(raw, maxChars),
    sampled: raw.length > maxChars || raw.includes(JSON_EXPANSION_TRUNCATION_MARKER),
  };
}

/**
 * Turn a raw JSON tool-argument string into searchable semantic text. Tool
 * arguments are JSON, so Windows paths arrive doubled-escaped. Extracting from
 * the parsed values keeps a source anchor equal to the path a summary normally
 * writes, while still retaining object keys and scalar values.
 *
 * @param {string} raw
 * @param {number} [maxChars]
 * @returns {string}
 */
export function expandJsonText(raw, maxChars = 1_000_000) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return '';
  }
  const out = [];
  const visit = (value, depth) => {
    if (out.length >= maxChars || depth > 8) return;
    if (typeof value === 'string') {
      if (value.length > 0) out.push(value);
      return;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      out.push(String(value));
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        out.push(key);
        visit(item, depth + 1);
      }
    }
  };
  visit(parsed, 0);
  return boundedJsonText(out.join('\n'), maxChars);
}

function boundedJsonText(text, maxChars) {
  return text.length <= maxChars ? text : text.slice(0, maxChars) + JSON_EXPANSION_TRUNCATION_MARKER;
}

function sampleTranscript(text, maxChars) {
  if (text.length <= maxChars) return text;
  const headSize = Math.floor(maxChars * 0.45);
  const middleSize = Math.floor(maxChars * 0.2);
  const tailSize = maxChars - headSize - middleSize;
  const middleStart = Math.max(0, Math.floor((text.length - middleSize) / 2));
  return [
    text.slice(0, headSize),
    '\n…[sumidx: middle sample]…\n',
    text.slice(middleStart, middleStart + middleSize),
    '\n…[sumidx: tail sample]…\n',
    text.slice(Math.max(0, text.length - tailSize)),
  ].join('');
}

/**
 * Best-effort redaction for values that must be stored in the index or shown in
 * an injected index card. Raw `sumidx_read` output intentionally uses the
 * original event payload and is not redacted, because it is the existing
 * session record rather than a second durable copy.
 *
 * @param {string} input
 * @returns {string}
 */
export function redactSecrets(input) {
  if (typeof input !== 'string' || input.length === 0) return '';
  let text = input;
  text = text.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]');
  text = text.replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{12,})\b/g, '[REDACTED TOKEN]');
  text = text.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED JWT]');
  text = text.replace(/(\/\/)([^/@\s:]+):([^/@\s]+)@/g, '$1[REDACTED]@');
  text = text.replace(/(\b(?:api[_-]?key|token|secret|password|passwd|authorization)\b\s*[:=]\s*)([^\s,;]{8,})/gi, '$1[REDACTED]');
  return text;
}

/**
 * @param {string} value
 * @returns {boolean}
 */
export function isLikelySensitive(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)) return true;
  if (/^(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{12,})$/i.test(value)) return true;
  if (/^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/i.test(value)) return true;
  if (/https?:\/\/[^/\s@]+:[^/\s@]+@/i.test(value)) return true;
  if (/[?&](?:access_token|api_?key|token|secret|password|signature|sig)=/i.test(value)) return true;
  return false;
}

/**
 * @param {string} input
 * @param {number} max
 * @param {string} [suffix]
 * @returns {string}
 */
export function clip(input, max, suffix = '…') {
  const text = typeof input === 'string' ? input : String(input ?? '');
  if (max <= 0) return '';
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - suffix.length)) + suffix;
}

/**
 * Produce a small context window around a literal match.
 *
 * @param {string} text
 * @param {number} index
 * @param {number} [radius]
 * @returns {string}
 */
export function snippetAround(text, index, radius = 90) {
  if (typeof text !== 'string' || text.length === 0) return '';
  const at = Number.isFinite(index) ? Math.max(0, Math.min(text.length - 1, index)) : 0;
  const start = Math.max(0, at - radius);
  const end = Math.min(text.length, at + radius);
  return redactSecrets(text.slice(start, end).replace(/\s+/g, ' ').trim());
}

/**
 * Character-addressed pagination for tool reads. Offsets and limits are in
 * JavaScript UTF-16 code units, matching String#slice.
 *
 * @param {string} input
 * @param {number} offset
 * @param {number} limit
 * @returns {{text: string, offset: number, nextOffset: number|null, total: number, truncated: boolean}}
 */
export function charPage(input, offset = 0, limit = 8000) {
  const text = typeof input === 'string' ? input : String(input ?? '');
  const start = clampInt(offset, 0, text.length, 0);
  const size = clampInt(limit, 1, 50_000, 8000);
  const end = Math.min(text.length, start + size);
  return {
    text: text.slice(start, end),
    offset: start,
    nextOffset: end < text.length ? end : null,
    total: text.length,
    truncated: end < text.length,
  };
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
export function positiveInt(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
export function clampInt(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

/**
 * @param {string} value
 * @returns {string}
 */
export function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

/**
 * @param {string} value
 * @returns {string}
 */
export function safeFileComponent(value) {
  const text = String(value ?? 'unknown');
  const clean = text.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/\.{2,}/g, '.').replace(/^\.+/, '').slice(0, 64) || 'session';
  return sha256(text).slice(0, 16) + '-' + clean;
}

/**
 * Reduce arbitrary text to a stable, lowercase token stream suitable for a
 * local lexical search. CJK runs also get bigrams so a two-character query can
 * match a longer Chinese sentence.
 *
 * @param {string} value
 * @returns {string[]}
 */
export function searchTerms(value) {
  const normalized = String(value ?? '').normalize('NFKC').toLowerCase();
  const terms = new Set();
  const exact = normalized.replace(/\s+/g, ' ').trim();
  if (exact.length >= 2) terms.add(exact);
  for (const match of normalized.matchAll(/[\p{L}\p{N}_./:@\\-]+/gu)) {
    const token = match[0];
    if (token.length >= 2 && !/^[/\\:.-]+$/.test(token)) terms.add(token);
    for (const run of token.matchAll(/[\p{Script=Han}]{2,}/gu)) {
      const chars = [...run[0]];
      for (let index = 0; index + 1 < chars.length; index++) terms.add(chars[index] + chars[index + 1]);
    }
  }
  return [...terms].slice(0, 64);
}

/**
 * Tokenize a section so we can heuristically point it back to source events.
 *
 * @param {string} value
 * @returns {string[]}
 */
export function pointerTerms(value) {
  const terms = new Set();
  const normalized = String(value ?? '').normalize('NFKC').toLowerCase();
  for (const match of normalized.matchAll(/[\p{L}\p{N}_]{4,}/gu)) terms.add(match[0]);
  for (const run of normalized.matchAll(/[\p{Script=Han}]{2,}/gu)) {
    const chars = [...run[0]];
    for (let index = 0; index + 1 < chars.length; index++) terms.add(chars[index] + chars[index + 1]);
  }
  return [...terms].slice(0, 96);
}
