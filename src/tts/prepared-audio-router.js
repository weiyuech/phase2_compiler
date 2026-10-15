import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import ffmpegStatic from 'ffmpeg-static'
import { PreparedAudioCache, abortedError } from './prepared-audio-cache.js'
import { AUDIO_SEND_POLICY, nextAudioFrameDeadline } from '../robot/audio-send-policy.js'

const RATE = 16000
const BYTES_PER_MS = RATE * 2 / 1000
const CHUNK_BYTES = 640
const DEFAULT_ROBOT_VOLUME_PERCENT = 100
const MAX_ROBOT_VOLUME_PERCENT = 150
const VOLUME_RAMP_SAMPLES = Math.round(RATE * 0.1)
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
    this._gain = this._config.robotVolumePercent / 100
    this._targetGain = this._gain
    this._gainStep = 0
    this._rampSamplesRemaining = 0
    this._generation = 0
    this._destroyed = false
    this._active = null
    this._lastPacket = null
    this._sessions = new Set()
    this._legacy = new Set()
    this._preparations = new Set()
    this._initializations = new Set()
    this._stoppingAll = false
    this._cache = new PreparedAudioCache({
      directory: cacheDirectory || (filePath ? join(dirname(filePath), 'robot-pcm-cache') : undefined),
      memoryBytes: cacheMemoryBytes, diskBytes: cacheDiskBytes, decodeConcurrency, diagnostics,
    })
    this._onDisconnected = () => {
      this._lastPacket = null
      if (this.isRobotDestination()) this._invalidate(new Error('机器人连接已断开，音频任务已失效'))
    }
    this._onConnected = () => {
      this._lastPacket = null
      if (this.isRobotDestination()) this._invalidate(new Error('机器人连接已更换，音频任务已失效'))
    }
    robot.on('disconnected', this._onDisconnected)
    robot.on('connected', this._onConnected)
  }
  get generation() { return this._generation }
  getCacheStats() { return this._cache.stats() }
  _loadConfig() {
    try {
      if (this.filePath && existsSync(this.filePath)) {
        const saved = JSON.parse(readFileSync(this.filePath, 'utf8'))
        return {
          destination: VALID_DESTINATIONS.has(saved?.destination) ? saved.destination : 'local',
          robotVolumePercent: this._validRobotVolume(saved?.robotVolumePercent)
            ? saved.robotVolumePercent
            : DEFAULT_ROBOT_VOLUME_PERCENT,
        }
      }
    } catch (err) { console.warn('[音频输出] 配置读取失败:', err.message) }
    return { destination: 'local', robotVolumePercent: DEFAULT_ROBOT_VOLUME_PERCENT }
  }
  _validRobotVolume(value) {
    return Number.isInteger(value) && value >= 0 && value <= MAX_ROBOT_VOLUME_PERCENT
  }
  getConfig() { return { ...this._config } }
  isRobotDestination() { return this._config.destination === 'robot' }
  validateConfig(config = {}) {
    const destination = config.destination ?? this._config.destination
    const robotVolumePercent = config.robotVolumePercent ?? this._config.robotVolumePercent
    if (!VALID_DESTINATIONS.has(destination)) throw new Error(`无效的音频播放设备: ${destination}`)
    if (!this._validRobotVolume(robotVolumePercent)) throw new Error('机器人音量必须是 0 到 150 之间的整数')
    return { destination, robotVolumePercent }
  }
  setConfig(config = {}) {
    const { destination, robotVolumePercent } = this.validateConfig(config)
    const destinationChanged = destination !== this._config.destination
    const volumeChanged = robotVolumePercent !== this._config.robotVolumePercent
    if (!destinationChanged && !volumeChanged) return this.getConfig()
    if (destinationChanged) {
      this._invalidate(abortedError())
    }
    const ramped = volumeChanged && !destinationChanged && this.isRobotDestination()
      && !!this._active?.isActive() && this._active._activated
    this._config = { destination, robotVolumePercent }
    if (volumeChanged || destinationChanged) this._setRobotVolume(robotVolumePercent, ramped)
    if (this.filePath) {
      mkdirSync(dirname(this.filePath), { recursive: true })
      writeFileSync(this.filePath, JSON.stringify(this._config, null, 2))
    }
    if (volumeChanged) this.diagnostics?.event?.('robot_volume_change', { destination, robotVolumePercent, ramped })
    return this.getConfig()
  }
  _setRobotVolume(percent, ramped) {
    const target = percent / 100
    this._targetGain = target
    if (!ramped) {
      this._gain = target
      this._gainStep = 0
      this._rampSamplesRemaining = 0
      return
    }
    this._rampSamplesRemaining = VOLUME_RAMP_SAMPLES
    this._gainStep = (target - this._gain) / VOLUME_RAMP_SAMPLES
  }
  _applyRobotGain(chunk) {
    if (this._rampSamplesRemaining === 0 && this._gain === 1) {
      // Keep cached/prepared PCM immutable even on the bit-exact 100% path.
      return { buffer: Buffer.from(chunk), clippedSamples: 0 }
    }
    const output = Buffer.from(chunk)
    let clippedSamples = 0
    for (let offset = 0; offset + 1 < output.length; offset += 2) {
      const sample = output.readInt16LE(offset)
      let adjusted = Math.round(sample * this._gain)
      if (adjusted > 32767) { adjusted = 32767; clippedSamples++ }
      else if (adjusted < -32768) { adjusted = -32768; clippedSamples++ }
      output.writeInt16LE(adjusted, offset)
      if (this._rampSamplesRemaining > 0) {
        this._rampSamplesRemaining--
        if (this._rampSamplesRemaining === 0) {
          this._gain = this._targetGain
          this._gainStep = 0
        } else {
          this._gain += this._gainStep
        }
      }
    }
    return { buffer: output, clippedSamples }
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
    const adjusted = this._applyRobotGain(chunk)
    const diagnosticFields = { ...fields, robotVolumePercent: this._config.robotVolumePercent,
      clippedSamples: adjusted.clippedSamples }
    const sentAt = this._now()
    this.robot.sendAudioFrame(adjusted.buffer, seq, {
      generation: session.connectionGeneration,
      onComplete: (err, metrics) => {
        this.diagnostics?.packet?.({ ...diagnosticFields, ...metrics, stage: 'socket_write', failed: !!err })
        if (err && session.isActive()) session.fail(err)
        else if (err) this.diagnostics?.event?.('error', session._metadata({
          errorCode: err.code || 'OTHER', failed: true, bufferedBytes: metrics?.bufferedAmount,
        }))
      },
    })
    if (session.connectionGeneration === this.robot.connectionGeneration) {
      // Stopping a session does not retract PCM already written to this socket.
      // Store only IDs/times, not a reference retaining the old prepared asset.
      this._lastPacket = { sessionId: session.id, connectionGeneration: session.connectionGeneration,
        sentAt, notBefore: sentAt + chunk.length / BYTES_PER_MS }
    }
    return diagnosticFields
  }
  _boundaryPacket(session) {
    const packet = this._lastPacket
    if (!packet || packet.connectionGeneration !== session.connectionGeneration) return null
    return session._needsWireBoundary || packet.sessionId !== session.id ? packet : null
  }
  _wireDeadline(session) {
    const packet = this._lastPacket
    if (!packet || packet.connectionGeneration !== session.connectionGeneration) return 0
    // Speaker handoff and final PCM tail retain the full frame duration.
    // Within one session allow only a tiny correction of normal timer jitter.
    if (session._needsWireBoundary || packet.sessionId !== session.id || session._offset === session.entry.byteLength) return packet.notBefore
    return Math.max(packet.sentAt, packet.notBefore - AUDIO_SEND_POLICY.maxPacingCorrectionMs)
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
    this._startNotified = false
    this._needsWireBoundary = true
    this._boundaryWaitLogged = false
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
    this._needsWireBoundary = true
    this._boundaryWaitLogged = false
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
    if (!this._nextAt) this._nextAt = now
    // An incoming speaker must first claim/pause the old sender. _tick still
    // enforces the wire boundary before notifying start or consuming PCM.
    const wireDeadline = this._activated ? this.router._wireDeadline(this) : 0
    // Round up: Node truncates fractional timer delays, which can otherwise
    // create repeated early callbacks. Never compensate a stall with a burst.
    const deadline = Math.max(this._nextAt, wireDeadline)
    this._timer = this.router._schedule(() => this._tick(), Math.max(0, Math.ceil(deadline - now)))
  }
  _tick() {
    this._timer = null
    if (!this.active || this.paused) return
    try {
      this.router._assertReady(this.generation)
      if (!this._activated) {
        if (this.opts.beforePlay?.() === false || this.opts.signal?.aborted) { this.stop(); return }
        // Claim/pause the old sender before waiting; otherwise an unmanaged
        // sender could keep moving the shared deadline and starve its successor.
        // Captions/start hooks still wait until the first packet can be sent.
        this.router._activate(this)
      }
      const boundary = this._offset < this.entry.byteLength ? this.router._boundaryPacket(this) : null
      if (boundary) {
        const now = this.router._now()
        // Rebase packet one too: merely delaying its callback would make packet
        // two immediately catch up on the old session-local schedule.
        this._nextAt = Math.max(now, boundary.notBefore)
        if (now < boundary.notBefore) {
          if (!this._boundaryWaitLogged) {
            this._boundaryWaitLogged = true
            this.router.diagnostics?.event?.('waiting', this._metadata({ reason: 'boundary', waitMs: boundary.notBefore - now }))
          }
          this._schedule()
          return
        }
      }
      const wireDeadline = this.router._wireDeadline(this)
      if (this.router._now() < wireDeadline) {
        this._nextAt = Math.max(this._nextAt, wireDeadline)
        this._schedule()
        return
      }
      const flow = this.router.robot.getAudioSendState?.({
        generation: this.connectionGeneration, drain: this._offset === this.entry.byteLength,
      })
      if (flow && !flow.writable) {
        // Keep the unread PCM and sequence in place. The transport owns one
        // bounded watchdog across pauses, sentence switches and user retries.
        this._nextAt = this.router._now() + flow.retryAfterMs
        this._schedule()
        return
      }
      if (!this._activated) {
        if (!this._startNotified) {
          if (this.opts.onAudioStart?.() === false) { this.stop(); return }
          this._startNotified = true
        }
        if (!this.active || this.opts.signal?.aborted || this.generation !== this.router.generation) { this.stop(); return }
        if (this.paused) return
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
      const resetPhase = this._needsWireBoundary || Boolean(boundary)
      const seq = this.sequenceState.nextSeq
      const fields = this._metadata({ seq, bytes: size, gapMs: this._lastAt === null ? null : now - this._lastAt,
        latenessMs, generation: this.generation })
      const sentFields = this.router._sendFrame(this, chunk, seq, fields)
      if (!this.active) return
      if (boundary) this.router.diagnostics?.event?.('handoff', this._metadata({ reason: 'boundary', gapMs: now - boundary.sentAt }))
      this._needsWireBoundary = false
      this._boundaryWaitLogged = false
      this.sequenceState.nextSeq++
      this._offset += size
      this._lastAt = now
      this.router.diagnostics?.packet?.({ ...sentFields, stage: 'scheduled_send' })
      const durationMs = size / BYTES_PER_MS
      // At most 2 ms phase correction, no multi-frame catch-up after stalls.
      // Completion still includes the duration of all packets just sent.
      this._estimatedEnd = Math.max(this._estimatedEnd ?? now, now) + durationMs
      this._nextAt = nextAudioFrameDeadline(this._nextAt, now, durationMs, resetPhase)
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
