import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SummaryIndexStore } from '../src/store.mjs';

const TEST_TMP = join(dirname(fileURLToPath(import.meta.url)), '..', '.test-tmp');

async function tempRoot() {
  await mkdir(TEST_TMP, { recursive: true });
  const root = join(TEST_TMP, randomUUID());
  await mkdir(root, { recursive: true });
  return root;
}

function entry(index) {
  return {
    schema: 'sumidx.entry/v1',
    id: 'sumidx:test-' + index,
    plugin: { name: 'dsh-summary-index', version: '0.1.0' },
    sessionId: 'session-store-test',
    summarySeq: index,
    summary: { sections: {} },
    anchors: [],
    admission: { status: 'admitted', reasonCodes: [] },
  };
}

test('append/load keeps valid JSONL entries in order', async () => {
  const root = await tempRoot();
  try {
    const store = new SummaryIndexStore({ root });
    await store.append('session-store-test', entry(1));
    await store.append('session-store-test', entry(2));
    const loaded = await store.load('session-store-test');
    assert.equal(loaded.truncated, false);
    assert.equal(loaded.invalidLines, 0);
    assert.deepEqual(loaded.entries.map((item) => item.id), ['sumidx:test-1', 'sumidx:test-2']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('concurrent appends are serialized into complete JSONL records', async () => {
  const root = await tempRoot();
  try {
    const store = new SummaryIndexStore({ root });
    await Promise.all(Array.from({ length: 24 }, (_, index) => store.append('session-concurrent', entry(index + 1))));
    const loaded = await store.load('session-concurrent');
    assert.equal(loaded.entries.length, 24);
    assert.equal(loaded.invalidLines, 0);
    assert.equal(new Set(loaded.entries.map((item) => item.id)).size, 24);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('malformed lines are counted but do not discard valid entries', async () => {
  const root = await tempRoot();
  try {
    const store = new SummaryIndexStore({ root });
    await store.append('session-damaged', entry(1));
    await appendFile(store.entryPath('session-damaged'), '{not json}\n', 'utf8');
    await store.append('session-damaged', entry(2));
    const loaded = await store.load('session-damaged');
    assert.equal(loaded.entries.length, 2);
    assert.equal(loaded.invalidLines, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a bounded read keeps the newest complete JSONL window', async () => {
  const root = await tempRoot();
  try {
    const store = new SummaryIndexStore({ root, maxReadBytes: 500 });
    for (let index = 1; index <= 8; index++) await store.append('session-tail', entry(index));
    const loaded = await store.load('session-tail');
    assert.equal(loaded.truncated, true);
    assert.ok(loaded.entries.length > 0);
    assert.ok(loaded.entries.length < 8);
    assert.equal(loaded.entries.at(-1).id, 'sumidx:test-8');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('session ids are path-hashed rather than used as path segments', async () => {
  const root = await tempRoot();
  try {
    const store = new SummaryIndexStore({ root });
    const dir = store.sessionDirectory('../../escape/session');
    const rel = relative(root, dir);
    assert.equal(rel.startsWith('..'), false);
    assert.equal(rel.includes('..'), false);
    await store.append('../../escape/session', entry(1));
    const raw = await readFile(store.entryPath('../../escape/session'), 'utf8');
    assert.match(raw, /sumidx:test-1/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

