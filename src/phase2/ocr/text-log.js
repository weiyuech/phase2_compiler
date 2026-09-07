import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Small bounded serial queue for the user-downloadable OCR text log. Slow or
 * antivirus-scanned disks may drop log lines, but can never block robot audio
 * or grow an unbounded write backlog.
 */
export class BoundedOcrTextLog {
  constructor({ filePath, maxPending = 32, fsApi = fs, logger = console } = {}) {
    this.filePath = filePath;
    this.maxPending = maxPending;
    this.fs = fsApi;
    this.logger = logger;
    this.generation = 0;
    this.queue = [];
    this.running = false;
    this.idleWaiters = [];
    this.dropped = 0;
    this.closed = false;
  }

  reset() {
    if (this.closed) return false;
    const generation = ++this.generation;
    return this._enqueue(async () => {
      if (generation !== this.generation) return;
      await this.fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await this.fs.writeFile(this.filePath, '', 'utf8');
    }, { replacePending: true });
  }

  append(line) {
    if (this.closed || !line) return false;
    const generation = this.generation;
    return this._enqueue(async () => {
      if (generation !== this.generation) return;
      await this.fs.appendFile(this.filePath, line, 'utf8');
    });
  }

  async flush() {
    if (!this.running && this.queue.length === 0) return;
    await new Promise(resolve => this.idleWaiters.push(resolve));
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.flush();
  }

  _enqueue(operation, { replacePending = false } = {}) {
    if (replacePending) {
      // A new session's truncate supersedes every queued old-session append.
      // The one operation already on disk is allowed to finish, then truncate.
      this.queue.length = 0;
    } else if (this.queue.length + (this.running ? 1 : 0) >= this.maxPending) {
      this.dropped += 1;
      if (this.dropped === 1) {
        this.logger.warn('[Phase 2] [OCR] Text log is slow; dropping queued log records.');
      }
      return false;
    }

    this.queue.push(operation);
    this._drain();
    return true;
  }

  _drain() {
    if (this.running) return;
    const operation = this.queue.shift();
    if (!operation) {
      const waiters = this.idleWaiters.splice(0);
      for (const resolve of waiters) resolve();
      return;
    }

    this.running = true;
    Promise.resolve()
      .then(operation)
      .catch(error => {
        this.logger.error('[Phase 2] Failed to write OCR log:', error.message);
      })
      .finally(() => {
        this.running = false;
        this._drain();
      });
  }
}
