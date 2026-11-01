import {
  clip,
  contentBlocksToText,
  eventText,
  eventTextDetailed,
  isLikelySensitive,
  pointerTerms,
  positiveInt,
  redactSecrets,
  searchTerms,
  sha256,
  snippetAround,
} from './text.mjs';

export const ENTRY_SCHEMA = 'sumidx.entry/v1';
export const SECTION_KEYS = ['goal', 'decisions', 'currentState', 'nextSteps', 'anchors'];
export const SECTION_LABELS = Object.freeze({
  goal: 'Goal and intent',
  decisions: 'Decisions',
  currentState: 'Current state',
  nextSteps: 'Next steps',
  anchors: 'Anchors',
});

const SECTION_ALIASES = new Map();
for (const [key, aliases] of Object.entries({
  goal: ['goal and intent', 'goal & intent', 'goal/intent', 'goal', 'intent', '目标与意图', '目标', '意图'],
  decisions: ['decisions', 'key decisions', 'decision log', 'decisions made', '关键决策', '决策', '已做决策'],
  currentState: ['current state', 'current status', 'current phase', '当前状态', '现状', '当前进展'],
  nextSteps: ['next steps', 'next actions', 'next todo', 'follow ups', 'follow-ups', '下一步', '后续步骤', '待办'],
  anchors: ['anchors', 'exact anchors', 'identifiers', 'exact values', '锚点', '精确锚点', '关键标识符', '标识符'],
})) {
  for (const alias of aliases) SECTION_ALIASES.set(alias, key);
}

/**
 * Parse the five-section handoff skeleton, accepting common English/Chinese
 * heading aliases and markdown decorations. Unknown prose is retained in
 * `unstructured`, and every parsed section keeps its original (bounded) body.
 *
 * @param {string} summaryText
 * @param {{maxSectionChars?: number}} [options]
 * @returns {{
 *   text: string,
 *   sections: Record<string, string>,
 *   present: Record<string, boolean>,
 *   missing: string[],
 *   complete: boolean,
 *   unstructured: string
 * }}
 */
export function parseSummarySections(summaryText, options = {}) {
  const text = typeof summaryText === 'string' ? summaryText : '';
  const maxSectionChars = positiveInt(options.maxSectionChars, 4000);
  const buckets = new Map(SECTION_KEYS.map((key) => [key, []]));
  const unstructured = [];
  let current = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const heading = summaryHeading(rawLine);
    if (heading !== null) {
      current = heading.key;
      if (heading.inline.length > 0) buckets.get(current).push(heading.inline);
      continue;
    }
    if (current === null) unstructured.push(rawLine);
    else buckets.get(current).push(rawLine);
  }

  const sections = {};
  const present = {};
  for (const key of SECTION_KEYS) {
    const body = buckets.get(key).join('\n').trim();
    sections[key] = clip(body, maxSectionChars);
    present[key] = body.length > 0;
  }
  const missing = SECTION_KEYS.filter((key) => !present[key]);
  return {
    text: clip(text, Math.max(maxSectionChars * SECTION_KEYS.length, maxSectionChars)),
    sections,
    present,
    missing,
    complete: missing.length === 0,
    unstructured: clip(unstructured.join('\n').trim(), maxSectionChars),
  };
}

function summaryHeading(line) {
  let value = String(line ?? '').trim();
  if (value.length === 0 || value.length > 120) return null;
  let marked = false;
  let headingPart = value;

  if (/^#{1,6}\s+/.test(value)) {
    marked = true;
    headingPart = value.replace(/^#{1,6}\s+/, '');
  } else if (/^\d+[.)]\s+/.test(value)) {
    marked = true;
    headingPart = value.replace(/^\d+[.)]\s+/, '');
  } else if (/^\*\*[\s\S]+\*\*$/.test(value) || /^__[\s\S]+__$/.test(value)) {
    marked = true;
    headingPart = value.slice(2, -2).trim();
  }

  // Support headings such as `## 1. Goal and intent` and
  // `### 2) **Decisions**`.
  headingPart = headingPart.replace(/^\d+[.)]\s+/, '').trim();
  headingPart = headingPart.replace(/^[*_`\s]+|[*_`\s]+$/g, '').trim();
  let candidate = headingPart;
  let inline = '';
  const separator = headingPart.search(/[:：]/u);
  if (separator >= 0) {
    candidate = headingPart.slice(0, separator).trim();
    inline = headingPart.slice(separator + 1).trim();
  }
  const normalized = candidate
    .replace(/^[*_`\s]+|[*_`\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
  const key = SECTION_ALIASES.get(normalized);
  if (key === undefined) return null;

  // A bare sentence that happens to start with an alias is not a heading. A
  // marked line, an exact short heading, or a heading followed by ':' is.
  if (!marked && separator < 0 && normalized !== candidate.toLowerCase().trim()) return null;
  if (!marked && separator < 0 && inline.length === 0 && value !== candidate) return null;
  if (candidate.length > 42) return null;
  return { key, inline };
}

const FILE_EXTENSIONS = new Set([
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'md', 'mdx',
  'py', 'go', 'java', 'kt', 'kts', 'rs', 'cs', 'cpp', 'cc', 'cxx', 'h', 'hpp', 'sh', 'ps1',
  'bat', 'cmd', 'env', 'lock', 'txt', 'ini', 'cfg', 'conf', 'xml', 'sql', 'proto', 'graphql',
  'css', 'scss', 'less', 'html', 'htm', 'vue', 'svelte', 'dockerfile', 'makefile', 'gradle',
]);

const BASE_ANCHOR_PATTERNS = [
  { kind: 'url', regex: /\bhttps?:\/\/[^\s<>"'`\]\)}]+/gi, trim: true },
  { kind: 'email', regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  { kind: 'uuid', regex: /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi },
  { kind: 'hash', regex: /\b(?:[0-9a-f]{64}|[0-9a-f]{40})\b/gi },
  { kind: 'network', regex: /\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}\b/gi },
  { kind: 'network', regex: /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?::\d{1,5})?\b/g },
  { kind: 'network', regex: /\b(?:localhost|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}):\d{2,5}\b/gi },
  { kind: 'path', regex: /\b[A-Za-z]:\\[^\s<>"|?*\r\n]+/g, trim: true },
  { kind: 'path', regex: /\\\\[^\s<>"|?*\r\n]+/g, trim: true },
  { kind: 'path', regex: /(?<![:\w])\/(?:[\w.@+-]+\/)+[\w.@+-]+/g, trim: true },
  { kind: 'path', regex: /(?<![:\w/])(?:\.{1,2}\/)?(?:[\w@.+-]+\/)+[\w@.+-]+/g, trim: true },
  { kind: 'path', regex: /(?<![\w.\\/-])[\w@.+-]+\.(?:[A-Za-z0-9]{1,12})(?![\w])/g, extensionOnly: true, trim: true },
  { kind: 'error', regex: /\bE[A-Z][A-Z0-9_]{2,}\b/g },
  { kind: 'error', regex: /\bE\d{3,5}\b/g },
  { kind: 'error', regex: /\b(?:HTTP(?:\/\d(?:\.\d)?)?|status(?:\s+code)?|状态码)\s*[:=]?\s*([1-5]\d{2})\b/gi, group: 1 },
  { kind: 'config', regex: /(?<![\w-])--[a-z][a-z0-9-]{1,}/gi },
  { kind: 'config', regex: /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){1,}\b/g },
  { kind: 'config', regex: /\b(?:config|setting|option|env|key)\s*[:=]?\s*([a-z_][\w-]*(?:\.[\w-]+){1,})\b/gi, group: 1 },
  { kind: 'config', regex: /(?<![\w/.-])[a-z_][\w-]*(?:\.[a-z_][\w-]*){2,}(?![\w])/g },
  { kind: 'config', regex: /\b(?:config|setting|option|env(?:ironment)?|key|parameter|param)\s*[:=]?\s*`?([a-z_][\w-]*(?:[._][\w-]+)+)`?/gi, group: 1 },
  { kind: 'version', regex: /(?<![\d.])v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b(?![\d.])/g },
  { kind: 'identifier', regex: /\b[A-Z]{2,10}-\d{2,}\b/g },
  { kind: 'identifier', regex: /\b(?:commit|sha|hash|revision|rev)\s*[:=]?\s*([0-9a-f]{7,40})\b/gi, group: 1 },
  { kind: 'port', regex: /\b(?:port|listen(?:ing)?\s+on)\s*[:=]?\s*(\d{2,5})\b/gi, group: 1 },
  { kind: 'symbol', regex: /\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(\s*\)/g, group: 1 },
  { kind: 'literal', regex: /`([^`\n]{2,120})`/g, group: 1, codeSpan: true },
];

const COMMON_NOISE = new Set([
  'and', 'the', 'for', 'with', 'true', 'false', 'null', 'undefined', 'string', 'number',
  'object', 'array', 'error', 'errors', 'failed', 'failure', 'passed', 'success', 'successful',
  'goal', 'intent', 'decisions', 'decision', 'state', 'status', 'anchors', 'next', 'steps',
]);

/**
 * Deterministically extract P0 exact literals from source events. Every anchor
 * carries the seq of the first source event in which the literal appeared.
 *
 * @param {Array<{seq:number, type:string, text:string}>} records
 * @param {{maxAnchors?: number}} [options]
 * @returns {{anchors: Array<any>, stats: any}}
 */
export function extractAnchors(records, options = {}) {
  const maxAnchors = positiveInt(options.maxAnchors, 256);
  const byValue = new Map();
  let suppressedSensitive = 0;
  let rejectedNoise = 0;

  for (const record of records) {
    const text = typeof record?.text === 'string' ? record.text : '';
    if (text.length === 0) continue;
    const urlRanges = [];
    for (const pattern of BASE_ANCHOR_PATTERNS) {
      pattern.regex.lastIndex = 0;
      for (const match of text.matchAll(pattern.regex)) {
        const raw = match[0];
        const matchIndex = match.index ?? 0;
        if (pattern.kind === 'url') urlRanges.push([matchIndex, matchIndex + raw.length]);
        // A URL already retains its host, port, path and query exactly. Do not
        // turn each nested fragment into a second required anchor unless the
        // URL itself was rejected as sensitive.
        if (pattern.kind !== 'url' && urlRanges.some(([start, end]) => matchIndex >= start && matchIndex < end)) {
          continue;
        }
        let value = pattern.group ? match[pattern.group] : raw;
        if (typeof value !== 'string') continue;
        value = normalizeLiteral(value, pattern);
        if (!acceptableLiteral(value, pattern)) {
          rejectedNoise++;
          continue;
        }
        if (isLikelySensitive(value)) {
          suppressedSensitive++;
          continue;
        }
        const index = match.index ?? text.indexOf(value);
        const existing = byValue.get(value);
        if (existing !== undefined) continue;
        byValue.set(value, {
          id: 'a' + (byValue.size + 1),
          kind: pattern.kind,
          value,
          sourceSeq: record.seq,
          sourceType: record.type,
          priority: 'P0',
          required: true,
          snippet: snippetAround(text, index, 80),
          note: pattern.kind === 'literal' ? 'inline-code' : undefined,
        });
        if (byValue.size >= maxAnchors) {
          return {
            anchors: [...byValue.values()],
            stats: {
              extracted: byValue.size,
              truncated: true,
              suppressedSensitive,
              rejectedNoise,
            },
          };
        }
      }
    }
  }

  return {
    anchors: [...byValue.values()],
    stats: {
      extracted: byValue.size,
      truncated: false,
      suppressedSensitive,
      rejectedNoise,
    },
  };
}

function normalizeLiteral(value, pattern) {
  let text = String(value ?? '').trim();
  if (pattern.trim || pattern.codeSpan) {
    text = text.replace(/[.,;:!?，。；：！？)\]}>》】"'`*]+$/u, '');
    text = text.replace(/^[(\[<《【"'`]+/u, '');
  }
  if (pattern.codeSpan) text = text.trim();
  return text;
}

function acceptableLiteral(value, pattern) {
  if (value.length < 2 || value.length > 240) return false;
  if (/[\r\n\t]/.test(value)) return false;
  if (pattern.extensionOnly) {
    const extension = value.split('.').at(-1).toLowerCase();
    if (!FILE_EXTENSIONS.has(extension)) return false;
  }
  if (pattern.requireMixed) {
    if (!/[0-9]/.test(value) || !/[a-z]/i.test(value)) return false;
  }
  if (pattern.kind === 'network') {
    if (value.includes(':') && !value.includes('.') && !value.includes('::') && !/^localhost:/i.test(value)) {
      // A pair like `host:8080` needs a plausible host, not an arbitrary label.
      const host = value.slice(0, value.lastIndexOf(':'));
      if (!/[.:]/.test(host)) return false;
    }
  }
  if (pattern.kind === 'port' && !/^\d{2,5}$/.test(value)) return false;
  if (pattern.kind === 'literal') {
    // Only atomic inline-code literals become required P0 anchors. Commands
    // such as `npm test` stay P1 prose; treating every code span as P0 would
    // over-quarantine summaries that correctly omit routine command lines.
    if (/\s/.test(value)) return false;
    if (!/[\p{L}\p{N}_./:@\\-]/u.test(value)) return false;
  }
  if (COMMON_NOISE.has(value.toLowerCase())) return false;
  return true;
}

/**
 * Normalize raw session events into records used by anchor extraction and
 * validation. Tool call/result pairs are correlated by callId.
 *
 * @param {Array<any>} events
 * @param {{maxEventChars?: number, maxTotalChars?: number}} [options]
 * @returns {{records: Array<any>, validationFacts: Array<any>, stats: any}}
 */
export function normalizeSourceEvents(events, options = {}) {
  const maxEventChars = positiveInt(options.maxEventChars, 1_000_000);
  const maxTotalChars = positiveInt(options.maxTotalChars, 12_000_000);
  const callNames = new Map();
  const records = [];
  const validationFacts = [];
  let totalChars = 0;
  let truncatedByTotal = false;
  let omittedEvents = 0;
  let sampledEvents = 0;

  for (const event of events) {
    if (!event || !Number.isSafeInteger(event.seq)) continue;
    const extractedText = eventTextDetailed(event, { maxChars: maxEventChars });
    const text = extractedText.text;
    if (event.type === 'tool/call' && event.data?.callId && typeof event.data.name === 'string') {
      callNames.set(event.data.callId, event.data.name);
    }
    // `tool/call` is log-only in DSH and is not part of a compaction's surface
    // shadowedSeqs. The same call is embedded in the assistant message's
    // `tool-call` content block, so correlate from there as well.
    if (event.type === 'assistant/message') {
      const blocks = event.data?.message?.content;
      if (Array.isArray(blocks)) {
        for (const block of blocks) {
          if (block?.type === 'tool-call' && typeof block.id === 'string' && typeof block.name === 'string') {
            callNames.set(block.id, block.name);
          }
        }
      }
    }
    let isError = false;
    let errorCode = '';
    let toolCallId;
    if (event.type === 'tool/result') {
      const resultBlock = event.data?.message?.content?.[0];
      toolCallId = typeof resultBlock?.toolCallId === 'string' ? resultBlock.toolCallId : undefined;
      isError = resultBlock?.isError === true || event.data?.error !== undefined;
      errorCode = typeof event.data?.error?.code === 'string' ? event.data.error.code : '';
    }

    if (totalChars + text.length > maxTotalChars) {
      truncatedByTotal = true;
      omittedEvents++;
      continue;
    }
    totalChars += text.length;
    if (extractedText.sampled) sampledEvents++;
    const record = {
      seq: event.seq,
      type: event.type,
      text,
      callId: toolCallId ?? (typeof event.data?.callId === 'string' ? event.data.callId : undefined),
      toolName: event.type === 'tool/result' && toolCallId
        ? callNames.get(toolCallId)
        : event.type === 'tool/call' ? event.data?.name : event.data?.name,
      isError,
      errorCode,
    };
    records.push(record);

    if (event.type === 'tool/result') {
      const body = redactSecrets(text.replace(/\s+/g, ' ').trim());
      validationFacts.push({
        seq: event.seq,
        toolName: record.toolName ?? '(unknown tool)',
        outcome: isError ? 'failed' : 'passed',
        errorCode: errorCode || undefined,
        snippet: clip(body, 220),
      });
    }
  }

  return {
    records,
    validationFacts: validationFacts.slice(-200),
    stats: {
      eventCount: records.length,
      requestedEventCount: events.length,
      totalChars,
      truncatedByTotal,
      omittedEvents,
      sampledEvents,
      maxEventChars,
      maxTotalChars,
    },
  };
}

/**
 * Point a structured section at up to `limit` source events that share the most
 * distinctive terms with it. This is a coarse P1 provenance pointer, not a
 * claim of sentence-level entailment.
 *
 * @param {string} sectionText
 * @param {Array<any>} records
 * @param {number} [limit]
 * @returns {number[]}
 */
export function selectSectionPointers(sectionText, records, limit = 3) {
  const terms = pointerTerms(sectionText);
  if (terms.length === 0 || records.length === 0) return [];
  const scored = [];
  for (const record of records) {
    const haystack = String(record.text ?? '').toLowerCase();
    if (haystack.length === 0) continue;
    let score = 0;
    for (const term of terms) {
      if (haystack.includes(term)) score += Math.min(4, term.length);
    }
    if (score > 0) scored.push({ seq: record.seq, score });
  }
  scored.sort((left, right) => right.score - left.score || left.seq - right.seq);
  return scored.slice(0, positiveInt(limit, 3)).map((entry) => entry.seq);
}


/**
 * Build one deterministic structured index entry from a committed
 * `compaction/summary` session event.
 *
 * @param {{
 *   sessionId: string,
 *   workspace?: string,
 *   event: any,
 *   sourceRecords: Array<any>,
 *   validationFacts?: Array<any>,
 *   sourceStats?: any,
 *   guardMode?: 'enforce'|'compat'|'observe',
 *   maxAnchors?: number,
 *   maxSectionChars?: number,
 *   now?: number
 * }} input
 * @returns {any}
 */
export function buildIndexEntry(input) {
  const event = input.event;
  const data = event?.data ?? {};
  const summaryText = contentBlocksToText(data.summary);
  const parsed = parseSummarySections(summaryText, { maxSectionChars: input.maxSectionChars });
  const extracted = extractAnchors(input.sourceRecords, { maxAnchors: input.maxAnchors });
  const sourceSeqSet = new Set(input.sourceRecords.map((record) => record.seq));
  const sourceRecordBySeq = new Map(input.sourceRecords.map((record) => [record.seq, record]));
  const shadowedSeqs = Array.isArray(data.shadowedSeqs)
    ? data.shadowedSeqs.filter((seq) => Number.isSafeInteger(seq))
    : [];
  const missingSourceSeqs = shadowedSeqs.filter((seq) => !sourceSeqSet.has(seq));
  const anchors = extracted.anchors.map((anchor) => ({
    ...anchor,
    inSummary: summaryText.includes(anchor.value),
    inAnchorsSection: parsed.sections.anchors.includes(anchor.value),
  }));
  const pointerFailures = anchors.filter((anchor) => {
    const record = sourceRecordBySeq.get(anchor.sourceSeq);
    return record === undefined || !String(record.text ?? '').includes(anchor.value);
  });
  const notInAnchors = anchors.filter((anchor) => anchor.required && !anchor.inAnchorsSection);
  const notAnywhere = anchors.filter((anchor) => anchor.required && !anchor.inSummary);
  const sourceTruncated = input.sourceStats?.truncatedByTotal === true
    || input.sourceStats?.sampledEvents > 0;
  const anchorsTruncated = extracted.stats.truncated === true;
  const summaryEmpty = summaryText.trim().length === 0;
  const missingSections = [...parsed.missing];
  const mode = input.guardMode === 'compat' || input.guardMode === 'observe' ? input.guardMode : 'enforce';

  const reasons = [];
  const warnings = [];
  if (summaryEmpty) reasons.push('summary-empty');
  if (mode !== 'observe') {
    if (shadowedSeqs.length === 0) reasons.push('shadowed-seqs-missing');
    if (missingSourceSeqs.length > 0) reasons.push('source-events-missing');
    if (sourceTruncated) reasons.push('source-scan-truncated');
    if (anchorsTruncated) reasons.push('anchor-extraction-truncated');
    if (pointerFailures.length > 0) reasons.push('anchor-pointer-unresolvable');
    if (mode === 'enforce') {
      if (missingSections.length > 0) reasons.push('five-section-incomplete');
      if (notAnywhere.length > 0) reasons.push('anchor-not-in-summary');
      if (notInAnchors.length > 0) reasons.push('anchor-not-in-anchors-section');
    } else {
      if (notAnywhere.length > 0) reasons.push('anchor-not-in-summary');
      if (notInAnchors.length > 0) warnings.push('anchor-not-in-anchors-section');
      if (missingSections.length > 0) warnings.push('five-section-incomplete');
    }
  }
  const uniqueReasons = [...new Set(reasons)];
  const missingAnchors = [];
  for (const anchor of anchors) {
    if (!anchor.required) continue;
    let reason = null;
    if (!anchor.inSummary) reason = 'not-in-summary';
    else if (mode === 'enforce' && !anchor.inAnchorsSection) reason = 'not-in-anchors-section';
    else if (pointerFailures.some((failure) => failure.value === anchor.value)) reason = 'pointer-unresolvable';
    if (reason !== null) {
      missingAnchors.push({
        value: anchor.value,
        kind: anchor.kind,
        sourceSeq: anchor.sourceSeq,
        reason,
      });
    }
  }

  const sectionPointers = {};
  for (const key of ['goal', 'decisions', 'currentState', 'nextSteps']) {
    sectionPointers[key] = selectSectionPointers(parsed.sections[key], input.sourceRecords, 3);
  }

  const compactionId = typeof data.compactionId === 'string' && data.compactionId.length > 0
    ? data.compactionId
    : 'summary-' + event?.seq + '-' + sha256(summaryText).slice(0, 12);
  const id = 'sumidx:' + compactionId;
  const admitted = uniqueReasons.length === 0;
  const admission = {
    status: mode === 'observe' ? 'admitted' : admitted ? 'admitted' : 'quarantined',
    mode,
    reasonCodes: uniqueReasons,
    warnings: [...new Set(warnings)],
    degraded: mode === 'compat' && missingSections.length > 0,
    missingSections,
    missingAnchors,
    missingSourceSeqs,
    pointerFailures: pointerFailures.map((anchor) => ({
      value: anchor.value,
      kind: anchor.kind,
      sourceSeq: anchor.sourceSeq,
      reason: 'literal-not-present-at-source-seq',
    })),
  };

  return {
    schema: ENTRY_SCHEMA,
    id,
    plugin: { name: 'dsh-summary-index', version: '0.1.0' },
    createdAt: Number.isSafeInteger(input.now) ? input.now : Date.now(),
    sessionId: String(input.sessionId),
    workspace: typeof input.workspace === 'string' ? input.workspace : undefined,
    compactionId,
    summarySeq: event?.seq,
    summarySha256: sha256(summaryText),
    shadowedRange: {
      start: Number.isSafeInteger(data.shadowedRange?.start) ? data.shadowedRange.start : undefined,
      end: Number.isSafeInteger(data.shadowedRange?.end) ? data.shadowedRange.end : undefined,
    },
    shadowedSeqs,
    shadowedTokenCount: Number.isSafeInteger(data.shadowedTokenCount) ? data.shadowedTokenCount : undefined,
    provider: typeof data.provider === 'string' ? data.provider : undefined,
    model: typeof data.model === 'string' ? data.model : undefined,
    summary: {
      text: clip(redactSecrets(summaryText), Math.max(positiveInt(input.maxSectionChars, 4000) * 6, 8000)),
      sections: Object.fromEntries(SECTION_KEYS.map((key) => [key, redactSecrets(parsed.sections[key])])),
      present: parsed.present,
      missing: parsed.missing,
      complete: parsed.complete,
      unstructured: redactSecrets(parsed.unstructured),
      anchorsSectionPreview: clip(redactSecrets(parsed.sections.anchors), 8000),
    },
    sectionPointers,
    anchors,
    anchorStats: extracted.stats,
    validationFacts: input.validationFacts ?? [],
    source: {
      ...(input.sourceStats ?? {}),
      shadowedEventCount: shadowedSeqs.length,
      indexedSourceEventCount: input.sourceRecords.length,
      sourceCharsIndexed: input.sourceRecords.reduce((sum, record) => sum + String(record.text ?? '').length, 0),
    },
    admission,
    probes: undefined,
  };
}

/**
 * Run deterministic reachability probes. A probe is deliberately not a ROUGE
 * score: it checks that the visible index can lead to the exact source event
 * and that the exact literal is still present there.
 *
 * @param {any} entry
 * @param {(seq:number)=>any} getEvent
 * @param {{limit?: number, maxEventChars?: number}} [options]
 * @returns {any}
 */
export function runEntryProbes(entry, getEvent, options = {}) {
  const limit = positiveInt(options.limit, 24);
  const maxEventChars = positiveInt(options.maxEventChars, 1_000_000);
  const items = [];
  const get = (seq) => {
    try {
      return getEvent(seq);
    } catch {
      return undefined;
    }
  };

  const anchors = (entry.anchors ?? []).filter((anchor) => anchor.required).slice(0, limit);
  for (const anchor of anchors) {
    const sourceEvent = get(anchor.sourceSeq);
    const sourceText = sourceEvent ? eventText(sourceEvent, { maxChars: maxEventChars }) : '';
    items.push({
      type: 'pointer',
      critical: true,
      anchorId: anchor.id,
      sourceSeq: anchor.sourceSeq,
      target: anchor.value,
      status: sourceEvent && sourceText.includes(anchor.value) ? 'passed' : 'failed',
      detail: sourceEvent ? 'source event exists and contains the exact literal' : 'source event is not available',
    });
    const searchResult = searchEntries([entry], anchor.value, { status: 'all', limit: 1 })[0];
    items.push({
      type: 'index-search',
      critical: true,
      anchorId: anchor.id,
      sourceSeq: anchor.sourceSeq,
      target: anchor.value,
      status: searchResult?.entry?.id === entry.id ? 'passed' : 'failed',
      detail: searchResult ? 'sumidx_search can recover the owning entry' : 'no lexical index hit',
    });
    items.push({
      type: 'event-read',
      critical: true,
      anchorId: anchor.id,
      sourceSeq: anchor.sourceSeq,
      target: anchor.value,
      status: sourceEvent && sourceText.includes(anchor.value) ? 'passed' : 'failed',
      detail: sourceEvent ? 'the original source event can satisfy an exact read/search' : 'raw source event is unavailable',
    });
  }

  const missingShadowed = (entry.shadowedSeqs ?? []).filter((seq) => get(seq) === undefined);
  items.push({
    type: 'source-range',
    critical: true,
    status: missingShadowed.length === 0 ? 'passed' : 'failed',
    detail: missingShadowed.length === 0
      ? 'every shadowed source seq is readable'
      : 'missing source seqs: ' + missingShadowed.slice(0, 12).join(', '),
  });

  const replacementSeq = Number.isSafeInteger(entry.summarySeq) ? entry.summarySeq + 1 : undefined;
  const replacement = replacementSeq === undefined ? undefined : get(replacementSeq);
  const replacementOp = replacement?.surfaceOp;
  const replacementOk = replacement?.type === 'user/message'
    && replacementOp?.op === 'replace'
    && (entry.shadowedRange?.start === undefined || replacementOp.startSeq === entry.shadowedRange.start)
    && (entry.shadowedRange?.end === undefined || replacementOp.endSeq === entry.shadowedRange.end);
  items.push({
    type: 'replacement-pointer',
    critical: false,
    sourceSeq: replacementSeq,
    status: replacement === undefined ? 'pending' : replacementOk ? 'passed' : 'failed',
    detail: replacement === undefined
      ? 'the compaction replacement has not been observed yet'
      : replacementOk
        ? 'the adjacent replacement targets the recorded shadowed range'
        : 'adjacent event is not the expected replacement',
  });

  const passed = items.filter((item) => item.status === 'passed').length;
  const failed = items.filter((item) => item.status === 'failed').length;
  const pending = items.filter((item) => item.status === 'pending').length;
  const criticalFailed = items.filter((item) => item.critical && item.status === 'failed').length;
  return {
    total: items.length,
    passed,
    failed,
    pending,
    criticalFailed,
    sampledAnchors: anchors.length,
    anchorCount: (entry.anchors ?? []).filter((anchor) => anchor.required).length,
    items,
  };
}

/**
 * Gate index admission on deterministic probe outcomes. Replacement probes may
 * legitimately be pending because `compaction/summary` is committed before the
 * adjacent replacement event is appended.
 *
 * @param {any} entry
 * @param {any} probes
 * @returns {any}
 */
export function applyProbeAdmission(entry, probes) {
  if (!probes || probes.criticalFailed === 0 || entry.admission?.mode === 'observe') return entry;
  const reasons = [...new Set([...(entry.admission?.reasonCodes ?? []), 'probe-failed'])];
  return {
    ...entry,
    admission: {
      ...entry.admission,
      status: 'quarantined',
      reasonCodes: reasons,
    },
    probes,
  };
}

/**
 * Collapse duplicate ids to their latest summary sequence.
 *
 * @param {Array<any>} entries
 * @returns {Array<any>}
 */
export function latestEntries(entries) {
  const byId = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry.id !== 'string') continue;
    const prior = byId.get(entry.id);
    if (prior === undefined || (entry.summarySeq ?? 0) >= (prior.summarySeq ?? 0)) byId.set(entry.id, entry);
  }
  return [...byId.values()].sort((left, right) => (right.summarySeq ?? 0) - (left.summarySeq ?? 0));
}

/**
 * Lexical search over the structured index. This is intentionally local and
 * deterministic: no embeddings, no remote calls, and no hidden ranking model.
 *
 * @param {Array<any>} entries
 * @param {string} query
 * @param {{status?: 'admitted'|'quarantined'|'all', limit?: number}} [options]
 * @returns {Array<{entry:any, score:number, exact:boolean, matchedAnchors:Array<any>}>}
 */
export function searchEntries(entries, query, options = {}) {
  const normalizedQuery = String(query ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  const terms = searchTerms(normalizedQuery);
  const status = options.status === 'quarantined' || options.status === 'all' ? options.status : 'admitted';
  const limit = positiveInt(options.limit, 8);
  const results = [];

  for (const entry of latestEntries(entries)) {
    if (status !== 'all' && entry.admission?.status !== status) continue;
    const fields = entryFields(entry);
    let score = 0;
    let exact = false;
    if (normalizedQuery.length > 0) {
      for (const field of fields) {
        const haystack = field.text.normalize('NFKC').toLowerCase();
        if (haystack.length === 0) continue;
        if (haystack.includes(normalizedQuery)) {
          score += 40 * field.weight;
          exact = true;
        }
        for (const term of terms) {
          let from = 0;
          let count = 0;
          while (count < 5) {
            const at = haystack.indexOf(term, from);
            if (at < 0) break;
            count++;
            from = at + term.length;
          }
          if (count > 0) score += count * Math.min(6, Math.max(1, term.length)) * field.weight;
        }
      }
      if (score === 0) continue;
    }
    const matchedAnchors = (entry.anchors ?? []).filter((anchor) => {
      const value = String(anchor.value ?? '').normalize('NFKC').toLowerCase();
      if (normalizedQuery.length === 0) return true;
      return value.includes(normalizedQuery)
        || normalizedQuery.includes(value)
        || (terms.length > 0 && terms.every((term) => value.includes(term)));
    }).slice(0, 6);
    results.push({ entry, score, exact, matchedAnchors });
  }

  results.sort((left, right) => right.score - left.score
    || Number(right.exact) - Number(left.exact)
    || (right.entry.summarySeq ?? 0) - (left.entry.summarySeq ?? 0));
  return results.slice(0, limit);
}

function entryFields(entry) {
  const sections = entry.summary?.sections ?? {};
  return [
    { weight: 5, text: (entry.anchors ?? []).map((anchor) => anchor.value).join('\n') },
    { weight: 4, text: entry.id + '\n' + entry.compactionId + '\n' + (entry.provider ?? '') + '\n' + (entry.model ?? '') },
    { weight: 3, text: (entry.validationFacts ?? []).map((fact) => [fact.toolName, fact.outcome, fact.errorCode, fact.snippet].filter(Boolean).join(' ')).join('\n') },
    { weight: 2, text: sections.goal ?? '' },
    { weight: 2, text: sections.decisions ?? '' },
    { weight: 2, text: sections.currentState ?? '' },
    { weight: 2, text: sections.nextSteps ?? '' },
    { weight: 2, text: sections.anchors ?? '' },
    { weight: 1, text: entry.summary?.text ?? '' },
  ];
}

/**
 * @param {Array<{entry:any, score:number, exact:boolean, matchedAnchors:Array<any>}>} results
 * @param {string} query
 * @param {{maxAnchorsPerHit?: number}} [options]
 * @returns {string}
 */
export function renderSearchResults(results, query, options = {}) {
  const maxAnchors = positiveInt(options.maxAnchorsPerHit, 3);
  if (results.length === 0) return 'No matching summary-index entries in this session.';
  const lines = [
    'summary-index search: query=' + JSON.stringify(String(query ?? ''))
      + ' hits=' + results.length,
  ];
  for (const result of results) {
    const entry = result.entry;
    const flags = [
      entry.admission?.status ?? 'unknown',
      'seq=' + (entry.summarySeq ?? '?'),
      entry.admission?.degraded ? 'degraded' : null,
      result.exact ? 'exact' : null,
    ].filter(Boolean).join(' ');
    lines.push('');
    lines.push('[' + entry.id + '] ' + flags);
    if (entry.admission?.reasonCodes?.length) lines.push('reasons: ' + entry.admission.reasonCodes.join(','));
    if (entry.summary?.sections?.goal) lines.push('goal: ' + clip(entry.summary.sections.goal.replace(/\s+/g, ' '), 240));
    if (result.matchedAnchors.length > 0) {
      lines.push('anchors:');
      for (const anchor of result.matchedAnchors.slice(0, maxAnchors)) {
        lines.push('  - ' + anchor.kind + ' ' + JSON.stringify(anchor.value) + ' -> seq ' + anchor.sourceSeq);
      }
    }
    const validation = pickValidationSummary(entry);
    if (validation.length > 0) lines.push('validation: ' + validation.join('; '));
    lines.push('read: sumidx_read action=entry entry_id=' + JSON.stringify(entry.id));
  }
  return lines.join('\n');
}

function pickValidationSummary(entry) {
  const facts = entry.validationFacts ?? [];
  const failed = facts.filter((fact) => fact.outcome === 'failed');
  const selected = failed.length > 0 ? failed.slice(-3) : facts.slice(-2);
  return selected.map((fact) => fact.toolName + '=' + fact.outcome + (fact.errorCode ? '[' + fact.errorCode + ']' : '') + ' seq=' + fact.seq);
}

/**
 * Render the structured entry, never the raw transcript. Output is bounded but
 * callers can request a character window via `charPage` if they want full text.
 *
 * @param {any} entry
 * @param {{maxAnchors?: number, maxValidation?: number}} [options]
 * @returns {string}
 */
export function renderEntryText(entry, options = {}) {
  const maxAnchors = positiveInt(options.maxAnchors, 1000);
  const maxValidation = positiveInt(options.maxValidation, 500);
  const lines = [
    '[sumidx] ' + entry.id,
    'admission: ' + (entry.admission?.status ?? 'unknown')
      + ' mode=' + (entry.admission?.mode ?? 'unknown')
      + (entry.admission?.degraded ? ' degraded=true' : ''),
    'summary_seq: ' + (entry.summarySeq ?? '?')
      + ' compaction_id: ' + (entry.compactionId ?? '?'),
    'shadowed_events: ' + (entry.shadowedSeqs?.length ?? 0)
      + ' source_chars: ' + (entry.source?.sourceCharsIndexed ?? 0),
    'sections: ' + SECTION_KEYS.filter((key) => entry.summary?.present?.[key]).length + '/' + SECTION_KEYS.length
      + (entry.summary?.missing?.length ? ' missing=' + entry.summary.missing.join(',') : ''),
    'anchors: ' + (entry.anchors?.length ?? 0)
      + ' required=' + (entry.anchors ?? []).filter((anchor) => anchor.required).length
      + ' suppressed_sensitive=' + (entry.anchorStats?.suppressedSensitive ?? 0),
  ];
  if (entry.admission?.reasonCodes?.length) lines.push('guard_reasons: ' + entry.admission.reasonCodes.join(','));
  if (entry.admission?.missingAnchors?.length) {
    lines.push('missing_p0:');
    for (const missing of entry.admission.missingAnchors.slice(0, maxAnchors)) {
      lines.push('  - ' + missing.kind + ' ' + JSON.stringify(missing.value)
        + ' seq=' + missing.sourceSeq + ' reason=' + missing.reason);
    }
  }
  for (const key of SECTION_KEYS) {
    const body = entry.summary?.sections?.[key];
    if (!body) continue;
    lines.push('');
    lines.push('## ' + SECTION_LABELS[key]);
    lines.push(clip(body, 8000));
    const pointers = entry.sectionPointers?.[key];
    if (Array.isArray(pointers) && pointers.length > 0) lines.push('source pointers: ' + pointers.join(', '));
  }
  if (entry.anchors?.length) {
    lines.push('');
    lines.push('## Deterministic P0 anchors');
    for (const anchor of entry.anchors.slice(0, maxAnchors)) {
      lines.push('- [' + anchor.kind + '] ' + JSON.stringify(anchor.value)
        + ' -> seq ' + anchor.sourceSeq
        + ' in_anchors=' + String(anchor.inAnchorsSection === true)
        + ' in_summary=' + String(anchor.inSummary === true));
    }
    if (entry.anchors.length > maxAnchors) lines.push('- … ' + (entry.anchors.length - maxAnchors) + ' more; use sumidx_read action=entry with offset.');
  }
  if (entry.validationFacts?.length) {
    lines.push('');
    lines.push('## Validation facts (P0 status)');
    for (const fact of entry.validationFacts.slice(-maxValidation)) {
      lines.push('- seq ' + fact.seq + ' ' + fact.toolName + ' ' + fact.outcome
        + (fact.errorCode ? ' ' + fact.errorCode : '') + ' — ' + clip(fact.snippet, 180));
    }
  }
  if (entry.probes) {
    lines.push('');
    lines.push('## Probes');
    lines.push(renderProbeSummary(entry.probes));
  }
  return lines.join('\n');
}

/**
 * @param {any} probes
 * @returns {string}
 */
export function renderProbeSummary(probes) {
  if (!probes) return 'not run';
  return 'total=' + probes.total + ' passed=' + probes.passed + ' failed=' + probes.failed
    + ' pending=' + probes.pending + ' critical_failed=' + probes.criticalFailed
    + ' sampled_anchors=' + probes.sampledAnchors + '/' + probes.anchorCount;
}

/**
 * @param {any} probes
 * @param {{maxItems?: number, includePassed?: boolean}} [options]
 * @returns {string}
 */
export function renderProbeText(probes, options = {}) {
  if (!probes) return 'No probes have been recorded for this entry.';
  const maxItems = positiveInt(options.maxItems, 80);
  const lines = [
    'summary-index probes: ' + renderProbeSummary(probes),
  ];
  const visible = probes.items.filter((item) => options.includePassed === true || item.status !== 'passed');
  for (const item of visible.slice(0, maxItems)) {
    lines.push('- ' + item.status.toUpperCase() + ' ' + item.type
      + (item.sourceSeq !== undefined ? ' seq=' + item.sourceSeq : '')
      + (item.target !== undefined ? ' target=' + JSON.stringify(item.target) : '')
      + ' — ' + item.detail);
  }
  if (visible.length > maxItems) lines.push('- … ' + (visible.length - maxItems) + ' more');
  return lines.join('\n');
}

/**
 * Generate a repeatable probe pack for model-level evaluation. These questions
 * are not executed automatically; the deterministic checks above are the gate,
 * while this list lets a harness ask a model to recover the same details.
 *
 * @param {any} entry
 * @param {{limit?: number}} [options]
 * @returns {string}
 */
export function createProbeQuestions(entry, options = {}) {
  const limit = positiveInt(options.limit, 12);
  const anchors = (entry.anchors ?? []).filter((anchor) => anchor.required).slice(0, limit);
  const lines = [
    'summary-index recall probe pack for ' + entry.id,
    'Instructions: answer from the summary index first. Use sumidx_search and sumidx_read to recover the exact value; do not guess.',
  ];
  if (anchors.length === 0) {
    lines.push('(No deterministic P0 anchors were extracted from this source range.)');
    return lines.join('\n');
  }
  anchors.forEach((anchor, index) => {
    lines.push('');
    lines.push('Probe ' + (index + 1));
    lines.push('Question: What exact ' + anchor.kind + ' was recorded in source event seq ' + anchor.sourceSeq + '?');
    lines.push('Expected literal: ' + JSON.stringify(anchor.value));
    lines.push('Pass condition: sumidx_read action=event entry_id=' + JSON.stringify(entry.id)
      + ' seq=' + anchor.sourceSeq + ' contains the expected literal exactly.');
  });
  return lines.join('\n');
}

function validationCardLine(entry) {
  const facts = entry.validationFacts ?? [];
  if (facts.length === 0) return '';
  const failed = facts.filter((fact) => fact.outcome === 'failed');
  const latest = facts.at(-1);
  return 'validation: passed=' + (facts.length - failed.length) + ' failed=' + failed.length
    + (latest ? ' latest=' + latest.toolName + ' ' + latest.outcome + ' seq=' + latest.seq
      + (latest.errorCode ? ' code=' + latest.errorCode : '') : '');
}

/**
 * Build the one-shot index card injected after a new compaction. In strict mode
 * a quarantined entry is also useful: the card surfaces missing P0 values and
 * their source seqs so the model knows to fall back to the raw log rather than
 * trusting an incomplete summary.
 *
 * @param {any} entry
 * @param {{maxChars?: number, maxAnchors?: number}} [options]
 * @returns {string}
 */
export function buildInjectionCard(entry, options = {}) {
  const maxChars = positiveInt(options.maxChars, 1800);
  const maxAnchors = positiveInt(options.maxAnchors, 14);
  const admitted = entry.admission?.status === 'admitted';
  const lines = [];
  if (admitted) {
    lines.push('[sumidx] Structured compaction index admitted.');
    lines.push('entry: ' + entry.id + ' summary_seq=' + (entry.summarySeq ?? '?'));
    lines.push('coverage: sections=' + SECTION_KEYS.filter((key) => entry.summary?.present?.[key]).length + '/5'
      + ' p0_anchors=' + (entry.anchors ?? []).filter((anchor) => anchor.required).length
      + ' probes=' + (entry.probes ? renderProbeSummary(entry.probes) : 'pending'));
    const validationLine = validationCardLine(entry);
    if (validationLine) lines.push(validationLine);
    if (entry.admission?.warnings?.length) lines.push('warnings: ' + entry.admission.warnings.join(','));
    if (entry.probes && entry.probes.criticalFailed > 0) {
      lines.push('WARNING: a critical probe failed; verify before relying on this index.');
    }
    lines.push('Use sumidx_search to find older details, sumidx_read to read the exact source event or index entry, and sumidx_probe action=run to re-check reachability.');
    lines.push('Some exact P0 anchors (value -> source event seq):');
    for (const anchor of (entry.anchors ?? []).filter((anchor) => anchor.required).slice(0, maxAnchors)) {
      lines.push('- [' + anchor.kind + '] ' + JSON.stringify(anchor.value) + ' -> seq ' + anchor.sourceSeq);
    }
  } else {
    lines.push('[sumidx] Compaction summary QUARANTINED by the deterministic index guard.');
    lines.push('entry: ' + entry.id + ' summary_seq=' + (entry.summarySeq ?? '?')
      + ' reasons=' + ((entry.admission?.reasonCodes ?? []).join(',') || 'unknown'));
    lines.push('The summary is already committed by the compaction backend. This plugin does not rewrite it and cannot roll it back.');
    const validationLine = validationCardLine(entry);
    if (validationLine) lines.push(validationLine);
    lines.push('Do not assume the compacted summary is complete. Use the following deterministic P0 salvage anchors and raw event pointers as a fallback.');
    lines.push('Use sumidx_search status=all to inspect quarantined entries, sumidx_read action=event to read exact originals, and sumidx_probe action=status for the audit.');
    const salvaged = entry.admission?.missingAnchors?.length
      ? entry.admission.missingAnchors.map((missing) => ({
        kind: missing.kind, value: missing.value, sourceSeq: missing.sourceSeq,
      }))
      : (entry.anchors ?? []).filter((anchor) => anchor.required);
    for (const anchor of salvaged.slice(0, maxAnchors)) {
      lines.push('- [' + anchor.kind + '] ' + JSON.stringify(anchor.value) + ' -> seq ' + anchor.sourceSeq);
    }
  }
  return clip(lines.join('\n'), maxChars);
}

/**
 * Search one entry's original source events by a literal, case-insensitive
 * query. Results contain event seqs and small snippets; raw text stays in the
 * session log.
 *
 * @param {Array<any>} records
 * @param {string} query
 * @param {{offset?: number, limit?: number}} [options]
 * @returns {{matches: Array<any>, total: number, nextOffset: number|null}}
 */
export function searchSourceRecords(records, query, options = {}) {
  const needle = String(query ?? '');
  if (needle.length === 0) return { matches: [], total: 0, nextOffset: null };
  const offset = Math.max(0, Math.trunc(options.offset ?? 0));
  const limit = positiveInt(options.limit, 12);
  const all = [];
  for (const record of records) {
    const haystack = String(record.text ?? '').toLowerCase();
    const lowered = needle.toLowerCase();
    let from = 0;
    let count = 0;
    while (count < 20) {
      const at = haystack.indexOf(lowered, from);
      if (at < 0) break;
      count++;
      all.push({
        seq: record.seq,
        type: record.type,
        snippet: snippetAround(record.text, at, 100),
      });
      from = at + Math.max(1, lowered.length);
    }
  }
  return { matches: all.slice(offset, offset + limit), total: all.length, nextOffset: offset + limit < all.length ? offset + limit : null };
}

/**
 * Format one raw session event for `sumidx_read action=event`. This reads the
 * event's existing logged payload; it does not execute any tool again.
 *
 * @param {any} event
 * @param {{redact?: boolean}} [options]
 * @returns {string}
 */
export function renderRawEvent(event, options = {}) {
  if (!event) return 'Event not found.';
  let body;
  try {
    body = JSON.stringify(event.data, null, 2);
  } catch {
    body = String(event.data ?? '');
  }
  let visible = eventText(event, { maxChars: 50_000 });
  if (options.redact === true) {
    body = redactSecrets(body);
    visible = redactSecrets(visible);
  }
  const parts = [
    'seq: ' + event.seq,
    'type: ' + event.type,
    'time: ' + event.time,
  ];
  if (visible.trim().length > 0) {
    parts.push('model-visible-text:', visible, '', 'raw-event-data:', body);
  } else {
    parts.push('data:', body);
  }
  return parts.join('\n');
}
