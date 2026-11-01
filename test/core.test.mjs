import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyProbeAdmission,
  buildIndexEntry,
  buildInjectionCard,
  createProbeQuestions,
  extractAnchors,
  normalizeSourceEvents,
  parseSummarySections,
  runEntryProbes,
  searchEntries,
} from '../src/core.mjs';
import { redactSecrets } from '../src/text.mjs';

const UUID = '550e8400-e29b-41d4-a716-446655440000';
const HOST = '127.0.0.1:8080';

function sourceEvents() {
  return [
    {
      seq: 1,
      time: 1,
      type: 'user/message',
      data: {
        id: 'm1',
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: `Use UUID ${UUID}; request ${HOST} failed with ENOENT.` }],
      },
      surfaceOp: 'append',
    },
    {
      seq: 2,
      time: 2,
      type: 'tool/call',
      data: { turn: 1, step: 1, callId: 'call-1', name: 'read_file', arguments: '{"path":"src/index.mjs"}' },
    },
    {
      seq: 3,
      time: 3,
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'm2',
          role: 'user',
          source: { kind: 'tool', callId: 'call-1' },
          content: [{ type: 'tool-result', toolCallId: 'call-1', isError: true, content: [{ type: 'text', text: 'read_file failed ENOENT' }] }],
        },
        error: { name: 'FsError', code: 'ENOENT' },
      },
      surfaceOp: 'append',
    },
  ];
}

function summaryText({ omitErrorAnchor = false } = {}) {
  return [
    '## Goal and intent',
    'Ship a structured compaction index.',
    '',
    '## Decisions',
    `Keep the exact UUID ${UUID}.`,
    '',
    '## Current state',
    `Request ${HOST} failed with ENOENT while reading src/index.mjs.`,
    '',
    '## Next steps',
    'Re-run after fixing the endpoint.',
    '',
    '## Anchors',
    `- UUID ${UUID} -> seq 1`,
    `- endpoint ${HOST} -> seq 1`,
    `- path src/index.mjs -> seq 2`,
    ...(omitErrorAnchor ? [] : ['- error ENOENT -> seq 3']),
  ].join('\n');
}

function compactionEvent({ omitErrorAnchor = false } = {}) {
  return {
    seq: 4,
    time: 4,
    type: 'compaction/summary',
    data: {
      compactionId: 'comp-' + (omitErrorAnchor ? 'missing' : 'ok'),
      sourceCommandId: 'cmd-1',
      summary: [{ type: 'text', text: summaryText({ omitErrorAnchor }) }],
      shadowedRange: { start: 1, end: 3 },
      shadowedSeqs: [1, 2, 3],
      shadowedTokenCount: 120,
      provider: 'test-provider',
      model: 'test-model',
      llmStreamCall: true,
      rawOutput: [{ type: 'text', text: 'raw' }],
    },
  };
}

function replacementEvent() {
  return {
    seq: 5,
    time: 5,
    type: 'user/message',
    surfaceOp: { op: 'replace', startSeq: 1, endSeq: 3 },
    sourceEventSeqs: [1, 2, 3],
    data: {
      id: 'm3',
      role: 'user',
      source: { kind: 'compact-checkpoint', compactionId: 'comp-ok' },
      content: [{ type: 'text', text: summaryText() }],
    },
  };
}

function makeEntry({ guardMode = 'enforce', omitErrorAnchor = false, maxTotalChars = 12_000_000 } = {}) {
  const events = sourceEvents();
  const normalized = normalizeSourceEvents(events, { maxTotalChars });
  const entry = buildIndexEntry({
    sessionId: 'session-1',
    workspace: 'D:/work',
    event: compactionEvent({ omitErrorAnchor }),
    sourceRecords: normalized.records,
    validationFacts: normalized.validationFacts,
    sourceStats: normalized.stats,
    guardMode,
    maxAnchors: 100,
    maxSectionChars: 4000,
    now: 1,
  });
  return { entry, events, normalized };
}

test('parses the five-section skeleton in English and Chinese', () => {
  const english = parseSummarySections(summaryText());
  assert.deepEqual(english.missing, []);
  assert.equal(english.present.anchors, true);
  assert.match(english.sections.nextSteps, /endpoint/);

  const chinese = parseSummarySections([
    '## 目标与意图',
    '完成插件。',
    '## 关键决策',
    '不接管压缩后端。',
    '## 当前状态',
    '正在测试。',
    '## 下一步',
    '运行探针。',
    '## 精确锚点',
    '- ENOENT -> 事件 3',
  ].join('\n'));
  assert.deepEqual(chinese.missing, []);
  assert.match(chinese.sections.anchors, /ENOENT/);

  const numbered = parseSummarySections([
    '## 1. Goal and intent',
    'Ship it.',
    '### 2) **Decisions**',
    'Keep the guard.',
  ].join('\n'));
  assert.equal(numbered.present.goal, true);
  assert.equal(numbered.present.decisions, true);
  assert.equal(numbered.present.currentState, false);
});

test('redacts obvious credentials from stored/injected text', () => {
  const text = 'Authorization: Bearer sk-abcdefghijklmnop password=hunter2hunter2';
  const redacted = redactSecrets(text);
  assert.doesNotMatch(redacted, /sk-abcdefghijklmnop/);
  assert.doesNotMatch(redacted, /hunter2hunter2/);
  assert.match(redacted, /REDACTED/);
});

test('extracts deterministic P0 anchors with source pointers and validation facts', () => {
  const { normalized } = makeEntry();
  const extracted = extractAnchors(normalized.records);
  const values = new Set(extracted.anchors.map((anchor) => anchor.value));
  assert.equal(values.has(UUID), true);
  assert.equal(values.has(HOST), true);
  assert.equal(values.has('ENOENT'), true);
  assert.equal(values.has('src/index.mjs'), true);
  const uuid = extracted.anchors.find((anchor) => anchor.value === UUID);
  assert.equal(uuid.sourceSeq, 1);
  assert.equal(normalized.validationFacts.length, 1);
  assert.equal(normalized.validationFacts[0].outcome, 'failed');
  assert.equal(normalized.validationFacts[0].errorCode, 'ENOENT');
});

test('extracts letter-only snake-case error/config identifiers and rejects routine multi-word code spans', () => {
  const normalized = normalizeSourceEvents([
    {
      seq: 1,
      time: 1,
      type: 'user/message',
      data: {
        id: 'm1',
        role: 'user',
        source: { kind: 'user' },
        content: [{
          type: 'text',
          text: 'Failure TOOL_NOT_STARTED; env ANTHROPIC_API_KEY; setting: max_tokens; routine `npm test` is not a P0 literal.',
        }],
      },
      surfaceOp: 'append',
    },
  ]);
  const values = new Set(extractAnchors(normalized.records).anchors.map((anchor) => anchor.value));
  assert.equal(values.has('TOOL_NOT_STARTED'), true);
  assert.equal(values.has('ANTHROPIC_API_KEY'), true);
  assert.equal(values.has('max_tokens'), true);
  assert.equal(values.has('npm test'), false);
});

test('expands escaped JSON tool arguments so Windows paths use the semantic single-backslash form', () => {
  const assistant = {
    seq: 20,
    time: 20,
    type: 'assistant/message',
    surfaceOp: 'append',
    data: {
      turn: 1,
      step: 1,
      message: {
        id: 'assistant-escaped',
        role: 'assistant',
        source: { kind: 'model', provider: 'test', model: 'test' },
        content: [{
          type: 'tool-call',
          id: 'call-escaped',
          name: 'write_file',
          arguments: '{"path":"C:\\\\work\\\\file.mjs"}',
        }],
      },
      stream: [],
    },
  };
  const normalized = normalizeSourceEvents([assistant]);
  const values = extractAnchors(normalized.records).anchors.map((anchor) => anchor.value);
  assert.ok(values.includes('C:\\work\\file.mjs'));
});

test('correlates tool results with tool-call blocks embedded in assistant messages', () => {
  const assistant = {
    seq: 10,
    time: 10,
    type: 'assistant/message',
    surfaceOp: 'append',
    data: {
      turn: 1,
      step: 1,
      message: {
        id: 'assistant-1',
        role: 'assistant',
        source: { kind: 'model', provider: 'test', model: 'test' },
        content: [{ type: 'tool-call', id: 'call-assistant', name: 'write_file', arguments: '{"path":"src/new.mjs"}' }],
      },
      stream: [],
    },
  };
  const result = {
    seq: 11,
    time: 11,
    type: 'tool/result',
    surfaceOp: 'append',
    data: {
      turn: 1,
      step: 1,
      message: {
        id: 'result-1',
        role: 'user',
        source: { kind: 'tool', callId: 'call-assistant' },
        content: [{ type: 'tool-result', toolCallId: 'call-assistant', content: [{ type: 'text', text: 'wrote src/new.mjs' }] }],
      },
    },
  };
  const normalized = normalizeSourceEvents([assistant, result]);
  assert.equal(normalized.validationFacts[0].toolName, 'write_file');
  const values = new Set(extractAnchors(normalized.records).anchors.map((anchor) => anchor.value));
  assert.equal(values.has('src/new.mjs'), true);
});

test('admits a complete summary whose Anchors section covers every extracted P0 literal', () => {
  const { entry } = makeEntry();
  assert.equal(entry.admission.status, 'admitted');
  assert.deepEqual(entry.admission.reasonCodes, []);
  assert.equal(entry.summary.complete, true);
  assert.ok(entry.anchors.every((anchor) => anchor.sourceSeq >= 1));
});

test('quarantines a summary that mentions a P0 literal but omits it from Anchors', () => {
  const { entry } = makeEntry({ omitErrorAnchor: true });
  assert.equal(entry.admission.status, 'quarantined');
  assert.ok(entry.admission.reasonCodes.includes('anchor-not-in-anchors-section'));
  assert.ok(entry.admission.missingAnchors.some((missing) => missing.value === 'ENOENT'));
  assert.equal(searchEntries([entry], 'ENOENT').length, 0);
  assert.equal(searchEntries([entry], 'ENOENT', { status: 'all' }).length, 1);
});

test('compat mode admits an anchor found elsewhere but records a warning', () => {
  const { entry } = makeEntry({ guardMode: 'compat', omitErrorAnchor: true });
  assert.equal(entry.admission.status, 'admitted');
  assert.ok(entry.admission.warnings.includes('anchor-not-in-anchors-section'));
  assert.equal(entry.admission.mode, 'compat');
});

test('quarantines a source scan truncated before all P0 literals could be checked', () => {
  const { entry } = makeEntry({ maxTotalChars: 1 });
  assert.equal(entry.admission.status, 'quarantined');
  assert.ok(entry.admission.reasonCodes.includes('source-scan-truncated'));
});

test('deterministic probes verify pointer, search, read, source-range and replacement reachability', () => {
  const { entry, events } = makeEntry();
  const bySeq = new Map([...events, replacementEvent()].map((event) => [event.seq, event]));
  const probes = runEntryProbes(entry, (seq) => bySeq.get(seq), { limit: 50 });
  assert.equal(probes.failed, 0);
  assert.equal(probes.pending, 0);
  assert.equal(probes.criticalFailed, 0);
  assert.ok(probes.items.some((item) => item.type === 'replacement-pointer' && item.status === 'passed'));
  const gated = applyProbeAdmission({ ...entry, probes }, probes);
  assert.equal(gated.admission.status, 'admitted');
});

test('probe admission quarantines an entry on a critical failure', () => {
  const { entry } = makeEntry();
  const probes = {
    total: 1,
    passed: 0,
    failed: 1,
    pending: 0,
    criticalFailed: 1,
    sampledAnchors: 1,
    anchorCount: 1,
    items: [],
  };
  const gated = applyProbeAdmission({ ...entry, probes }, probes);
  assert.equal(gated.admission.status, 'quarantined');
  assert.ok(gated.admission.reasonCodes.includes('probe-failed'));
});

test('quarantine injection card carries deterministic salvage anchors and fallback instructions', () => {
  const { entry } = makeEntry({ omitErrorAnchor: true });
  const card = buildInjectionCard(entry);
  assert.match(card, /QUARANTINED/);
  assert.match(card, /ENOENT/);
  assert.match(card, /sumidx_read action=event/);
  assert.match(card, /already committed/);
});

test('generates a repeatable model-level recall probe pack', () => {
  const { entry } = makeEntry();
  const questions = createProbeQuestions(entry, { limit: 3 });
  assert.match(questions, /Expected literal:/);
  assert.match(questions, /sumidx_read action=event/);
  assert.ok(questions.includes(UUID) || questions.includes('ENOENT') || questions.includes(HOST));
});

test('source-event search is literal and returns seq-bound snippets', async () => {
  const { entry, events } = makeEntry();
  const { searchSourceRecords } = await import('../src/core.mjs');
  const normalized = normalizeSourceEvents(events);
  const result = searchSourceRecords(normalized.records, 'ENOENT');
  assert.equal(result.total >= 1, true);
  assert.ok(result.matches.every((match) => Number.isSafeInteger(match.seq)));
  assert.match(result.matches[0].snippet, /ENOENT/);
  assert.equal(entry.id.startsWith('sumidx:'), true);
});
