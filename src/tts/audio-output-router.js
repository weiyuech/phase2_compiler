import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import ffmpegStatic from 'ffmpeg-static'

const AUDIO_RATE          = 16000
const AUDIO_SAMPLE_BYTES  = 2
const AUDIO_CHUNK_MS      = 20
const AUDIO_CHUNK_BYTES   = AUDIO_RATE * AUDIO_SAMPLE_BYTES * AUDIO_CHUNK_MS / 1000
const PREBUFFER_BYTES     = AUDIO_CHUNK_BYTES * 3       // 60 ms before first frame
const BUFFER_HIGH_WATER   = AUDIO_RATE * AUDIO_SAMPLE_BYTES
const BUFFER_LOW_WATER    = BUFFER_HIGH_WATER / 2
const DEFAULT_CONFIG      = { destination: 'local' }
const VALID_DESTINATIONS  = new Set(['local', 'robot'])

/**
 * Shared audio destination and robot PCM transport.
 *
 * All AudioPlayer instances use this single router. In robot mode it enforces
 * one active stream, converts MP3 to 16 kHz mono S16_LE with ffmpeg, and sends
 * one base64 JSON frame every 20 ms over the existing robot WebSocket.
 */
export class AudioOutputRouter {
  constructor({ robot, filePath, ffmpegPath = ffmpegStatic } = {}) {
    if (!robot) throw new Error('AudioOutputRouter requires a robot transport')
    this.robot       = robot
    this.filePath    = filePath
    this.ffmpegPath  = ffmpegPath
    this._config     = this._loadConfig()
    this._active     = null
    this._sessions   = new Set()
    this._stoppingAll = false

    this._onRobotDisconnected = () => {
      this._failAll(new Error('机器人连接已断开，远程音频已停止'))
    }
    this.robot.on('disconnected', this._onRobotDisconnected)

    console.log(`[音频输出] 当前播放设备: ${this._config.destination === 'robot' ? '机器人扬声器' : '本机扬声器'}`)
  }

  _loadConfig() {
    if (!this.filePath || !existsSync(this.filePath)) return { ...DEFAULT_CONFIG }
    try {
      const saved = JSON.parse(readFileSync(this.filePath, 'utf8'))
      const destination = VALID_DESTINATIONS.has(saved?.destination)
        ? saved.destination
        : DEFAULT_CONFIG.destination
      return { destination }
    } catch (err) {
      console.warn('[音频输出] 读取配置失败，使用本机扬声器:', err.message)
      return { ...DEFAULT_CONFIG }
    }
  }

  getConfig() {
    return { ...this._config }
  }

  setConfig(config = {}) {
    const destination = config.destination
    if (!VALID_DESTINATIONS.has(destination)) {
      throw new Error(`无效的音频播放设备: ${destination}`)
    }

    if (destination !== this._config.destination) {
      this.stopAll()
      this._config = { destination }
      if (this.filePath) {
        mkdirSync(dirname(this.filePath), { recursive: true })
        writeFileSync(this.filePath, JSON.stringify(this._config, null, 2))
      }
      console.log(`[音频输出] 已切换到: ${destination === 'robot' ? '机器人扬声器（WebSocket）' : '本机扬声器（现有方式）'}`)
    }
    return this.getConfig()
  }

  isRobotDestination() {
    return this._config.destination === 'robot'
  }

  startMp3Stream(owner) {
    return this._startSession(owner, { kind: 'stream' })
  }

  playFile(owner, filePath) {
    if (!filePath) throw new Error('音频文件路径为空')
    return this._startSession(owner, { kind: 'file', filePath })
  }

  _startSession(owner, source) {
    if (!this.isRobotDestination()) {
      throw new Error('当前播放设备不是机器人扬声器')
    }
    if (!this.robot.isConnected()) {
      throw new Error('机器人未连接，无法通过机器人扬声器播放')
    }
    if (!this.ffmpegPath || !existsSync(this.ffmpegPath)) {
      throw new Error('未找到 ffmpeg，无法将音频转换为 16 kHz PCM')
    }

    // There is only one physical robot speaker stream. Preserve the previous
    // session in a paused state so existing priority/ducking logic can resume it
    // later, but never allow two sources to interleave PCM frames.
    const previous = this._active?.isActive() ? this._active : null
    if (previous) previous.pause('router-preempt')
    const session = new RobotPcmSession({
      router: this,
      owner,
      source,
      ffmpegPath: this.ffmpegPath,
      previous,
    })
    this._active = session
    this._sessions.add(session)
    return session
  }

  _sendFrame(session, chunk, seq) {
    if (this._active !== session) {
      throw new Error('机器人音频会话已被新的播放任务替换')
    }
    this.robot.sendAudioFrame(chunk, seq)
  }

  _release(session) {
    this._sessions.delete(session)
    if (this._active !== session) return
    this._active = null
    if (this._stoppingAll) return

    // Restore the session displaced by this foreground source. Removing only
    // the router's pause reason means a host/duck pause remains authoritative.
    const previous = session.previous
    if (previous?.isActive() && this._sessions.has(previous)) {
      this._active = previous
      previous.resume('router-preempt')
    }
  }

  stopSession(session) {
    if (session) session.stop()
  }

  stopAll() {
    if (this._sessions.size === 0) return
    this._stoppingAll = true
    try {
      for (const session of [...this._sessions]) session.stop()
    } finally {
      this._active = null
      this._stoppingAll = false
    }
  }

  _failAll(err) {
    if (this._sessions.size === 0) return
    this._stoppingAll = true
    try {
      for (const session of [...this._sessions]) session.fail(err)
    } finally {
      this._active = null
      this._stoppingAll = false
    }
  }

  destroy() {
    this.stopAll()
    this.robot.off('disconnected', this._onRobotDisconnected)
  }
}

class RobotPcmSession {
  constructor({ router, owner, source, ffmpegPath, previous = null }) {
    this.router       = router
    this.owner        = owner
    this.source       = source
    this.ffmpegPath   = ffmpegPath
    this.previous     = previous
    this.process      = null
    this._pauseReasons = new Set()
    this.active       = true
    this._pcm         = Buffer.alloc(0)
    this._timer       = null
    this._started     = false
    this._decoderDone = false
    this._stdoutHeld  = false
    this._settled     = false
    this._seq         = 1
    this._sentBytes   = 0
    this._nextSendAt  = 0
    this._stderr      = ''
    this._startedAt   = Date.now()

    this.promise = new Promise((resolve, reject) => {
      this._resolve = resolve
      this._reject  = reject
    })

    this._spawnDecoder()
  }

  _spawnDecoder() {
    const inputArgs = this.source.kind === 'stream'
      ? ['-f', 'mp3', '-i', 'pipe:0']
      : ['-nostdin', '-i', this.source.filePath]
    const args = [
      '-hide_banner', '-loglevel', 'error',
      ...inputArgs,
      '-vn',
      '-f', 's16le', '-acodec', 'pcm_s16le',
      '-ac', '1', '-ar', String(AUDIO_RATE),
      'pipe:1',
    ]

    const inputLabel = this.source.kind === 'stream' ? 'TTS MP3 流' : this.source.filePath
    console.log(`[机器人音频] 开始转换并传输: ${inputLabel}`)

    const proc = spawn(this.ffmpegPath, args, {
      stdio: [this.source.kind === 'stream' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.process = proc

    proc.on('error', (err) => this.fail(
      err.code === 'ENOENT' ? new Error('ffmpeg 未找到') : err
    ))

    proc.stderr.on('data', (chunk) => {
      this._stderr = (this._stderr + chunk.toString('utf8')).slice(-16384)
    })

    proc.stdout.on('data', (chunk) => {
      if (!this.active) return
      this._pcm = this._pcm.length === 0
        ? Buffer.from(chunk)
        : Buffer.concat([this._pcm, chunk])

      if (this._pcm.length >= BUFFER_HIGH_WATER && !this._stdoutHeld) {
        proc.stdout.pause()
        this._stdoutHeld = true
      }
      this._ensureScheduled()
    })

    proc.on('close', (code, signal) => {
      this.process = null
      if (!this.active) return
      if (code !== 0) {
        const detail = this._stderr.trim() || `exit ${code}${signal ? `, signal ${signal}` : ''}`
        this.fail(new Error(`ffmpeg 音频转换失败: ${detail}`))
        return
      }
      this._decoderDone = true
      this._ensureScheduled()
    })

    if (proc.stdin) {
      proc.stdin.on('error', (err) => {
        // EPIPE is followed by ffmpeg's close/error and contains the useful detail.
        if (err.code !== 'EPIPE' && this.active) this.fail(err)
      })
    }
  }

  write(buffer) {
    if (!this.active || !this.process?.stdin || this.process.stdin.destroyed) return
    this.process.stdin.write(buffer)
  }

  end() {
    if (!this.active || !this.process?.stdin || this.process.stdin.destroyed) return
    this.process.stdin.end()
  }

  get paused() {
    return this._pauseReasons.size > 0
  }

  async pause(reason = 'owner') {
    if (!this.active) return
    const wasPaused = this.paused
    this._pauseReasons.add(reason)
    if (wasPaused) return
    this._clearTimer()
    await setProcessSuspended(this.process, true)
  }

  async resume(reason = 'owner') {
    if (!this.active) return
    this._pauseReasons.delete(reason)
    if (this.paused) return
    await setProcessSuspended(this.process, false)
    this._nextSendAt = Date.now()
    this._ensureScheduled()
  }

  isActive() {
    return this.active
  }

  _ensureScheduled() {
    if (!this.active || this.paused || this._timer) return

    if (!this._started) {
      if (this._pcm.length < PREBUFFER_BYTES && !this._decoderDone) return
      if (this._pcm.length === 0 && this._decoderDone) {
        this._finish()
        return
      }
      this._started = true
      this._nextSendAt = Date.now()
    }

    if (this._pcm.length === 0) {
      if (this._decoderDone) this._finish()
      return
    }

    if (this._pcm.length < AUDIO_CHUNK_BYTES && !this._decoderDone) return

    const now = Date.now()
    if (now - this._nextSendAt > 200) this._nextSendAt = now
    const delay = Math.max(0, this._nextSendAt - now)
    this._timer = setTimeout(() => this._tick(), delay)
  }

  _tick() {
    this._timer = null
    if (!this.active || this.paused) return

    if (this._pcm.length === 0) {
      if (this._decoderDone) this._finish()
      return
    }
    if (this._pcm.length < AUDIO_CHUNK_BYTES && !this._decoderDone) return

    const size = Math.min(AUDIO_CHUNK_BYTES, this._pcm.length)
    const chunk = this._pcm.subarray(0, size)
    this._pcm = this._pcm.subarray(size)

    try {
      this.router._sendFrame(this, chunk, this._seq)
    } catch (err) {
      this.fail(err)
      return
    }
    this._seq++
    this._sentBytes += chunk.length

    if (this._stdoutHeld && this._pcm.length <= BUFFER_LOW_WATER) {
      this.process?.stdout?.resume()
      this._stdoutHeld = false
    }

    // Wait through the duration represented by the final frame as well. This
    // keeps play()/playFile() completion aligned with what the robot hears.
    this._nextSendAt += AUDIO_CHUNK_MS
    const delay = Math.max(0, this._nextSendAt - Date.now())
    this._timer = setTimeout(() => {
      this._timer = null
      this._ensureScheduled()
    }, delay)
  }

  stop() {
    if (!this.active) return
    this.active = false
    this._clearTimer()
    this._pcm = Buffer.alloc(0)
    try { this.process?.stdin?.destroy() } catch {}
    try { this.process?.kill('SIGKILL') } catch {}
    this.process = null
    this.router._release(this)
    this._settleResolve()
  }

  fail(err) {
    if (!this.active) return
    this.active = false
    this._clearTimer()
    this._pcm = Buffer.alloc(0)
    try { this.process?.stdin?.destroy() } catch {}
    try { this.process?.kill('SIGKILL') } catch {}
    this.process = null
    this.router._release(this)
    console.error('[机器人音频] 传输失败:', err.message)
    this._settleReject(err)
  }

  _finish() {
    if (!this.active) return
    this.active = false
    this._clearTimer()
    this.router._release(this)
    const frames = this._seq - 1
    const elapsed = Date.now() - this._startedAt
    console.log(`[机器人音频] 播放完成: ${frames} 帧, ${this._sentBytes} PCM bytes, ${elapsed} ms`)
    this._settleResolve()
  }

  _clearTimer() {
    if (this._timer) clearTimeout(this._timer)
    this._timer = null
  }

  _settleResolve() {
    if (this._settled) return
    this._settled = true
    this._resolve()
  }

  _settleReject(err) {
    if (this._settled) return
    this._settled = true
    this._reject(err)
  }
}

async function setProcessSuspended(proc, suspended) {
  if (!proc?.pid) return
  if (process.platform === 'win32') {
    try {
      const processSuspend = (await import('process-suspend')).default
      if (suspended) processSuspend.suspend(proc)
      else processSuspend.resume(proc)
    } catch (err) {
      console.error(`[机器人音频] Windows ${suspended ? 'pause' : 'resume'} 失败:`, err.message)
    }
    return
  }

  try {
    process.kill(proc.pid, suspended ? 'SIGSTOP' : 'SIGCONT')
  } catch (err) {
    // The decoder may have already exited after filling the bounded PCM queue.
    if (err.code !== 'ESRCH') {
      console.error(`[机器人音频] ${suspended ? 'SIGSTOP' : 'SIGCONT'} 失败:`, err.message)
    }
  }
}

export const ROBOT_AUDIO_FORMAT = Object.freeze({
  rate: AUDIO_RATE,
  channels: 1,
  sampleFormat: 's16le',
  chunkMs: AUDIO_CHUNK_MS,
  chunkBytes: AUDIO_CHUNK_BYTES,
})
