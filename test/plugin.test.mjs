import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as plugin from '../src/index.mjs';
import { Config, producerSourceForVersion } from '../src/index.mjs';

const UUID = '550e8400-e29b-41d4-a716-446655440000';
const TEST_TMP = join(dirname(fileURLToPath(import.meta.url)), '..', '.test-tmp');

function summaryText({ omitErrorAnchor = false } = {}) {
  return [
    '## Goal and intent',
    'Keep exact task facts across compaction.',
    '',
    '## Decisions',
    `Retain UUID ${UUID} and src/index.mjs.`,
    '',
    '## Current state',
    'read_file failed with ENOENT.',
    '',
    '## Next steps',
    'Inspect the exact source event.',
    '',
    '## Anchors',
    `- UUID ${UUID} -> seq 1`,
    '- path src/index.mjs -> seq 2',
    ...(omitErrorAnchor ? [] : ['- error ENOENT -> seq 3']),
  ].join('\n');
}

function makeEvents({ omitErrorAnchor = false } = {}) {
  return [
    {
      seq: 1,
      time: 1,
      type: 'user/message',
      surfaceOp: 'append',
      data: {
        id: 'm1',
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: `Remember UUID ${UUID} and path src/index.mjs.` }],
      },
    },
    {
      seq: 2,
      time: 2,
      type: 'assistant/message',
      surfaceOp: 'append',
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'm-assistant',
          role: 'assistant',
          source: { kind: 'model', provider: 'test-provider', model: 'test-model' },
          content: [
            { type: 'text', text: 'Reading the file.' },
            { type: 'tool-call', id: 'call-1', name: 'read_file', arguments: '{"path":"src/index.mjs"}' },
          ],
        },
        stream: [],
      },
    },
    {
      seq: 3,
      time: 3,
      type: 'tool/result',
      surfaceOp: 'append',
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
    },
    {
      seq: 4,
      time: 4,
      type: 'compaction/summary',
      data: {
        compactionId: 'plugin-test-' + (omitErrorAnchor ? 'missing' : 'ok'),
        summary: [{ type: 'text', text: summaryText({ omitErrorAnchor }) }],
        shadowedRange: { start: 1, end: 3 },
        shadowedSeqs: [1, 2, 3],
        shadowedTokenCount: 90,
        provider: 'test-provider',
        model: 'test-model',
      },
    },
    {
      seq: 5,
      time: 5,
      type: 'user/message',
      surfaceOp: { op: 'replace', startSeq: 1, endSeq: 3 },
      sourceEventSeqs: [1, 2, 3],
      data: {
        id: 'm3',
        role: 'user',
        source: { kind: 'compact-checkpoint' },
        content: [{ type: 'text', text: summaryText({ omitErrorAnchor }) }],
      },
    },
  ];
}

class FakeSession {
  constructor(events) {
    this.header = { id: 'session-plugin-test-' + randomUUID(), cwd: 'D:/work' };
    this.id = this.header.id;
    this.events = new Map(events.map((event) => [event.seq, event]));
    this.derived = [];
    this.appendCalls = 0;
  }

  get seq() {
    return Math.max(0, ...this.events.keys()) + 1;
  }

  eventAt(seq) {
    return this.events.get(seq);
  }

  snapshotEvents() {
    return [...this.events.values()].sort((left, right) => left.seq - right.seq);
  }

  deriveMessages() {
    return this.derived;
  }

  append() {
    this.appendCalls++;
    throw new Error('plugin must not append session events directly');
  }
}

function harness(session, config) {
  const handlers = new Map();
  const tools = new Map();
  const warnings = [];
  const ctx = {
    tools: {
      register(tool) {
        if (tools.has(tool.name)) throw new Error('duplicate tool ' + tool.name);
        tools.set(tool.name, tool);
        return () => tools.delete(tool.name);
      },
    },
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
    get() {
      return undefined;
    },
    logger: {
      warn: (...args) => warnings.push(args.map(String).join(' ')),
      debug: () => {},
    },
  };
  plugin.apply(ctx, config);
  return { ctx, handlers, tools, warnings };
}

async function emit(harnessValue, session, event) {
  const listeners = harnessValue.handlers.get('session/event') ?? [];
  for (const listener of listeners) listener(session, event);
}

async function preStep(harnessValue, session) {
  const listeners = harnessValue.handlers.get('agent/pre-step') ?? [];
  assert.equal(listeners.length, 1);
  const controller = new AbortController();
  return listeners[0]({
    agent: { session },
    messages: [],
    turn: 1,
    step: 1,
    signal: controller.signal,
  }, async () => ({ kind: 'enter', messages: [] }));
}

test('exports a loader-visible Config with runtime-compatible defaults and validation', () => {
  const config = Config({});
  assert.equal(config.enabled, true);
  assert.equal(config.guardMode, 'enforce');
  assert.equal(config.inject, true);
  assert.equal(config.summarizeMinChars, 512);
  assert.equal(config.maxTrackedSessions, 256);
  assert.throws(() => Config({ guardMode: 'not-a-mode' }));
  assert.throws(() => Config({ injectMaxChars: -1 }));
});

test('chooses a valid producer source for session format v3 and v4', () => {
  assert.deepEqual(producerSourceForVersion(3), { kind: 'plugin', plugin: 'dsh-summary-index' });
  assert.deepEqual(producerSourceForVersion(4), { kind: 'plugin:dsh-summary-index' });
});

test('registers only name-spaced sumidx tools and observes compaction without a compaction service', async () => {
  const root = join(TEST_TMP, randomUUID());
  await mkdir(root, { recursive: true });
  try {
    const session = new FakeSession(makeEvents());
    const h = harness(session, { indexRoot: root, summarizeMinChars: 0, summarizeMinNodes: 0 });
    assert.deepEqual([...h.tools.keys()].sort(), ['sumidx_probe', 'sumidx_read', 'sumidx_search']);
    assert.ok(h.tools.size === 3);
    assert.equal(h.handlers.has('session/event'), true);
    assert.equal(h.handlers.has('agent/pre-step'), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('indexes a committed summary, injects one index card, and exposes read/search/probe tools', async () => {
  const root = join(TEST_TMP, randomUUID());
  await mkdir(root, { recursive: true });
  try {
    const session = new FakeSession(makeEvents());
    const h = harness(session, {
      indexRoot: root,
      summarizeMinChars: 0,
      summarizeMinNodes: 0,
      injectMaxChars: 3000,
      injectMaxAnchors: 20,
    });
    await emit(h, session, session.eventAt(4));
    const first = await preStep(h, session);
    assert.equal(first.kind, 'enter');
    assert.equal(first.messages.length, 1);
    const card = first.messages[0].content[0].text;
    assert.match(card, /\[sumidx\] Structured compaction index admitted/);
    assert.match(card, /ENOENT/);
    assert.match(card, /sumidx_read/);
    assert.ok(first.messages[0].source.kind === 'plugin' || first.messages[0].source.kind.startsWith('plugin:'));
    assert.equal(session.appendCalls, 0);

    const second = await preStep(h, session);
    assert.equal(second.messages.length, 0, 'the index card is injected only once');

    const search = await h.tools.get('sumidx_search').execute(
      { query: 'ENOENT', status: 'all', limit: 10 },
      { agent: { session } },
    );
    assert.match(search.text, /sumidx:plugin-test-ok/);
    const entryId = search.text.match(/\[(sumidx:[^\]\s]+)\]/)?.[1];
    assert.ok(entryId);

    const readEntry = await h.tools.get('sumidx_read').execute(
      { action: 'entry', entry_id: entryId, offset: 0, limit: 4000 },
      { agent: { session } },
    );
    assert.match(readEntry.text, /Deterministic P0 anchors/);

    const sourceSearch = await h.tools.get('sumidx_read').execute(
      { action: 'search', entry_id: entryId, query: 'ENOENT', offset: 0, limit: 10 },
      { agent: { session } },
    );
    assert.match(sourceSearch.text, /source-event search/);

    const readEvent = await h.tools.get('sumidx_read').execute(
      { action: 'event', entry_id: entryId, seq: 1, offset: 0, limit: 4000 },
      { agent: { session } },
    );
    assert.match(readEvent.text, new RegExp(UUID.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(readEvent.text, /type: user\/message/);

    const questions = await h.tools.get('sumidx_probe').execute(
      { action: 'questions', entry_id: entryId, limit: 4 },
      { agent: { session } },
    );
    assert.match(questions.text, /recall probe pack/);

    const probe = await h.tools.get('sumidx_probe').execute(
      { action: 'run', entry_id: entryId, limit: 20 },
      { agent: { session } },
    );
    assert.match(probe.text, /summary-index probes:/);
    assert.match(probe.text, /critical_failed=0/);

    const status = await h.tools.get('sumidx_probe').execute({ action: 'status' }, { agent: { session } });
    assert.match(status.text, /entries=1/);
    assert.match(status.text, /admitted=1/);

    const dir = join(root, 'sessions');
    const { readdir } = await import('node:fs/promises');
    const dirs = await readdir(dir);
    assert.equal(dirs.length, 1);
    const raw = await readFile(join(dir, dirs[0], 'entries.jsonl'), 'utf8');
    assert.match(raw, /"schema":"sumidx.entry\/v1"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a missing P0 anchor quarantines the index but injects a salvage warning card', async () => {
  const root = join(TEST_TMP, randomUUID());
  await mkdir(root, { recursive: true });
  try {
    const session = new FakeSession(makeEvents({ omitErrorAnchor: true }));
    const h = harness(session, {
      indexRoot: root,
      summarizeMinChars: 0,
      summarizeMinNodes: 0,
      injectMaxChars: 3000,
    });
    await emit(h, session, session.eventAt(4));
    const decision = await preStep(h, session);
    const card = decision.messages[0].content[0].text;
    assert.match(card, /QUARANTINED/);
    assert.match(card, /ENOENT/);
    assert.match(card, /already committed/);

    const admittedSearch = await h.tools.get('sumidx_search').execute(
      { query: 'ENOENT', status: 'admitted', limit: 10 },
      { agent: { session } },
    );
    assert.match(admittedSearch.text, /No matching/);
    const allSearch = await h.tools.get('sumidx_search').execute(
      { query: 'ENOENT', status: 'all', limit: 10 },
      { agent: { session } },
    );
    assert.match(allSearch.text, /quarantined/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('inject=false keeps a tools-only mode without adding a pre-step message', async () => {
  const root = join(TEST_TMP, randomUUID());
  await mkdir(root, { recursive: true });
  try {
    const session = new FakeSession(makeEvents());
    const h = harness(session, {
      indexRoot: root,
      summarizeMinChars: 0,
      summarizeMinNodes: 0,
      inject: false,
    });
    await emit(h, session, session.eventAt(4));
    const decision = await preStep(h, session);
    assert.equal(decision.messages.length, 0);
    const search = await h.tools.get('sumidx_search').execute(
      { query: 'ENOENT', status: 'all', limit: 10 },
      { agent: { session } },
    );
    assert.match(search.text, /plugin-test-ok/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('malformed compaction payload is quarantined without crashing the host flow', async () => {
  const root = join(TEST_TMP, randomUUID());
  await mkdir(root, { recursive: true });
  try {
    const summaryEvent = {
      seq: 2,
      time: 2,
      type: 'compaction/summary',
      data: {
        compactionId: 'malformed-1',
        summary: [{ type: 'text', text: summaryText() }],
        shadowedRange: {},
        // Deliberately missing shadowedSeqs: no pointer may be invented.
        provider: 'test-provider',
        model: 'test-model',
      },
    };
    const session = new FakeSession([
      {
        seq: 1,
        time: 1,
        type: 'user/message',
        surfaceOp: 'append',
        data: {
          id: 'm1',
          role: 'user',
          source: { kind: 'user' },
          content: [{ type: 'text', text: `UUID ${UUID} path src/index.mjs ENOENT` }],
        },
      },
      summaryEvent,
    ]);
    const h = harness(session, {
      indexRoot: root,
      summarizeMinChars: 0,
      summarizeMinNodes: 0,
      injectMaxChars: 3000,
    });
    await emit(h, session, summaryEvent);
    const decision = await preStep(h, session);
    assert.equal(decision.kind, 'enter');
    assert.match(decision.messages[0].content[0].text, /QUARANTINED/);
    assert.match(decision.messages[0].content[0].text, /shadowed-seqs-missing/);
    assert.ok(h.warnings.every((warning) => !warning.includes('TypeError')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a broken index root does not disable in-memory retrieval after compaction', async () => {
  const root = join(TEST_TMP, randomUUID());
  await writeFile(root, 'this-is-a-file-not-a-directory', 'utf8');
  try {
    const session = new FakeSession(makeEvents());
    const h = harness(session, {
      indexRoot: root,
      summarizeMinChars: 0,
      summarizeMinNodes: 0,
      injectMaxChars: 3000,
    });
    await emit(h, session, session.eventAt(4));
    const decision = await preStep(h, session);
    assert.match(decision.messages[0].content[0].text, /Structured compaction index admitted/);
    assert.ok(h.warnings.some((warning) => /load index store|persist index entry/.test(warning)));

    const search = await h.tools.get('sumidx_search').execute(
      { query: 'ENOENT', status: 'all', limit: 10 },
      { agent: { session } },
    );
    assert.match(search.text, /plugin-test-ok/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('maxTrackedSessions eviction does not break retrieval for an older live session', async () => {
  const root = join(TEST_TMP, randomUUID());
  await mkdir(root, { recursive: true });
  try {
    const sessions = [];
    const hSessions = [];
    for (let index = 0; index < 4; index++) {
      const session = new FakeSession(makeEvents());
      session.header.id = 'bounded-session-' + index + '-' + randomUUID();
      session.id = session.header.id;
      const h = harness(session, {
        indexRoot: root,
        summarizeMinChars: 0,
        summarizeMinNodes: 0,
        maxTrackedSessions: 2,
        inject: true,
      });
      await emit(h, session, session.eventAt(4));
      await preStep(h, session);
      sessions.push(session);
      hSessions.push(h);
    }
    const search = await hSessions[0].tools.get('sumidx_search').execute(
      { query: 'ENOENT', status: 'all', limit: 10 },
      { agent: { session: sessions[0] } },
    );
    // The first session was evicted from the live map; this call must reload it
    // from the append-only store instead of returning an empty index.
    assert.match(search.text, /plugin-test-ok/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
