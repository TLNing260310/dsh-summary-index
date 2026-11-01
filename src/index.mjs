import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session';
import {
  applyProbeAdmission,
  buildIndexEntry,
  buildInjectionCard,
  createProbeQuestions,
  latestEntries,
  normalizeSourceEvents,
  renderEntryText,
  renderProbeText,
  renderRawEvent,
  renderSearchResults,
  runEntryProbes,
  searchEntries,
  searchSourceRecords,
} from './core.mjs';
import { SummaryIndexStore } from './store.mjs';
import { PLUGIN_VERSION } from './version.mjs';

export { PLUGIN_VERSION };
import { charPage, contentBlocksToText, positiveInt } from './text.mjs';

export const name = 'dsh-summary-index';
export const inject = ['tools'];

/**
 * Loader-visible config schema. Defaults here mirror normalizeConfig so the
 * plugin manager and the runtime agree, and invalid enum/number values fail at
 * activation instead of being silently ignored.
 */
export const Config = z.object({
  enabled: z.boolean().default(true).description('Enable the compaction index.'),
  guardMode: z.union(['enforce', 'compat', 'observe']).default('enforce')
    .description('How strictly the five-section and Anchors guard is enforced.'),
  inject: z.boolean().default(true)
    .description('Inject one index or quarantine card after each new compaction. Set false for tools-only mode.'),
  injectMaxChars: z.natural().min(200).max(20_000).default(1800)
    .description('Maximum characters in the one-shot pre-step index card.'),
  injectMaxAnchors: z.natural().min(1).max(256).default(14)
    .description('Maximum anchors shown in the one-shot pre-step card.'),
  summarizeMinChars: z.natural().default(512)
    .description('Minimum source characters required to admit a compaction into the index.'),
  summarizeMinNodes: z.natural().default(2)
    .description('Minimum shadowed surface events required to admit a compaction into the index.'),
  maxAnchors: z.natural().min(1).max(4096).default(256)
    .description('Maximum required P0 anchors extracted from one source range.'),
  maxEventChars: z.natural().min(1024).default(500_000)
    .description('Per-event scan budget; sampled events quarantine the index.'),
  maxTotalSourceChars: z.natural().min(1024).default(12_000_000)
    .description('Total source scan budget; overflow quarantines the index.'),
  maxSectionChars: z.natural().min(200).max(200_000).default(4000)
    .description('Maximum stored preview characters per five-section section.'),
  probeLimit: z.natural().min(1).max(256).default(24)
    .description('Maximum anchors sampled by stored/diagnostic probes.'),
  backfillLimit: z.natural().min(0).max(100).default(8)
    .description('How many recent compaction summaries to backfill after activation.'),
  maxSearchResults: z.natural().min(1).max(50).default(12)
    .description('Maximum entries returned by sumidx_search.'),
  maxReadChars: z.natural().min(1).max(50_000).default(12_000)
    .description('Maximum character window returned by sumidx_read.'),
  maxStoreReadBytes: z.natural().min(1024).default(64 * 1024 * 1024)
    .description('Maximum index JSONL window read at session activation.'),
  maxEntryBytes: z.natural().min(1024).default(2 * 1024 * 1024)
    .description('Maximum serialized index entry size.'),
  maxTrackedSessions: z.natural().min(1).max(4096).default(256)
    .description('Maximum live session state maps retained in memory.'),
  indexRoot: z.string().description('Optional absolute or DSH_HOME-relative index storage root.'),
});

const STORE_NAMESPACE = 'dsh-summary-index';
const STORE_SCHEMA = 'v1';

const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      text: { type: 'string', required: true },
    },
  },
  render: (_args, value) => [{ type: 'text', text: value.text }],
};

function normalizeConfig(raw = {}) {
  const dshHome = resolveDshHome();
  const configuredRoot = typeof raw.indexRoot === 'string' && raw.indexRoot.trim().length > 0
    ? raw.indexRoot.trim()
    : null;
  const indexRoot = configuredRoot === null
    ? join(dshHome, STORE_NAMESPACE, STORE_SCHEMA)
    : isAbsolute(configuredRoot)
      ? resolve(configuredRoot)
      : resolve(dshHome, configuredRoot);
  const guardMode = raw.guardMode === 'compat' || raw.guardMode === 'observe'
    ? raw.guardMode
    : 'enforce';
  return {
    enabled: raw.enabled !== false,
    guardMode,
    inject: raw.inject !== false,
    injectMaxChars: Math.min(positiveInt(raw.injectMaxChars, 1800), 20_000),
    injectMaxAnchors: Math.min(positiveInt(raw.injectMaxAnchors, 14), 256),
    summarizeMinChars: nonNegativeInt(raw.summarizeMinChars, 512),
    summarizeMinNodes: nonNegativeInt(raw.summarizeMinNodes, 2),
    maxAnchors: Math.min(positiveInt(raw.maxAnchors, 256), 4096),
    maxEventChars: positiveInt(raw.maxEventChars, 500_000),
    maxTotalSourceChars: positiveInt(raw.maxTotalSourceChars, 12_000_000),
    maxSectionChars: Math.min(positiveInt(raw.maxSectionChars, 4000), 200_000),
    probeLimit: Math.min(positiveInt(raw.probeLimit, 24), 256),
    backfillLimit: Math.min(nonNegativeInt(raw.backfillLimit, 8), 100),
    maxSearchResults: Math.min(positiveInt(raw.maxSearchResults, 12), 50),
    maxReadChars: Math.min(positiveInt(raw.maxReadChars, 12_000), 50_000),
    maxStoreReadBytes: positiveInt(raw.maxStoreReadBytes, 64 * 1024 * 1024),
    maxEntryBytes: positiveInt(raw.maxEntryBytes, 2 * 1024 * 1024),
    maxTrackedSessions: Math.min(positiveInt(raw.maxTrackedSessions, 256), 4096),
    indexRoot,
  };
}

function nonNegativeInt(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function resolveDshHome() {
  for (const candidate of [process.env.DSH_HOME, process.env.DSH_DATA_HOME]) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return resolve(candidate.trim());
    }
  }
  return join(homedir(), '.dsh');
}

function sessionIdOf(session) {
  return String(session?.id ?? session?.header?.id ?? 'unknown-session');
}

function workspaceOf(session) {
  return typeof session?.header?.cwd === 'string' ? session.header.cwd : process.cwd();
}

function compactionIdOf(event) {
  const id = event?.data?.compactionId;
  return typeof id === 'string' && id.length > 0 ? id : 'summary-' + event?.seq;
}

function isCompactionSummary(event) {
  return event?.type === 'compaction/summary' && typeof event.seq === 'number';
}

/**
 * DSH session format v4 switched to producer-owned source kinds; v3 uses the
 * legacy `{ kind: 'plugin', plugin }` wrapper. Keep both supported so the same
 * package works across the DSH 0.1.5-0.2.x API surface.
 *
 * @param {unknown} version
 * @returns {{kind: string, plugin?: string}}
 */
export function producerSourceForVersion(version) {
  return Number(version) >= 4
    ? { kind: 'plugin:' + name }
    : { kind: 'plugin', plugin: name };
}

function producerSource() {
  return producerSourceForVersion(SESSION_FORMAT_VERSION);
}

/**
 * Register the non-conflicting host plugin.
 *
 * It deliberately does NOT implement `ctx.compaction` and never registers a
 * compaction service. It observes committed `compaction/summary` events, writes
 * an append-only side index, and exposes only `sumidx_*` read tools.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {any} config
 */
export function apply(ctx, config = {}) {
  const cfg = normalizeConfig(config);
  const store = new SummaryIndexStore({
    root: cfg.indexRoot,
    maxReadBytes: cfg.maxStoreReadBytes,
    maxEntryBytes: cfg.maxEntryBytes,
  });
  const entriesBySession = new Map();
  const loadPromises = new Map();
  const processing = new Map();
  const skippedCompactions = new Set();
  const pendingSessionWork = new Map();
  const injectedMarkers = new Map();
  const backfilledSessions = new Map();
  const backfillPromises = new Map();
  const lastScannedEventSeq = new Map();
  const latestSummaryCache = new Map();
  const sessionRecency = new Map();
  const MAX_INDEX_EVENT_KEYS = 20_000;
  let disposed = false;

  const logWarn = (message, error) => {
    const suffix = error instanceof Error ? `: ${error.message}` : error === undefined ? '' : `: ${String(error)}`;
    ctx.logger?.warn?.('dsh-summary-index ' + message + suffix);
  };
  const logDebug = (message) => ctx.logger?.debug?.('dsh-summary-index ' + message);

  const rememberBoundedKey = (set, key) => {
    set.add(key);
    if (set.size > MAX_INDEX_EVENT_KEYS) {
      const oldest = set.values().next().value;
      if (oldest !== undefined) set.delete(oldest);
    }
  };

  const touchSession = (sessionId) => {
    sessionRecency.delete(sessionId);
    sessionRecency.set(sessionId, true);
    if (sessionRecency.size <= cfg.maxTrackedSessions) return;
    const active = new Set([
      ...pendingSessionWork.keys(),
      ...backfillPromises.keys(),
      ...loadPromises.keys(),
    ]);
    const removable = [...sessionRecency.keys()]
      .filter((id) => id !== sessionId && !active.has(id))
      .slice(0, Math.max(0, sessionRecency.size - cfg.maxTrackedSessions));
    for (const id of removable) {
      sessionRecency.delete(id);
      entriesBySession.delete(id);
      latestSummaryCache.delete(id);
      injectedMarkers.delete(id);
      backfilledSessions.delete(id);
      lastScannedEventSeq.delete(id);
    }
  };

  const markPending = (sessionId, work) => {
    pendingSessionWork.set(sessionId, work);
    work.finally(() => {
      if (pendingSessionWork.get(sessionId) === work) pendingSessionWork.delete(sessionId);
    });
    return work;
  };

  async function ensureSessionLoaded(session) {
    const sessionId = sessionIdOf(session);
    if (entriesBySession.has(sessionId)) {
      touchSession(sessionId);
      return entriesBySession.get(sessionId);
    }
    if (loadPromises.has(sessionId)) return loadPromises.get(sessionId);
    const promise = (async () => {
      let loaded = { entries: [], truncated: false, invalidLines: 0 };
      try {
        loaded = await store.load(sessionId);
      } catch (error) {
        // Retrieve what can still be built in memory. The next compaction or a
        // later read may still succeed if the store was temporarily unavailable.
        logWarn('failed to load index store; continuing with an in-memory index', error);
      }
      const map = new Map();
      for (const entry of latestEntries(loaded.entries)) map.set(entry.id, entry);
      entriesBySession.set(sessionId, map);
      touchSession(sessionId);
      if (loaded.truncated) logWarn('index store exceeded maxStoreReadBytes; only the newest JSONL window was loaded');
      if (loaded.invalidLines > 0) logWarn('ignored ' + loaded.invalidLines + ' malformed index line(s)');
      return map;
    })();
    loadPromises.set(sessionId, promise);
    try {
      return await promise;
    } finally {
      loadPromises.delete(sessionId);
    }
  }

  function cacheEntry(sessionId, entry) {
    let map = entriesBySession.get(sessionId);
    if (map === undefined) {
      map = new Map();
      entriesBySession.set(sessionId, map);
    }
    map.set(entry.id, entry);
    touchSession(sessionId);
    return entry;
  }

  function currentEntries(sessionId) {
    return latestEntries([...(entriesBySession.get(sessionId)?.values() ?? [])]);
  }

  function latestSummarySeq(session) {
    const sessionId = sessionIdOf(session);
    const cached = latestSummaryCache.get(sessionId);
    if (cached?.session === session) return cached.seq;
    let seq = null;
    try {
      for (const event of session.snapshotEvents()) {
        if (event.type === 'compaction/summary') seq = event.seq;
      }
    } catch (error) {
      logWarn('could not scan session events for the latest compaction summary', error);
    }
    latestSummaryCache.set(sessionId, { session, seq });
    return seq;
  }

  async function indexSummaryEvent(session, event, options = {}) {
    if (!cfg.enabled || disposed || !isCompactionSummary(event)) return null;
    const sessionId = sessionIdOf(session);
    await ensureSessionLoaded(session);
    const compactionId = compactionIdOf(event);
    const entryId = 'sumidx:' + compactionId;
    const existing = entriesBySession.get(sessionId)?.get(entryId);
    if (existing !== undefined) return existing;
    if (skippedCompactions.has(sessionId + '|' + compactionId)) return null;
    const inFlight = processing.get(sessionId + '|' + compactionId);
    if (inFlight !== undefined) return inFlight;

    const work = (async () => {
      const data = event.data ?? {};
      const shadowedSeqs = Array.isArray(data.shadowedSeqs)
        ? data.shadowedSeqs.filter((seq) => Number.isSafeInteger(seq))
        : [];
      const sourceEvents = [];
      for (const seq of shadowedSeqs) {
        try {
          const source = session.eventAt(seq);
          if (source !== undefined) sourceEvents.push(source);
        } catch (error) {
          logWarn('source event seq=' + seq + ' could not be read; the entry will be quarantined', error);
        }
      }
      const normalized = normalizeSourceEvents(sourceEvents, {
        maxEventChars: cfg.maxEventChars,
        maxTotalChars: cfg.maxTotalSourceChars,
      });
      const totalSourceChars = normalized.stats.totalChars;

      if (!options.force && shadowedSeqs.length > 0
        && (shadowedSeqs.length < cfg.summarizeMinNodes || totalSourceChars < cfg.summarizeMinChars)) {
        rememberBoundedKey(skippedCompactions, sessionId + '|' + compactionId);
        logDebug('skipped small compaction summary seq=' + event.seq
          + ' nodes=' + shadowedSeqs.length + ' chars=' + totalSourceChars);
        return null;
      }

      let entry = buildIndexEntry({
        sessionId,
        workspace: workspaceOf(session),
        event,
        sourceRecords: normalized.records,
        validationFacts: normalized.validationFacts,
        sourceStats: normalized.stats,
        guardMode: cfg.guardMode,
        maxAnchors: cfg.maxAnchors,
        maxSectionChars: cfg.maxSectionChars,
        now: Date.now(),
      });
      const probes = runEntryProbes(entry, (seq) => session.eventAt(seq), {
        limit: cfg.probeLimit,
        maxEventChars: cfg.maxEventChars,
      });
      entry = applyProbeAdmission({ ...entry, probes }, probes);
      cacheEntry(sessionId, entry);
      try {
        await store.append(sessionId, entry);
      } catch (error) {
        logWarn('failed to persist index entry ' + entry.id + '; in-memory retrieval remains available', error);
      }
      return entry;
    })();

    processing.set(sessionId + '|' + compactionId, work);
    try {
      return await work;
    } catch (error) {
      logWarn('failed to index compaction summary seq=' + event.seq, error);
      return null;
    } finally {
      processing.delete(sessionId + '|' + compactionId);
    }
  }

  async function backfillSession(session) {
    const sessionId = sessionIdOf(session);
    if (!cfg.enabled || disposed || backfilledSessions.get(sessionId) === session) return;
    const existing = backfillPromises.get(sessionId);
    if (existing !== undefined) return existing;
    const work = (async () => {
      await ensureSessionLoaded(session);
      const scanTo = session.seq;
      const summaries = session.snapshotEvents(0, scanTo).filter((event) => event.type === 'compaction/summary');
      for (const event of summaries.slice(-cfg.backfillLimit)) {
        await indexSummaryEvent(session, event);
      }
      if (summaries.length > 0) {
        latestSummaryCache.set(sessionId, { session, seq: summaries.at(-1).seq });
      }
      lastScannedEventSeq.set(sessionId, { session, seq: scanTo });
      backfilledSessions.set(sessionId, session);
    })();
    backfillPromises.set(sessionId, work);
    try {
      return await work;
    } finally {
      backfillPromises.delete(sessionId);
    }
  }

  async function scanNewSummaries(session) {
    const sessionId = sessionIdOf(session);
    const previous = lastScannedEventSeq.get(sessionId);
    const from = previous?.session === session ? previous.seq : 0;
    const to = session.seq;
    if (to <= from) return;
    const events = session.snapshotEvents(from, to);
    for (const event of events) {
      if (!isCompactionSummary(event)) continue;
      latestSummaryCache.set(sessionId, { session, seq: event.seq });
      await indexSummaryEvent(session, event);
    }
    lastScannedEventSeq.set(sessionId, { session, seq: to });
  }

  async function prepareSession(session) {
    try {
      await ensureSessionLoaded(session);
      await backfillSession(session);
      // Redundant incremental scan: session/event is the primary path, but a
      // missed fire-and-forget notification must not silently drop an index.
      await scanNewSummaries(session);
    } catch (error) {
      logWarn('session preparation failed; continuing with the current in-memory index', error);
    }
    const pending = pendingSessionWork.get(sessionIdOf(session));
    if (pending !== undefined) {
      try {
        await pending;
      } catch (error) {
        logWarn('pending summarization work failed', error);
      }
    }
  }

  async function refreshProbes(session, entry, persist = false) {
    const probes = runEntryProbes(entry, (seq) => session.eventAt(seq), {
      limit: cfg.probeLimit,
      maxEventChars: cfg.maxEventChars,
    });
    const next = applyProbeAdmission({ ...entry, probes }, probes);
    if (persist && (next.admission?.status !== entry.admission?.status
      || probes.failed !== entry.probes?.failed
      || probes.passed !== entry.probes?.passed)) {
      cacheEntry(sessionIdOf(session), next);
      try {
        await store.append(sessionIdOf(session), next);
      } catch (error) {
        logWarn('failed to persist refreshed probe state for ' + next.id, error);
      }
    }
    return next;
  }

  ctx.on('session/event', (session, event) => {
    if (!cfg.enabled || disposed || !isCompactionSummary(event)) return;
    const sessionId = sessionIdOf(session);
    touchSession(sessionId);
    latestSummaryCache.set(sessionId, { session, seq: event.seq });
    void markPending(sessionId, indexSummaryEvent(session, event).catch((error) => {
      logWarn('session event indexing failed', error);
      return null;
    }));
  });

  function alreadyHasCard(session, entry) {
    try {
      for (const message of session.deriveMessages()) {
        const text = contentBlocksToText(message?.content);
        if (text.includes('[sumidx]') && text.includes('entry: ' + entry.id)) return true;
      }
    } catch (error) {
      logWarn('could not inspect derived messages for an existing index card', error);
    }
    return false;
  }

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    if (disposed || !cfg.enabled || !cfg.inject || decision?.kind !== 'enter') return decision;
    const signal = payload?.signal;
    if (signal?.aborted) return decision;
    const session = payload?.agent?.session;
    if (!session) return decision;

    try {
      await prepareSession(session);
      if (signal?.aborted) return decision;
      const sessionId = sessionIdOf(session);
      const latestSeq = latestSummarySeq(session);
      if (latestSeq === null) return decision;
      const entry = currentEntries(sessionId).find((candidate) => candidate.summarySeq === latestSeq);
      if (entry === undefined) return decision;

      const marker = entry.id + '@' + entry.summarySeq + ':' + (entry.admission?.status ?? 'unknown');
      const priorInjection = injectedMarkers.get(sessionId);
      if (priorInjection?.session === session && priorInjection.marker === marker) return decision;
      if (alreadyHasCard(session, entry)) {
        injectedMarkers.set(sessionId, { session, marker });
        return decision;
      }

      const refreshed = await refreshProbes(session, entry, true);
      if (signal?.aborted) return decision;
      if (refreshed.summarySeq !== latestSummarySeq(session)) return decision;
      const finalMarker = refreshed.id + '@' + refreshed.summarySeq + ':' + (refreshed.admission?.status ?? 'unknown');
      const finalInjection = injectedMarkers.get(sessionId);
      if (finalInjection?.session === session && finalInjection.marker === finalMarker) return decision;
      if (alreadyHasCard(session, refreshed)) {
        injectedMarkers.set(sessionId, { session, marker: finalMarker });
        return decision;
      }
      const text = buildInjectionCard(refreshed, {
        maxChars: cfg.injectMaxChars,
        maxAnchors: cfg.injectMaxAnchors,
      });
      if (text.trim().length === 0) return decision;
      const message = createUserMessage({
        content: [{ type: 'text', text }],
        source: producerSource(),
      });
      injectedMarkers.set(sessionId, { session, marker: finalMarker });
      return {
        ...decision,
        messages: [...(decision.messages ?? []), message],
      };
    } catch (error) {
      logWarn('pre-step index card injection failed; the step is preserved', error);
      return decision;
    }
  });

  async function resolveToolSession(exec) {
    const session = exec?.agent?.session;
    if (!session || typeof session.eventAt !== 'function') {
      return { error: 'sumidx tools require a live agent session. No session is attached to this tool call.' };
    }
    await prepareSession(session);
    const pending = pendingSessionWork.get(sessionIdOf(session));
    if (pending !== undefined) await pending;
    return { session, sessionId: sessionIdOf(session), entries: currentEntries(sessionIdOf(session)) };
  }

  function resolveEntry(entries, entryId) {
    if (typeof entryId === 'string' && entryId.length > 0) {
      return entries.find((entry) => entry.id === entryId) ?? null;
    }
    return entries[0] ?? null;
  }

  function statusText(session, entries) {
    const latestSeq = latestSummarySeq(session);
    const admitted = entries.filter((entry) => entry.admission?.status === 'admitted').length;
    const quarantined = entries.filter((entry) => entry.admission?.status === 'quarantined').length;
    const lines = [
      'summary-index status: entries=' + entries.length + ' admitted=' + admitted + ' quarantined=' + quarantined
        + ' latest_compaction_seq=' + (latestSeq ?? 'none'),
      'store: ' + store.sessionDirectory(sessionIdOf(session)),
    ];
    if (entries.length === 0) {
      lines.push('No compaction index has been built in this session yet.');
      return lines.join('\n');
    }
    for (const entry of entries.slice(0, 50)) {
      const probes = entry.probes;
      lines.push('- ' + entry.id
        + ' summary_seq=' + (entry.summarySeq ?? '?')
        + ' status=' + (entry.admission?.status ?? 'unknown')
        + ' anchors=' + (entry.anchors?.length ?? 0)
        + ' probes=' + (probes ? probes.passed + '/' + probes.total : 'n/a')
        + (entry.admission?.reasonCodes?.length ? ' reasons=' + entry.admission.reasonCodes.join(',') : '')
        + (entry.summarySeq === latestSeq ? ' latest' : ''));
    }
    if (entries.length > 50) lines.push('- … ' + (entries.length - 50) + ' older entries omitted; narrow with sumidx_search.');
    return lines.join('\n');
  }

  const searchTool = defineTool({
    name: 'sumidx_search',
    description: 'Search the current session\'s structured compaction index. Default results include only admitted entries; use status=all to inspect quarantined entries. Anchors carry exact source-event seq pointers. This does not search raw history; use sumidx_read action=search for that.',
    parameters: {
      query: {
        type: 'string',
        description: 'Literal or keyword query. Omit to list the newest indexed compactions.',
      },
      status: {
        type: 'string',
        enum: ['admitted', 'quarantined', 'all'],
        description: 'Admission filter. Default admitted.',
      },
      limit: {
        type: 'integer',
        description: 'Maximum entries to return (default 8, subject to the deployment cap).',
      },
    },
    output: OUTPUT,
    async execute(args, exec) {
      const resolved = await resolveToolSession(exec);
      if (resolved.error) return { text: resolved.error };
      const query = typeof args?.query === 'string' ? args.query : '';
      const status = args?.status === 'quarantined' || args?.status === 'all' ? args.status : 'admitted';
      const limit = Math.min(positiveInt(args?.limit, Math.min(8, cfg.maxSearchResults)), cfg.maxSearchResults);
      const results = searchEntries(resolved.entries, query, { status, limit });
      return {
        text: renderSearchResults(results, query, { maxAnchorsPerHit: 4 })
          + '\n\nUse status=all to include quarantined entries. Use sumidx_read to open one entry or its source events.',
      };
    },
  });

  const readTool = defineTool({
    name: 'sumidx_read',
    description: 'Read a structured sumidx entry, search one entry\'s original source events, or read one exact original event by seq. This is read-only: it never re-executes the original tool. Event seqs are the DSH session log positions retained in the index.',
    parameters: {
      action: {
        type: 'string',
        enum: ['entry', 'event', 'search'],
        description: 'entry (default): structured stub; event: one exact original session event; search: search original source events referenced by the entry.',
      },
      entry_id: {
        type: 'string',
        description: 'Exact sumidx entry id. Defaults to the newest indexed compaction in this session.',
      },
      seq: {
        type: 'integer',
        description: 'Original session event seq for action=event. Must be a source or summary seq retained by the selected entry.',
      },
      query: {
        type: 'string',
        description: 'Literal query for action=search.',
      },
      offset: {
        type: 'integer',
        description: 'Character offset for action=entry/event, or match offset for action=search.',
      },
      limit: {
        type: 'integer',
        description: 'Character window for action=entry/event, or match limit for action=search.',
      },
    },
    output: OUTPUT,
    async execute(args, exec) {
      const resolved = await resolveToolSession(exec);
      if (resolved.error) return { text: resolved.error };
      const action = args?.action === 'event' || args?.action === 'search' ? args.action : 'entry';
      const entry = resolveEntry(resolved.entries, args?.entry_id);
      if (entry === null) {
        return { text: 'No matching sumidx entry in this session. Run sumidx_search first.' };
      }

      if (action === 'entry') {
        const full = renderEntryText(entry, { maxAnchors: 1000, maxValidation: 500 });
        const page = charPage(full, args?.offset ?? 0, Math.min(positiveInt(args?.limit, cfg.maxReadChars), cfg.maxReadChars));
        return { text: page.text + pageFooter(page) };
      }

      if (action === 'event') {
        const seq = args?.seq;
        if (!Number.isSafeInteger(seq)) return { text: 'action=event requires an integer seq.' };
        const allowed = new Set([...(entry.shadowedSeqs ?? []), entry.summarySeq]);
        if (!allowed.has(seq)) {
          return { text: 'seq=' + seq + ' is outside the selected entry\'s retained source/summary pointers.' };
        }
        const event = resolved.session.eventAt(seq);
        if (event === undefined) return { text: 'seq=' + seq + ' is no longer available in the live session store.' };
        const raw = renderRawEvent(event, { redact: false });
        const page = charPage(raw, args?.offset ?? 0, Math.min(positiveInt(args?.limit, cfg.maxReadChars), cfg.maxReadChars));
        return { text: page.text + pageFooter(page) };
      }

      const query = typeof args?.query === 'string' ? args.query : '';
      if (query.length === 0) return { text: 'action=search requires a non-empty query.' };
      const events = [];
      for (const seq of entry.shadowedSeqs ?? []) {
        const event = resolved.session.eventAt(seq);
        if (event !== undefined) events.push(event);
      }
      const normalized = normalizeSourceEvents(events, {
        maxEventChars: cfg.maxEventChars,
        maxTotalChars: cfg.maxTotalSourceChars,
      });
      const result = searchSourceRecords(normalized.records, query, {
        offset: Math.max(0, Number.isSafeInteger(args?.offset) ? args.offset : 0),
        limit: Math.min(positiveInt(args?.limit, 12), 20),
      });
      if (result.total === 0) {
        return { text: 'No literal match for ' + JSON.stringify(query) + ' in the source events retained by ' + entry.id + '.' };
      }
      const lines = ['source-event search: entry=' + entry.id + ' query=' + JSON.stringify(query)
        + ' total_matches=' + result.total];
      if (normalized.stats.truncatedByTotal || normalized.stats.sampledEvents > 0) {
        lines.push('WARNING: the source scan was bounded; some original event text was not searched.');
      }
      for (const match of result.matches) {
        lines.push('- seq ' + match.seq + ' [' + match.type + '] ' + match.snippet);
      }
      if (result.nextOffset !== null) lines.push('nextOffset=' + result.nextOffset);
      lines.push('Use action=event with one of these seq values to read the full original event.');
      return { text: lines.join('\n') };
    },
  });

  const probeTool = defineTool({
    name: 'sumidx_probe',
    description: 'Inspect or run deterministic reachability probes for the compaction index, or generate model-level recall questions. Probes test index search, exact anchor coverage, source-event pointers, and source range readability; they do not use summary-similarity metrics.',
    parameters: {
      action: {
        type: 'string',
        enum: ['status', 'run', 'questions'],
        description: 'status (default): index/probe overview; run: re-run reachability checks; questions: generate a repeatable recall probe pack.',
      },
      entry_id: {
        type: 'string',
        description: 'Exact sumidx entry id. Defaults to the newest indexed compaction in this session.',
      },
      limit: {
        type: 'integer',
        description: 'Maximum sampled anchors/questions (default 12, max 100).',
      },
    },
    output: OUTPUT,
    async execute(args, exec) {
      const resolved = await resolveToolSession(exec);
      if (resolved.error) return { text: resolved.error };
      const action = args?.action === 'run' || args?.action === 'questions' ? args.action : 'status';
      if (action === 'status') return { text: statusText(resolved.session, resolved.entries) };
      const entry = resolveEntry(resolved.entries, args?.entry_id);
      if (entry === null) return { text: 'No matching sumidx entry in this session. Run sumidx_search first.' };
      const limit = Math.min(positiveInt(args?.limit, 12), 100);
      if (action === 'questions') {
        return { text: createProbeQuestions(entry, { limit }) };
      }
      const probes = runEntryProbes(entry, (seq) => resolved.session.eventAt(seq), {
        limit: Math.min(limit, cfg.probeLimit),
        maxEventChars: cfg.maxEventChars,
      });
      let text = renderProbeText(probes, { maxItems: 100, includePassed: false });
      if (probes.criticalFailed > 0) {
        text += '\n\nA critical probe failed. Treat this entry as untrusted and use the raw source events, not the compacted summary.';
      }
      text += '\n\nThis diagnostic run did not modify the append-only index admission record.';
      return { text };
    },
  });

  ctx.tools.register(searchTool);
  ctx.tools.register(readTool);
  ctx.tools.register(probeTool);
}

function pageFooter(page) {
  if (!page || typeof page.total !== 'number') return '';
  return '\n\n[offset=' + page.offset + ' total=' + page.total
    + (page.nextOffset === null ? ' end=true' : ' nextOffset=' + page.nextOffset) + ']';
}



