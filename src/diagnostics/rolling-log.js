import { appendFile, lstat, mkdir, open, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const HISTORY_BYTES = 1024 * 1024
export const SEGMENT_BYTES = HISTORY_BYTES / 2
const LOG_NAMES = new Set(['backend.log', 'audio-diagnostics.log', 'robot-diagnostics.log', 'robot-incidents.log'])

function paths(directory, name) {
  if (!directory || !LOG_NAMES.has(name)) throw new TypeError('Invalid diagnostics log target')
  const current = join(directory, name)
  return { current, previous: `${current}.1` }
}

async function regularSize(path) {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) throw Object.assign(new Error('Unsafe log target'), { code: 'UNSAFE_LOG_PATH' })
    return info.size
  } catch (err) {
    if (err.code === 'ENOENT') return 0
    throw err
  }
}

export function utf8Tail(value, maxBytes) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8')
  let start = Math.max(0, buffer.length - maxBytes)
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++
  return buffer.subarray(start).toString('utf8')
}

async function tail(path, limit) {
  const size = await regularSize(path)
  if (!size || !limit) return ''
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(Math.min(size, limit))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, size - buffer.length)
    return utf8Tail(buffer.subarray(0, bytesRead), limit)
  } finally { await handle.close() }
}

/** Read at most one category budget, in chronological order. Safe after crashes. */
export async function readRollingLog({ directory, name }) {
  const target = paths(directory, name)
  const current = await tail(target.current, HISTORY_BYTES)
  const previous = await tail(target.previous, HISTORY_BYTES - Buffer.byteLength(current))
  return previous + current
}

/**
 * One owner per category. Two <=512 KiB segments, never 1 MiB plus a backup.
 * append() only queues bounded records; a serialized async drain owns all I/O.
 */
export class RollingLog {
  constructor({ directory, name, queueBytes = 64 * 1024, recordBytes = 16 * 1024, flushMs = 250,
    appendFile: appendFileImpl = appendFile }) {
    this.directory = directory
    this.name = name
    this.paths = paths(directory, name)
    this.queueLimit = Math.max(1024, Math.min(queueBytes, SEGMENT_BYTES))
    this.recordLimit = Math.max(256, Math.min(recordBytes, this.queueLimit, SEGMENT_BYTES))
    this.queue = []
    this.queuedBytes = 0
    this.currentBytes = 0
    this.previousBytes = 0
    this.droppedRecords = 0
    this.discardedBytes = 0
    this.truncatedRecords = 0
    this.errorCode = null
    this.closed = false
    this.initialized = false
    // Narrow I/O seam for deterministic stalled/full-disk tests; production
    // always uses the same asynchronous appendFile implementation by default.
    this._appendFile = appendFileImpl
    this._draining = null
    this._ready = this._initialize().catch(err => { this._recordError(err) })
    this._timer = setInterval(() => { void this._drain() }, flushMs)
    this._timer.unref?.()
  }

  _recordError(err) {
    // Never expose error.message: it commonly contains an absolute path.
    const safeCodes = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'EROFS', 'EIO', 'UNSAFE_LOG_PATH'])
    this.errorCode = safeCodes.has(err?.code) ? err.code : 'IO_ERROR'
  }

  async _initialize() {
    await mkdir(this.directory, { recursive: true })
    this.currentBytes = await regularSize(this.paths.current)
    this.previousBytes = await regularSize(this.paths.previous)
    if (this.currentBytes > SEGMENT_BYTES || this.previousBytes > SEGMENT_BYTES) {
      // Only the two known legacy files are migrated; unrelated files are untouched.
      const oldBytes = this.currentBytes + this.previousBytes
      const retained = Buffer.from(await readRollingLog({ directory: this.directory, name: this.name }))
      let split = Math.max(0, retained.length - SEGMENT_BYTES)
      if (split > 0) {
        const newline = retained.indexOf(10, split)
        if (newline >= 0) split = newline + 1
        else while (split < retained.length && (retained[split] & 0xc0) === 0x80) split++
      }
      const current = utf8Tail(retained.subarray(split), SEGMENT_BYTES)
      const previous = utf8Tail(retained.subarray(0, split), SEGMENT_BYTES)
      // Verify both replacements before replacing known old histories. Fixed temp
      // paths are guarded against symlinks and recovered on the next startup.
      for (const [path, content] of [[this.paths.previous, previous], [this.paths.current, current]]) {
        const temporary = `${path}.migrate.tmp`
        await regularSize(temporary)
        await writeFile(temporary, content, 'utf8')
        if (await regularSize(temporary) !== Buffer.byteLength(content)) throw Object.assign(new Error('Migration write failed'), { code: 'EIO' })
      }
      await rename(`${this.paths.previous}.migrate.tmp`, this.paths.previous)
      await rename(`${this.paths.current}.migrate.tmp`, this.paths.current)
      this.currentBytes = Buffer.byteLength(current)
      this.previousBytes = Buffer.byteLength(previous)
      this.discardedBytes += oldBytes - this.currentBytes - this.previousBytes
    }
    // Recover only our two fixed migration scratch files after verified histories.
    for (const path of [this.paths.current, this.paths.previous]) {
      const temporary = `${path}.migrate.tmp`
      await regularSize(temporary)
      await unlink(temporary).catch(err => { if (err.code !== 'ENOENT') throw err })
    }
    this.initialized = true
  }

  append(value) {
    if (this.closed) return false
    let line = String(value)
    if (!line.endsWith('\n')) line += '\n'
    if (Buffer.byteLength(line) > this.recordLimit) {
      const marker = '[oversized record truncated] '
      line = marker + utf8Tail(line, this.recordLimit - Buffer.byteLength(marker))
      this.truncatedRecords++
    }
    const bytes = Buffer.byteLength(line)
    while (this.queuedBytes + bytes > this.queueLimit && this.queue.length) {
      const dropped = this.queue.shift()
      this.queuedBytes -= dropped.bytes
      this.droppedRecords++
      this.discardedBytes += dropped.bytes
    }
    this.queue.push({ line, bytes })
    this.queuedBytes += bytes
    return true
  }

  async _rotate() {
    await regularSize(this.paths.previous)
    await unlink(this.paths.previous).catch(err => { if (err.code !== 'ENOENT') throw err })
    this.discardedBytes += this.previousBytes
    await rename(this.paths.current, this.paths.previous).catch(err => { if (err.code !== 'ENOENT') throw err })
    this.previousBytes = this.currentBytes
    this.currentBytes = 0
  }

  async _drain() {
    if (this._draining) return this._draining
    this._draining = (async () => {
      await this._ready
      const records = this.queue.splice(0)
      this.queuedBytes = 0
      if (!records.length) return
      if (!this.initialized) {
        this.droppedRecords += records.length
        return
      }
      let remaining = records.length
      try {
        let batch = '', batchBytes = 0, batchRecords = 0
        const commit = async () => {
          if (!batchBytes) return
          await this._appendFile(this.paths.current, batch, 'utf8')
          this.currentBytes += batchBytes
          remaining -= batchRecords
          batch = ''; batchBytes = 0; batchRecords = 0
        }
        for (const record of records) {
          if (this.currentBytes + batchBytes + record.bytes > SEGMENT_BYTES) {
            await commit()
            await this._rotate()
          }
          batch += record.line
          batchBytes += record.bytes
          batchRecords++
        }
        await commit()
        this.errorCode = null
      } catch (err) {
        this._recordError(err)
        this.droppedRecords += remaining
        // A partial failed write makes counters uncertain. Stop writing until
        // restart instead of risking repeated retries growing beyond the cap.
        this.initialized = false
      }
    })().finally(() => { this._draining = null })
    return this._draining
  }

  snapshot() {
    return {
      capBytes: HISTORY_BYTES, storedBytes: this.currentBytes + this.previousBytes,
      queuedBytes: this.queuedBytes, droppedRecords: this.droppedRecords,
      discardedBytes: this.discardedBytes, truncatedRecords: this.truncatedRecords,
      status: this.errorCode ? 'error' : (this.initialized ? 'recording' : 'initializing'),
      errorCode: this.errorCode,
    }
  }

  async flush() {
    await this._ready
    await this._draining
    await this._drain()
  }

  async destroy() {
    this.closed = true
    clearInterval(this._timer)
    await this.flush()
  }
}
