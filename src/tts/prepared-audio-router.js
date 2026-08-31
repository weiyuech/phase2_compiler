import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import ffmpegStatic from 'ffmpeg-static'
import { PreparedAudioCache, abortedError } from './prepared-audio-cache.js'

const RATE = 16000
const BYTES_PER_MS = RATE * 2 / 1000
const CHUNK_BYTES = 640
const MAX_INPUT_BYTES = 64 * 1024 * 1024
const VALID_DESTINATIONS = new Set(['local', 'robot'])
const HANDLE = Symbol('prepared-robot-audio')
const hash = value => createHash('sha256').update(value).digest('hex')

/** Preparing never claims the speaker. Managed sessions leave priority and
 * restoration decisions to the speaking coordinator; one socket sends audio. */
export class PreparedAudioOutputRouter {
  constructor({ robot, filePath, ffmpegPath = ffmpegStatic, diagnostics = null,
    cacheDirectory, cacheMemoryBytes, cacheDiskBytes, decodeConcurrency,
    spawnProcess = spawn, now = () => performance.now(),
    schedule = setTimeout, unschedule = clearTimeout } = {}) {
    if (!robot) throw new Error('AudioOutputRouter requires a robot transport')
    Object.assign(this, { robot, filePath, ffmpegPath, diagnostics })
    this._spawn = spawnProcess
    this._now = now
    this._schedule = schedule
    this._unschedule = unschedule
    this._config = this._loadConfig()
    this._generation = 0
    this._destroyed = false
    this._active = null
    this._sessions = new Set()
    this._legacy = new Set()
    this._preparations = new Set()
    this._initializations = new Set()
    this._stoppingAll = false
    this._cache = new PreparedAudioCache({
      directory: cacheDirectory || (filePath ? join(dirname(filePath), 'robot-pcm-cache') : undefined),
      memoryBytes: cacheMemoryBytes, diskBytes: cacheDiskBytes, decodeConcurrency, diagnostics,
    })
    this._onDisconnected = () => { if (this.isRobotDestination()) this._invalidate(new Error('机器人连接已断开，音频任务已失效')) }
    this._onConnected = () => { if (this.isRobotDestination()) this._invalidate(new Error('机器人连接已更换，音频任务已失效')) }
    robot.on('disconnected', this._onDisconnected)
    robot.on('connected', this._onConnected)
  }
  get generation() { return this._generation }
  getCacheStats() { return this._cache.stats() }
  _loadConfig() {
    try {
      if (this.filePath && existsSync(this.filePath)) {
        const saved = JSON.parse(readFileSync(this.filePath, 'utf8'))
        if (VALID_DESTINATIONS.has(saved?.destination)) return { destination: saved.destination }
      }
    } catch (err) { console.warn('[音频输出] 配置读取失败:', err.message) }
    return { destination: 'local' }
  }
  getConfig() { return { ...this._config } }
  isRobotDestination() { return this._config.destination === 'robot' }
  setConfig(config = {}) {
    if (!VALID_DESTINATIONS.has(config.destination)) throw new Error(`无效的音频播放设备: ${config.destination}`)
    if (config.destination !== this._config.destination) {
      this._invalidate(abortedError())
      this._config = { destination: config.destination }
      if (this.filePath) {
        mkdirSync(dirname(this.filePath), { recursive: true })
        writeFileSync(this.filePath, JSON.stringify(this._config, null, 2))
      }
    }
    return this.getConfig()
  }
  _assertReady(generation = this.generation) {
    if (this._destroyed || generation !== this.generation) throw abortedError()
    if (!this.isRobotDestination()) throw new Error('当前播放设备不是机器人扬声器')
    if (!this.robot.isConnected()) throw new Error('机器人未连接，无法播放音频')
  }
  _invalidate(reason) {
    this._generation++
    for (const job of this._preparations) job.controller.abort()
    this._stoppingAll = true
    try {
      for (const legacy of [...this._legacy]) legacy.stop()
      for (const session of [...this._sessions]) session.fail(reason)
    } finally { this._active = null; this._stoppingAll = false }
    this.diagnostics?.event?.('robot_audio_generation', { generation: this.generation, reason: reason.message })
  }
  async prepareFile(filePath, { signal } = {}) {
    if (!filePath) throw new Error('音频文件路径为空')
    return this._prepare(async () => {
      const info = await stat(filePath)
      if (!info.isFile()) throw new Error('音频路径不是普通文件')
      const key = hash(`file:${resolve(filePath)}:${info.size}:${info.mtimeMs}:s16le:16000:mono`)
      return { key, filePath }
    }, signal)
  }
  async prepareBuffer(buffer, { signal, cacheKey = '' } = {}) {
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('MP3 音频数据为空')
    if (buffer.length > MAX_INPUT_BYTES) throw new Error('MP3 输入超过64MiB限制')
    return this._prepare(async () => ({ key: hash(`mp3:${cacheKey}:${hash(buffer)}:s16le:16000:mono`), buffer }), signal)
  }
  async _prepare(sourceFactory, externalSignal) {
    this._assertReady()
    if (!this.ffmpegPath || !existsSync(this.ffmpegPath)) throw new Error('未找到 ffmpeg')
    const generation = this.generation
    const controller = new AbortController()
    const abort = () => controller.abort()
    externalSignal?.addEventListener('abort', abort, { once: true })
    if (externalSignal?.aborted) controller.abort()
    const job = { controller, done: null }
    this._preparations.add(job)
    const startedAt = this._now()
    job.done = (async () => {
      if (controller.signal.aborted) throw abortedError()
      const source = await sourceFactory()
      this._assertReady(generation)
      const entry = await this._cache.prepare(source.key, write => this._decode(source, write, controller.signal), { signal: controller.signal })
      if (controller.signal.aborted || generation !== this.generation || this._destroyed) {
        this._cache.release(entry)
        throw abortedError()
      }
      let released = false
      const handle = {
        [HANDLE]: { router: this, entry, generation, connectionGeneration: this.robot.connectionGeneration,
          get released() { return released } },
        byteLength: entry.byteLength, durationMs: entry.durationMs,
        preparationMs: this._now() - startedAt, generation,
        storage: entry.buffer ? 'memory' : 'disk',
        release: () => { if (!released) { released = true; this._cache.release(entry) } },
      }
      this.diagnostics?.event?.('robot_audio_prepared', { bytes: handle.byteLength, durationMs: handle.durationMs,
        preparationMs: handle.preparationMs, storage: handle.storage, generation })
      return handle
    })()
    try { return await job.done } finally {
      externalSignal?.removeEventListener('abort', abort)
      this._preparations.delete(job)
    }
  }
  async _decode(source, write, signal) {
    if (signal.aborted) throw abortedError()
    const args = ['-hide_banner', '-loglevel', 'error',
      ...(source.buffer ? ['-f', 'mp3', '-i', 'pipe:0'] : ['-nostdin', '-i', source.filePath]),
      '-vn', '-f', 's16le', '-acodec', 'pcm_s16le', '-ac', '1', '-ar', String(RATE), 'pipe:1']
    const proc = this._spawn(this.ffmpegPath, args, { windowsHide: true, stdio: [source.buffer ? 'pipe' : 'ignore', 'pipe', 'pipe'] })
    let stderr = ''
    proc.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-16384) })
    let rejectDone
    const done = new Promise((resolve, reject) => {
      rejectDone = reject
      proc.once('error', reject)
      proc.once('close', (code, exitSignal) => {
        if (signal.aborted) reject(abortedError())
        else if (code !== 0) reject(new Error(`ffmpeg 音频转换失败: ${stderr.trim() || `exit ${code} ${exitSignal || ''}`}`))
        else resolve()
      })
    })
    done.catch(() => {})
    const cancel = () => { try { proc.kill('SIGKILL') } catch {}; rejectDone(abortedError()) }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      proc.stdin?.on('error', err => { if (err.code !== 'EPIPE') rejectDone(err) })
      if (source.buffer) proc.stdin.end(source.buffer)
      for await (const chunk of proc.stdout) {
        if (signal.aborted) throw abortedError()
        await write(chunk)
      }
      await done
    } catch (err) { try { proc.kill('SIGKILL') } catch {}; throw err }
    finally { signal.removeEventListener('abort', cancel) }
  }
  playPrepared(owner, prepared, opts = {}) {
    const metadata = prepared?.[HANDLE]
    if (!metadata || metadata.router !== this || metadata.released) throw new Error('无效或已释放的PCM准备句柄')
    this._assertReady(metadata.generation)
    if (metadata.connectionGeneration !== this.robot.connectionGeneration) throw abortedError()
    if (opts.signal?.aborted) throw abortedError()
    const sequenceState = opts.sequenceState || { nextSeq: 1 }
    if (!Number.isInteger(sequenceState.nextSeq) || sequenceState.nextSeq < 1) throw new Error('无效的音频序号')
    const session = new PreparedPcmSession(this, owner, metadata, { ...opts, sequenceState })
    this._sessions.add(session)
    const initialization = session.initialize()
    this._initializations.add(initialization)
    initialization.finally(() => this._initializations.delete(initialization))
    return session
  }
  _activate(session) {
    this._assertReady(session.generation)
    let previous = this._active?.isActive() ? this._active : null
    // A coordinator abort listener can resume the lower job before the upper
    // transport's abort listener runs. Retire that already-cancelled sender now.
    if (previous?.opts.signal?.aborted) { previous.stop(); previous = null }
    if (previous && previous !== session) {
      if (session.managed && !previous.paused) throw Object.assign(new Error('音频协调器尚未释放当前发声权'), { code: 'AUDIO_OWNERSHIP_CONFLICT' })
      if (!session.managed) { previous.pause('router-preempt'); session.previous = previous }
    }
    this._active = session
  }
  _release(session) {
    this._sessions.delete(session)
    if (this._active !== session) return
    this._active = null
    if (this._stoppingAll || session.managed) return
    let previous = session.previous
    while (previous && !previous.isActive()) previous = previous.previous
    if (previous?.isActive() && this._sessions.has(previous)) {
      this._active = previous
      previous.resume('router-preempt')
    }
  }
  _sendFrame(session, chunk, seq, fields) {
    if (this._active !== session) throw new Error('音频会话不再拥有机器人发送通道')
    this._assertReady(session.generation)
    this.robot.sendAudioFrame(chunk, seq, {
      generation: session.connectionGeneration,
      onComplete: (err, metrics) => {
        this.diagnostics?.packet?.({ ...fields, ...metrics, stage: 'socket_write', failed: !!err })
        if (err && session.isActive()) session.fail(err)
        else if (err) this.diagnostics?.event?.('error', session._metadata({
          errorCode: err.code || 'OTHER', failed: true, bufferedBytes: metrics?.bufferedAmount,
        }))
      },
    })
  }
  playFile(owner, filePath) { this._assertReady(); return new LegacyPreparationSession(this, owner, filePath) }
  startMp3Stream(owner) { this._assertReady(); return new LegacyPreparationSession(this, owner, null) }
  stopSession(session) { session?.stop() }
  stopAll() {
    this._stoppingAll = true
    try {
      for (const job of this._preparations) job.controller.abort()
      for (const session of [...this._legacy]) session.stop()
      for (const session of [...this._sessions]) session.stop()
    } finally { this._active = null; this._stoppingAll = false }
  }
  destroy() {
    if (this._destroyPromise) return this._destroyPromise
    this._destroyed = true
    this.stopAll()
    this.robot.off('connected', this._onConnected)
    this.robot.off('disconnected', this._onDisconnected)
    this._destroyPromise = Promise.allSettled([
      ...[...this._preparations].map(job => job.done), ...this._initializations,
    ]).then(() => this._cache.close())
    this._destroyPromise.catch(err => console.error('[机器人音频] 缓存清理失败:', err.message))
    return this._destroyPromise
  }
}

class PreparedPcmSession {
  constructor(router, owner, metadata, opts) {
    Object.assign(this, { router, owner, generation: metadata.generation, connectionGeneration: metadata.connectionGeneration, managed: !!opts.managed,
      sequenceState: opts.sequenceState, opts, previous: null })
    this.id = randomUUID()
    this.entry = router._cache.retain(metadata.entry)
    this._pauseReasons = new Set()
    this.active = true
    this._controller = new AbortController()
    this._externalAbort = () => this.stop()
    opts.signal?.addEventListener('abort', this._externalAbort, { once: true })
    this._reader = null
    this._readerReady = false
    this._timer = null
    this._offset = 0
    this._nextAt = 0
    this._lastAt = null
    this._estimatedEnd = null
    this._startedAt = null
    this._activated = false
    this._tailRemaining = 0
    this.promise = new Promise((resolve, reject) => { this._resolve = resolve; this._reject = reject })
    this.ready = new Promise((resolve, reject) => { this._readyResolve = resolve; this._readyReject = reject })
    this.ready.catch(() => {})
  }
  get paused() { return this._pauseReasons.size > 0 }
  isActive() { return this.active }
  _metadata(fields = {}) {
    return { sessionId: this.id, utteranceId: this.opts.utteranceId,
      source: this.opts.source || (this.opts.role === 'cruise' ? 'point' : this.opts.role), ...fields }
  }
  async initialize() {
    try {
      const reader = await this.router._cache.reader(this.entry, {
        signal: this._controller.signal, onData: () => { if (this._reader && this.active) this._schedule() },
      })
      if (!this.active) { reader.close(); return }
      this._reader = reader
      await reader.ready
      if (!this.active) return
      this._readerReady = true
      this._readyResolve()
      if (!this.paused) this._schedule()
    } catch (err) { if (this.active) this.fail(err) }
  }
  pause(reason = 'owner') {
    if (!this.active) return
    if (!this.paused && this._offset >= this.entry.byteLength) this._tailRemaining = Math.max(0, this._nextAt - this.router._now())
    this._pauseReasons.add(reason)
    this._lastAt = null
    this._clearTimer()
    this.router.diagnostics?.event?.('pause', this._metadata({ reason }))
  }
  resume(reason = 'owner') {
    if (!this.active) return
    this._pauseReasons.delete(reason)
    if (this.paused) return
    if (this._activated && this.router._active !== this) this.router._activate(this)
    this._nextAt = this.router._now() + this._tailRemaining
    this._tailRemaining = 0
    this._lastAt = null
    this.router.diagnostics?.event?.('resume', this._metadata({ reason }))
    this._schedule()
  }
  _schedule() {
    if (!this.active || this.paused || !this._readerReady || this._timer !== null) return
    const now = this.router._now()
    if (!this._nextAt || now - this._nextAt > 200) this._nextAt = now
    this._timer = this.router._schedule(() => this._tick(), Math.max(0, this._nextAt - now))
  }
  _tick() {
    this._timer = null
    if (!this.active || this.paused) return
    try {
      this.router._assertReady(this.generation)
      if (!this._activated) {
        if (this.opts.beforePlay?.() === false || this.opts.signal?.aborted) { this.stop(); return }
        if (this.opts.onAudioStart?.() === false) { this.stop(); return }
        if (!this.active || this.opts.signal?.aborted || this.generation !== this.router.generation) { this.stop(); return }
        this.router._activate(this)
        this._activated = true
        this._startedAt = this.router._now()
        this.router.diagnostics?.event?.('robot_audio_start', this._metadata({ bytes: this.entry.byteLength, generation: this.generation }))
      }
      if (this._offset === this.entry.byteLength) { this._finish(); return }
      const size = Math.min(CHUNK_BYTES, this.entry.byteLength - this._offset)
      const chunk = this._reader.take(size)
      if (!chunk) {
        this.router.diagnostics?.event?.('robot_audio_read_ahead_wait', this._metadata({ offset: this._offset }))
        return
      }
      const now = this.router._now()
      const latenessMs = Math.max(0, now - this._nextAt)
      // Rebase BEFORE adding this frame's duration. Rebasing only in the next
      // scheduling call would immediately send a second frame after a stall.
      if (latenessMs > 200) this._nextAt = now
      const seq = this.sequenceState.nextSeq
      const fields = this._metadata({ seq, bytes: size, gapMs: this._lastAt === null ? null : now - this._lastAt,
        latenessMs, generation: this.generation })
      this.router._sendFrame(this, chunk, seq, fields)
      if (!this.active) return
      this.sequenceState.nextSeq++
      this._offset += size
      this._lastAt = now
      this.router.diagnostics?.packet?.({ ...fields, stage: 'scheduled_send' })
      const durationMs = size / BYTES_PER_MS
      // Packet cadence may catch up after a short timer stall, but a sentence
      // cannot finish before the PCM just sent has had its computed duration.
      // Also account for several catch-up packets sent in the same turn. This
      // is a sender estimate, not a robot playback acknowledgment or latency.
      this._estimatedEnd = Math.max(this._estimatedEnd ?? now, now) + durationMs
      this._nextAt += durationMs
      if (this._offset === this.entry.byteLength) this._nextAt = this._estimatedEnd
      this._schedule()
    } catch (err) { this.fail(err) }
  }
  _clearTimer() {
    if (this._timer !== null) this.router._unschedule(this._timer)
    this._timer = null
  }
  _settle(result, error) {
    if (!this.active) return
    this.active = false
    this._clearTimer()
    this._controller.abort()
    this._reader?.close()
    this.opts.signal?.removeEventListener('abort', this._externalAbort)
    this.router._cache.release(this.entry)
    this.router._release(this)
    this._readyReject(error || abortedError())
    if (error) this._reject(error)
    else this._resolve(result)
  }
  stop() { this._settle({ ok: false, aborted: true }) }
  fail(err) {
    if (!this.active) return
    this.router.diagnostics?.event?.('robot_audio_failed', this._metadata({
      errorCode: err.code || 'OTHER', bufferedBytes: err.bufferedAmount,
    }))
    this._settle(null, err)
  }
  _finish() {
    this.router.diagnostics?.event?.('robot_audio_sent', this._metadata({ bytes: this._offset,
      elapsedMs: this.router._now() - this._startedAt, playbackAcknowledged: false }))
    this._settle({ ok: true })
  }
}

class LegacyPreparationSession {
  constructor(router, owner, filePath) {
    Object.assign(this, { router, owner, active: true, session: null, prepared: null })
    this._controller = new AbortController()
    this._pauseReasons = new Set()
    this._chunks = []
    this._inputBytes = 0
    this._ended = false
    this.promise = new Promise((resolve, reject) => { this._resolve = resolve; this._reject = reject })
    router._legacy.add(this)
    if (filePath) this._prepare(filePath)
  }
  async _prepare(filePath) {
    try {
      this.prepared = filePath
        ? await this.router.prepareFile(filePath, { signal: this._controller.signal })
        : await this.router.prepareBuffer(Buffer.concat(this._chunks), { signal: this._controller.signal })
      this._chunks = []
      if (!this.active) { this.prepared.release(); return }
      this.session = this.router.playPrepared(this.owner, this.prepared)
      for (const reason of this._pauseReasons) this.session.pause(reason)
      const result = await this.session.promise
      if (this.active) this._finish(result)
    } catch (err) { if (this.active) this._finish(null, err) }
  }
  write(chunk) {
    if (!this.active || this._ended) return
    this._inputBytes += chunk.length
    if (this._inputBytes > MAX_INPUT_BYTES) { this._finish(null, new Error('MP3 输入超过64MiB限制')); return }
    this._chunks.push(Buffer.from(chunk))
  }
  end() { if (!this.active || this._ended) return; this._ended = true; this._prepare(null) }
  pause(reason = 'owner') { this._pauseReasons.add(reason); this.session?.pause(reason) }
  resume(reason = 'owner') { this._pauseReasons.delete(reason); this.session?.resume(reason) }
  isActive() { return this.active }
  stop() { if (this.active) this._finish({ ok: false, aborted: true }) }
  _finish(result, error) {
    this.active = false
    this._controller.abort()
    this.session?.stop()
    this.prepared?.release()
    this._chunks = []
    this.router._legacy.delete(this)
    if (error) this._reject(error)
    else this._resolve(result)
  }
}
