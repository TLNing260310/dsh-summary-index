import { mkdir, open, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { safeFileComponent } from './text.mjs';

const ENTRY_FILE = 'entries.jsonl';

/**
 * Append-only, plugin-owned index store. Retrieval tools never write here; the
 * compaction observer is the only writer. The directory is namespaced by plugin
 * and session so it cannot collide with DSH's session log or another plugin.
 */
export class SummaryIndexStore {
  /**
   * @param {{root: string, maxReadBytes?: number, maxEntryBytes?: number}} options
   */
  constructor(options) {
    if (typeof options?.root !== 'string' || options.root.length === 0) {
      throw new Error('dsh-summary-index: store root must be a non-empty path');
    }
    this.root = options.root;
    this.maxReadBytes = Number.isSafeInteger(options.maxReadBytes) && options.maxReadBytes > 0
      ? options.maxReadBytes
      : 64 * 1024 * 1024;
    this.maxEntryBytes = Number.isSafeInteger(options.maxEntryBytes) && options.maxEntryBytes > 0
      ? options.maxEntryBytes
      : 2 * 1024 * 1024;
    this.writeQueues = new Map();
  }

  /**
   * @param {string} sessionId
   * @returns {string}
   */
  sessionDirectory(sessionId) {
    return join(this.root, 'sessions', safeFileComponent(sessionId));
  }

  /**
   * @param {string} sessionId
   * @returns {string}
   */
  entryPath(sessionId) {
    return join(this.sessionDirectory(sessionId), ENTRY_FILE);
  }

  /**
   * Read the append-only index. A damaged/partial final JSONL line is ignored,
   * but a systematic read failure is thrown so the caller can surface a warning
   * rather than silently pretending the index is empty.
   *
   * @param {string} sessionId
   * @returns {Promise<{entries: Array<any>, truncated: boolean, invalidLines: number, path: string}>}
   */
  async load(sessionId) {
    const path = this.entryPath(sessionId);
    let info;
    try {
      info = await stat(path);
    } catch (error) {
      if (error?.code === 'ENOENT') return { entries: [], truncated: false, invalidLines: 0, path };
      throw error;
    }
    if (!info.isFile()) throw new Error('summary-index entry path is not a regular file: ' + path);

    let text = '';
    let truncated = false;
    if (info.size <= this.maxReadBytes) {
      text = await readFile(path, 'utf8');
    } else {
      truncated = true;
      const handle = await open(path, 'r');
      try {
        const start = Math.max(0, info.size - this.maxReadBytes);
        const buffer = Buffer.alloc(this.maxReadBytes);
        const { bytesRead } = await handle.read(buffer, 0, this.maxReadBytes, start);
        text = buffer.subarray(0, bytesRead).toString('utf8');
        if (start > 0) {
          const newline = text.indexOf('\n');
          if (newline >= 0) text = text.slice(newline + 1);
        }
      } finally {
        await handle.close();
      }
    }

    const entries = [];
    let invalidLines = 0;
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        const entry = JSON.parse(line);
        if (entry && entry.schema === 'sumidx.entry/v1' && typeof entry.id === 'string') entries.push(entry);
        else invalidLines++;
      } catch {
        invalidLines++;
      }
    }
    return { entries, truncated, invalidLines, path };
  }

  /**
   * Serialize and append one entry, then fsync it. Serialization per session
   * prevents interleaved JSONL records from concurrent compaction events.
   *
   * @param {string} sessionId
   * @param {any} entry
   * @returns {Promise<string>} path
   */
  async append(sessionId, entry) {
    const key = String(sessionId);
    const previous = this.writeQueues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(() => this.#appendNow(key, entry));
    this.writeQueues.set(key, current);
    try {
      return await current;
    } finally {
      if (this.writeQueues.get(key) === current) this.writeQueues.delete(key);
    }
  }

  async #appendNow(sessionId, entry) {
    const directory = this.sessionDirectory(sessionId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const line = JSON.stringify(entry) + '\n';
    if (Buffer.byteLength(line, 'utf8') > this.maxEntryBytes) {
      const error = new Error('summary-index entry exceeds maxEntryBytes');
      error.code = 'SUMIDX_ENTRY_TOO_LARGE';
      throw error;
    }
    const path = this.entryPath(sessionId);
    const handle = await open(path, 'a', 0o600);
    try {
      await handle.writeFile(line, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    return path;
  }
}

export default SummaryIndexStore;
