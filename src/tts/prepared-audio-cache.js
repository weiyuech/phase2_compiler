import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, open, readFile, readdir, unlink, rmdir } from 'node:fs/promises'
import { join, basename, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

const OWNED_FILE = /^pcm-[0-9a-f-]{36}\.pcm$/
export const abortedError = () => Object.assign(new Error('音频准备已取消'), { name: 'AbortError', code: 'AUDIO_CANCELLED' })

/** Runtime cache: ref-counted assets, LRU unused eviction, and accounted spool /
 * read-ahead reservations. No unbounded decoder stdout accumulation in RAM. */
export class PreparedAudioCache {
  constructor({ directory, memoryBytes = 64 * 1024 * 1024, diskBytes = 256 * 1024 * 1024,
    decodeConcurrency = 2, diagnostics } = {}) {
    if (memoryBytes < 2560 || diskBytes < 640) throw new Error('音频缓存限额过小')
    this.maxMemoryBytes = memoryBytes
    this.maxDiskBytes = diskBytes
    this.memoryBytes = 0
    this.diskBytes = 0
    this.entries = new Map()
    this._temporary = !directory
    this.directory = directory ? resolve(directory) : null
    this.diagnostics = diagnostics
    this._capacity = Promise.resolve()
    this._activeDecodes = 0
    this._decodeLimit = Math.max(1, decodeConcurrency)
    this._decodeWaiters = []
    this._closed = false
    this._nonce = randomUUID()
    this._ready = this._initialize()
    this._ready.catch(() => {})
  }

  async _initialize() {
    if (!this.directory) this.directory = await mkdtemp(join(tmpdir(), 'robot-pcm-cache-'))
    else await mkdir(this.directory, { recursive: true })
    this._lockPath = join(this.directory, 'owner.json')
    let lock
    try { lock = await open(this._lockPath, 'wx', 0o600) } catch (err) {
      if (err.code !== 'EEXIST') throw err
      const owner = JSON.parse(await readFile(this._lockPath, 'utf8'))
      if (owner.kind !== 'robot-pcm-cache-v1' || !Number.isInteger(owner.pid) || owner.pid < 1) {
        throw new Error('音频缓存所有权文件无效，未清理任何文件')
      }
      let alive = true
      try { process.kill(owner.pid, 0) } catch (probe) { if (probe.code === 'ESRCH') alive = false }
      if (alive) throw new Error('音频缓存正由其他运行实例使用')
      await unlink(this._lockPath)
      lock = await open(this._lockPath, 'wx', 0o600)
    }
    try {
      await this._writeOwnerLock(lock)
      await lock.close()
    } catch (err) {
      // We created this exact lock with wx. A partial write (e.g. disk full)
      // must not leave an invalid owner file that blocks every later launch.
      await lock.close().catch(() => {})
      await unlink(this._lockPath).catch(() => {})
      throw err
    }
    this._ownsLock = true
    // Only our generated files in the exclusively-owned cache directory. Never
    // recursively clean a data directory or remove arbitrary user files.
    for (const name of await readdir(this.directory)) {
      if (OWNED_FILE.test(name)) await this._unlink(join(this.directory, name))
    }
  }

  _writeOwnerLock(lock) {
    return lock.writeFile(JSON.stringify({ kind: 'robot-pcm-cache-v1', pid: process.pid, nonce: this._nonce }))
  }

  async _unlink(path) {
    if (resolve(path) !== join(this.directory, basename(path)) || !OWNED_FILE.test(basename(path))) {
      throw new Error('拒绝清理非音频缓存路径')
    }
    try { await unlink(path) } catch (err) { if (err.code !== 'ENOENT') throw err }
  }

  async _locked(fn) {
    const previous = this._capacity
    let release
    this._capacity = new Promise(resolve => { release = resolve })
    await previous
    try { return await fn() } finally { release() }
  }

  _unused(kind) {
    return [...this.entries.values()].filter(e => e.refs === 0 && (kind === 'memory' ? !!e.buffer : !!e.path))
      .sort((a, b) => a.used - b.used)
  }

  async _evict(entry) {
    if (entry.refs) return false
    if (entry.path) {
      await this._unlink(entry.path)
      this.diskBytes -= entry.byteLength
      entry.path = null
    }
    if (entry.buffer) { this.memoryBytes -= entry.byteLength; entry.buffer = null }
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key)
    return true
  }

  async reserveDisk(bytes) {
    return this._locked(async () => {
      for (const entry of this._unused('disk')) {
        if (this.diskBytes + bytes <= this.maxDiskBytes) break
        await this._evict(entry)
      }
      if (this.diskBytes + bytes > this.maxDiskBytes) throw Object.assign(new Error('机器人音频磁盘缓存已达上限'), { code: 'AUDIO_CACHE_LIMIT' })
      this.diskBytes += bytes
    })
  }

  async reserveMemory(bytes, optional = false) {
    return this._locked(async () => {
      for (const entry of this._unused('memory')) {
        if (this.memoryBytes + bytes <= this.maxMemoryBytes) break
        await this._evict(entry)
      }
      if (this.memoryBytes + bytes > this.maxMemoryBytes) {
        if (optional) return false
        throw Object.assign(new Error('机器人音频内存缓存已达上限'), { code: 'AUDIO_CACHE_LIMIT' })
      }
      this.memoryBytes += bytes
      return true
    })
  }

  retain(entry) {
    if (!entry.buffer && !entry.path) throw new Error('准备好的音频已被释放')
    entry.refs++
    entry.used = performance.now()
    return entry
  }

  release(entry) {
    if (entry.refs > 0) entry.refs--
    entry.used = performance.now()
  }

  _cached(key) {
    // Disk eviction awaits unlink(). A cache hit must not retain that entry in
    // the middle of eviction, after the zero-ref check but before deletion.
    return this._locked(() => {
      const entry = this.entries.get(key)
      return entry ? this.retain(entry) : null
    })
  }

  async _decodeSlot(signal) {
    if (signal?.aborted || this._closed) throw abortedError()
    if (this._activeDecodes < this._decodeLimit) { this._activeDecodes++; return }
    if (this._decodeWaiters.length >= 32) throw new Error('音频准备队列已满')
    await new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal }
      waiter.abort = () => {
        const index = this._decodeWaiters.indexOf(waiter)
        if (index >= 0) this._decodeWaiters.splice(index, 1)
        reject(abortedError())
      }
      signal?.addEventListener('abort', waiter.abort, { once: true })
      this._decodeWaiters.push(waiter)
    })
  }

  _releaseDecodeSlot() {
    const next = this._decodeWaiters.shift()
    if (next) {
      next.signal?.removeEventListener('abort', next.abort)
      next.resolve() // Transfer this reserved slot; never exceed concurrency.
    } else this._activeDecodes--
  }

  async prepare(key, decode, { signal } = {}) {
    await this._ready
    if (signal?.aborted || this._closed) throw abortedError()
    const cached = await this._cached(key)
    if (cached) return cached
    await this._decodeSlot(signal)
    let file, path, bytes = 0
    let memoryReservation = 0
    let borrowedEntry = null
    try {
      if (signal?.aborted || this._closed) throw abortedError()
      const reused = await this._cached(key)
      if (reused) return reused
      path = join(this.directory, `pcm-${randomUUID()}.pcm`)
      file = await open(path, 'wx', 0o600)
      await decode(async chunk => {
        if (signal?.aborted || this._closed) throw abortedError()
        await this.reserveDisk(chunk.length)
        bytes += chunk.length
        let written = 0
        while (written < chunk.length) {
          const result = await file.write(chunk, written, chunk.length - written)
          if (!result.bytesWritten) throw new Error('PCM 缓存写入失败')
          written += result.bytesWritten
        }
      })
      await file.close(); file = null
      if (signal?.aborted || this._closed) throw abortedError()
      if (!bytes || bytes % 2) throw new Error('ffmpeg 未生成有效的16位PCM音频')
      const duplicate = await this._cached(key)
      if (duplicate) {
        borrowedEntry = duplicate
        await this._unlink(path); path = null; this.diskBytes -= bytes
        borrowedEntry = null
        return duplicate
      }
      const entry = { key, byteLength: bytes, durationMs: bytes / 32, refs: 1, used: performance.now(), buffer: null, path }
      // Leave read-ahead capacity for disk-backed active assets. Failed RAM
      // admission keeps the completely decoded file; it never starts streaming
      // from an unfinished decode.
      if (bytes <= this.maxMemoryBytes / 2 && await this.reserveMemory(bytes, true)) {
        memoryReservation = bytes
        entry.buffer = await readFile(path)
        if (signal?.aborted || this._closed) throw abortedError()
        await this._unlink(path)
        this.diskBytes -= bytes
        entry.path = null
        path = null
        memoryReservation = 0
      }
      // Another concurrent decode of the same key may have completed while
      // this one was admitting its buffer. Retire the duplicate reservation.
      const winner = await this._locked(() => {
        const existing = this.entries.get(key)
        if (existing) return this.retain(existing)
        this.entries.set(key, entry)
        return null
      })
      if (winner) {
        borrowedEntry = winner
        if (entry.buffer) { this.memoryBytes -= bytes; entry.buffer = null }
        if (entry.path) { await this._unlink(entry.path); this.diskBytes -= bytes; entry.path = null }
        path = null
        borrowedEntry = null
        return winner
      }
      path = null // Entry now owns the disk reservation.
      this.diagnostics?.event?.('audio_cache_ready', { bytes, storage: entry.buffer ? 'memory' : 'disk', ...this.stats() })
      return entry
    } catch (err) {
      // A duplicate winner is retained before asynchronous spool cleanup. If
      // cleanup fails, no handle reaches the caller: roll its reference back
      // before another cleanup attempt can itself throw.
      if (borrowedEntry) this.release(borrowedEntry)
      if (memoryReservation) this.memoryBytes -= memoryReservation
      if (file) await file.close().catch(() => {})
      if (path) { await this._unlink(path); this.diskBytes -= bytes }
      throw err
    } finally { this._releaseDecodeSlot() }
  }

  async reader(entry, { signal, onData } = {}) {
    if (signal?.aborted || this._closed) throw abortedError()
    if (entry.buffer) {
      let offset = 0
      return { ready: Promise.resolve(), take: size => {
        const result = entry.buffer.subarray(offset, offset + size)
        offset += result.length
        return result
      }, close() {} }
    }
    // Read 256 KiB ahead by default (~8 seconds PCM). Stream internal buffering
    // and queued blocks share a bounded reservation; no filesystem call per tick.
    const budget = Math.min(512 * 1024, Math.floor(this.maxMemoryBytes / 2))
    await this.reserveMemory(budget)
    if (signal?.aborted || this._closed) { this.memoryBytes -= budget; throw abortedError() }
    const reader = new DiskPcmReader(entry.path, { budget, minimumReady: Math.min(640, entry.byteLength), signal, onData,
      release: () => { this.memoryBytes -= budget } })
    return reader
  }

  stats() { return { memoryBytes: this.memoryBytes, diskBytes: this.diskBytes, entries: this.entries.size, activeDecodes: this._activeDecodes } }

  async close() {
    this._closed = true
    for (const waiter of this._decodeWaiters.splice(0)) {
      waiter.signal?.removeEventListener('abort', waiter.abort)
      waiter.reject(abortedError())
    }
    await this._ready.catch(() => {})
    await this._capacity
    if (!this._ownsLock) return
    for (const entry of this.entries.values()) {
      if (entry.path) await this._unlink(entry.path)
      entry.buffer = null; entry.path = null
    }
    this.entries.clear()
    this.memoryBytes = 0
    this.diskBytes = 0
    try {
      const owner = JSON.parse(await readFile(this._lockPath, 'utf8'))
      if (owner.nonce === this._nonce) await unlink(this._lockPath)
    } catch (err) { if (err.code !== 'ENOENT') throw err }
    this._ownsLock = false
    if (this._temporary) await rmdir(this.directory).catch(() => {})
  }
}

class DiskPcmReader {
  constructor(path, { budget, minimumReady, signal, onData, release }) {
    this._chunks = []
    this._bytes = 0
    this._offset = 0
    this._closed = false
    this._ended = false
    this.error = null
    this._release = release
    this._signal = signal
    this._abort = () => this.close()
    this.ready = new Promise((resolve, reject) => { this._readyResolve = resolve; this._readyReject = reject })
    this.ready.catch(() => {})
    this._blockBytes = Math.floor(budget / 3)
    this._stream = createReadStream(path, { highWaterMark: this._blockBytes })
    this._stream.on('data', chunk => {
      if (this._closed) return
      this._chunks.push(chunk); this._bytes += chunk.length
      if (this._bytes >= minimumReady) this._readyResolve()
      if (this._bytes >= Math.max(minimumReady, this._blockBytes)) this._stream.pause()
      onData?.()
    })
    this._stream.on('error', err => { this.error = err; this._readyReject(err); onData?.() })
    this._stream.on('end', () => { this._ended = true; this._readyResolve(); onData?.() })
    signal?.addEventListener('abort', this._abort, { once: true })
  }
  take(size) {
    if (this.error) throw this.error
    if (this._bytes < size) {
      if (this._ended) throw new Error('已准备的PCM缓存被截断')
      this._stream.resume(); return null
    }
    const first = this._chunks[0]
    let result
    if (first.length - this._offset >= size) result = first.subarray(this._offset, this._offset + size)
    else {
      result = Buffer.allocUnsafe(size)
      let copied = 0, offset = this._offset
      for (const chunk of this._chunks) {
        const count = Math.min(chunk.length - offset, size - copied)
        chunk.copy(result, copied, offset, offset + count)
        copied += count; offset = 0
        if (copied === size) break
      }
    }
    this._bytes -= size
    let consumed = size
    while (consumed) {
      const remaining = this._chunks[0].length - this._offset
      if (consumed < remaining) { this._offset += consumed; consumed = 0 }
      else { consumed -= remaining; this._chunks.shift(); this._offset = 0 }
    }
    if (!this._closed && this._bytes < this._blockBytes / 2) this._stream.resume()
    return result
  }
  close() {
    if (this._closed) return
    this._closed = true
    this._signal?.removeEventListener('abort', this._abort)
    this._stream.destroy()
    this._chunks = []; this._bytes = 0
    this._readyReject(abortedError())
    this._release()
  }
}
