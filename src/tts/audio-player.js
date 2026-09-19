/**
 * src/tts/audio-player.js
 *
 * 播放器：使用系统/打包的 ffplay 执行音频播放，完全无 Node.js 编译依赖。
 */

import { spawn, execSync } from 'child_process'
import { existsSync, writeFileSync, mkdirSync, constants, createReadStream } from 'fs'
import { access, stat } from 'node:fs/promises'
import { join, extname } from 'path'

let _ffplayPath = null

// 解析 ffplay 可执行文件路径。优先寻找绝对路径，避免依赖 Node.js spawn 在 Windows
// 上的可执行文件搜索行为（Node 20+ 的 libuv 不再搜索 cwd，参见 CVE-2024-27980）。
function resolveFfplayPath() {
  const isWin = process.platform === 'win32'
  const exeName = isWin ? 'ffplay.exe' : 'ffplay'

  // 1. 环境变量显式覆盖（便于运维手动指定）
  if (process.env.FFPLAY_PATH && existsSync(process.env.FFPLAY_PATH)) {
    return process.env.FFPLAY_PATH
  }

  // 2. 打包后随应用一起分发的 ffplay：主进程通过 PROJECT_ROOT 指向 resources/backend/
  if (process.env.PROJECT_ROOT) {
    const bundled = join(process.env.PROJECT_ROOT, exeName)
    if (existsSync(bundled)) return bundled
  }

  // 3. 开发模式：工作目录下（robot-live-system 根目录）已有 ffplay.exe
  const localBundled = join(process.cwd(), exeName)
  if (existsSync(localBundled)) return localBundled

  // 4. macOS：GUI App 不继承 shell PATH，硬编码 Homebrew 常见位置
  if (process.platform === 'darwin') {
    for (const p of ['/usr/local/bin/ffplay', '/opt/homebrew/bin/ffplay']) {
      if (existsSync(p)) return p
    }
  }

  // 5. Windows 用 where，Unix 用 which，拿到绝对路径
  try {
    const cmd = isWin ? 'where ffplay' : 'which ffplay'
    const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    // where 可能返回多行；取第一行
    const firstLine = out.split(/\r?\n/)[0]?.trim()
    if (firstLine && existsSync(firstLine)) return firstLine
  } catch {}

  // 6. 最后兜底：让系统按 PATH 解析。注意：这一步只能确认 ffplay 可通过 shell 调用，
  // 后续 spawn(不带 shell) 仍可能失败并抛 ENOENT——调用方通过 catch 感知即可。
  try {
    execSync(`${isWin ? 'ffplay.exe' : 'ffplay'} -version`, { stdio: 'ignore' })
    return isWin ? 'ffplay.exe' : 'ffplay'
  } catch {}

  return false
}

function getFfplayPath() {
  if (_ffplayPath !== null) return _ffplayPath
  _ffplayPath = resolveFfplayPath()
  if (_ffplayPath) {
    console.log(`[AudioPlayer] 使用 ffplay: ${_ffplayPath}`)
  } else {
    console.error('[AudioPlayer] 未找到 ffplay，请安装 ffmpeg 或设置 FFPLAY_PATH 环境变量')
  }
  return _ffplayPath
}

function hasFfplay() {
  return getFfplayPath() !== false
}

let _instanceCounter = 0

// Drain stderr continuously so failures explain missing DLLs/devices/decoders,
// without retaining an unbounded player log or blocking a full stderr pipe.
function playbackFailure(child) {
  let tail = ''
  child.stderr?.on('data', chunk => { tail = (tail + chunk.toString()).slice(-4096) })
  return code => new Error(`ffplay 播放失败 (${code})${tail.trim() ? ': ' + tail.trim() : ''}`)
}

export class AudioPlayer {
  constructor({ outputRouter = null, spawnProcess = spawn, resolvePlaybackPath = getFfplayPath } = {}) {
    this.currentProcess = null
    this._remoteSession = null
    this.outputRouter   = outputRouter
    this._paused        = false
    this._spawnProcess = spawnProcess
    this._resolvePlaybackPath = resolvePlaybackPath
    this._pendingFile = null
    // 每个实例一个独立的临时文件后缀，避免多个 AudioPlayer（如过渡音频 + 主 TTS）
    // 同时写入 data/temp-tts-play.mp3 时在 Windows 上因 ffplay 占用文件而 EBUSY
    this._instanceId    = ++_instanceCounter
  }

  startStream() {
    const wasPaused = this._paused
    this.stop()

    if (this.outputRouter?.isRobotDestination()) {
      let session
      try {
        session = this.outputRouter.startMp3Stream(this)
      } catch (err) {
        console.error('[AudioPlayer] 无法启动机器人音频流:', err.message)
        return null
      }
      this._remoteSession = session
      this._paused = wasPaused
      if (this._paused) session.pause()

      const playPromise = session.promise.finally(() => {
        if (this._remoteSession === session) this._remoteSession = null
      })
      return {
        write: (buf) => session.write(buf),
        end:   () => session.end(),
        promise: playPromise,
      }
    }

    const ffplayPath = this._resolvePlaybackPath()
    if (!ffplayPath) {
      console.error('[AudioPlayer] 错误: 系统未检测到 ffplay，无法播放声音，请安装 ffmpeg!')
      return null
    }

    const ffplay = this._spawnProcess(ffplayPath, [
      '-nodisp',
      '-autoexit',
      '-loglevel', 'error',
      '-infbuf',
      '-f', 'mp3',
      '-'
    ], { windowsHide: true })
    const failure = playbackFailure(ffplay)

    this.currentProcess = ffplay
    this._paused = wasPaused

    if (this._paused) {
      this.pause()
    }

    ffplay.stdout.resume()

    ffplay.stdin.on('error', (err) => {
      if (err.code !== 'EPIPE') console.error('[AudioPlayer] ffplay stdin 错误:', err)
    })

    // Optional readiness signal for gated handoffs. A child object returned by
    // spawn() is not evidence that its executable was successfully launched.
    const ready = new Promise((resolve, reject) => {
      ffplay.once('spawn', resolve)
      ffplay.once('error', reject)
    })
    ready.catch(() => {}) // Existing streaming callers need not consume ready.
    const playPromise = new Promise((resolve, reject) => {
      ffplay.on('error', (err) => {
        if (this.currentProcess === ffplay) this.currentProcess = null
        reject(err.code === 'ENOENT' ? new Error('ffplay 未找到') : err)
      })

      ffplay.on('close', (code) => {
        if (this.currentProcess === ffplay) this.currentProcess = null
        if (code != null && code !== 0) reject(failure(code))
        else resolve()
      })
    })

    return {
      write: (buf) => {
        if (this.currentProcess === ffplay) {
          ffplay.stdin.write(buf)
        }
      },
      end: () => {
        if (this.currentProcess === ffplay) {
          ffplay.stdin.end()
        }
      },
      promise: playPromise,
      ready,
    }
  }



  async play(audioBuffer) {
    if (this.outputRouter?.isRobotDestination()) {
      const stream = this.startStream()
      if (!stream) throw new Error('无法启动机器人音频播放流')
      stream.write(audioBuffer)
      stream.end()
      return stream.promise
    }

    const USER_DATA = process.env.USER_DATA_DIR
    const DATA_DIR = USER_DATA ? join(USER_DATA, 'data') : './data'
    const tempFile = join(DATA_DIR, `temp-tts-play-${process.pid}-${this._instanceId}.mp3`)

    try {
      mkdirSync(DATA_DIR, { recursive: true })
      writeFileSync(tempFile, audioBuffer)
    } catch (err) {
      console.error('[AudioPlayer] 写入临时音频文件失败:', err.message)
      // 必须 throw：调用方（例如过渡音频循环）依赖异常来打破 while(true)，
      // 否则会形成 tight loop 榨干 CPU
      throw err
    }

    return this.playFile(tempFile)
  }

  /** Prepared robot units retain a single sequence counter across sentences. */
  async playPrepared(handle, opts = {}) {
    const wasPaused = this._paused
    this.stop()
    this._paused = wasPaused
    const session = this.outputRouter.playPrepared(this, handle, opts)
    this._remoteSession = session
    if (this._paused) session.pause()
    try {
      return await session.promise
    } finally {
      if (this._remoteSession === session) this._remoteSession = null
    }
  }

  /** Local sentences use the existing ffplay MP3 pipe, one complete unit each. */
  async playSentence(buffer, opts = {}) {
    const stream = this.startStream()
    if (!stream) throw new Error('无法启动音频播放流')
    const child = this.currentProcess
    let cancelled = false
    let wakeAbort
    const cancellation = new Promise(resolve => { wakeAbort = () => resolve(false) })
    const cancel = () => {
      cancelled = true
      wakeAbort()
      if (child && this.currentProcess === child) this.stop()
    }
    opts.signal?.addEventListener('abort', cancel, { once: true })
    stream.promise.catch(() => {})
    try {
      if (opts.signal?.aborted) cancel()
      if (cancelled || await Promise.race([Promise.resolve(stream.ready), cancellation]) === false) return { ok: false, aborted: true }
      if (opts.waitForPlayback && await Promise.race([
        Promise.resolve(opts.waitForPlayback({ signal: opts.signal })), cancellation,
      ]) === false) { cancel(); return { ok: false, aborted: true } }
      if (cancelled || opts.signal?.aborted || opts.beforePlay?.() === false) { cancel(); return { ok: false, aborted: true } }
      if (opts.onAudioStart?.() === false) { cancel(); return { ok: false, aborted: true } }
      if (cancelled || opts.signal?.aborted) return { ok: false, aborted: true }
      stream.write(buffer)
      stream.end()
      await Promise.race([stream.promise, cancellation])
      return cancelled || opts.signal?.aborted ? { ok: false, aborted: true } : { ok: true }
    } catch (error) {
      cancel()
      throw error
    } finally {
      opts.signal?.removeEventListener('abort', cancel)
    }
  }

  async playFile(filePath, opts = {}) {
    if (this.outputRouter?.isRobotDestination()) {
      const wasPaused = this._paused
      this.stop()
      this._paused = wasPaused

      let session
      try {
        session = this.outputRouter.playFile(this, filePath)
      } catch (err) {
        console.error('[AudioPlayer] 无法启动机器人文件播放:', err.message)
        throw err
      }
      this._remoteSession = session
      if (this._paused) await session.pause()
      try {
        await session.promise
      } finally {
        if (this._remoteSession === session) this._remoteSession = null
      }
      return
    }

    const ffplayPath = this._resolvePlaybackPath()
    if (!ffplayPath) {
      const msg = '系统未检测到 ffplay，无法播放声音，请安装 ffmpeg 或将 ffplay.exe 放到应用目录下'
      console.error(`[AudioPlayer] 错误: ${msg}`)
      // 必须 throw：调用方（过渡音频循环等）依赖异常来打破 while(true)
      throw new Error(msg)
    }

    const wasPaused = this._paused
    this.stop()
    this._paused = wasPaused
    const pending = new AbortController()
    this._pendingFile = pending
    const abortExternal = () => pending.abort()
    opts.signal?.addEventListener('abort', abortExternal, { once: true })
    if (opts.signal?.aborted) pending.abort()
    const cancelled = () => pending.signal.aborted || this._pendingFile !== pending
    let wakeCancellation
    const cancellation = new Promise(resolve => { wakeCancellation = () => resolve(false) })
    pending.signal.addEventListener('abort', wakeCancellation, { once: true })
    try {
      if (cancelled()) return { ok: false, aborted: true }
      await access(filePath, constants.R_OK)
      if (!(await stat(filePath)).isFile()) throw new Error('音频文件不是普通文件')
      if (cancelled()) return { ok: false, aborted: true }
      if (opts.waitForPlayback) {
        const allowed = await Promise.race([
          Promise.resolve(opts.waitForPlayback({ signal: pending.signal })), cancellation,
        ])
        if (allowed === false || cancelled()) return { ok: false, aborted: true }
      }
      if (cancelled() || (opts.beforePlay && !opts.beforePlay())) return { ok: false, aborted: true }

      return await new Promise((resolve, reject) => {
        // Gated files use stdin so a launched process cannot emit narration
        // before the final eligibility check (e.g. a host starts during spawn).
        // Ungated/local and robot playback retain their existing input paths.
        const gated = typeof opts.waitForPlayback === 'function'
        // Ordinary M4A can store its moov index after its audio. A pipe cannot
        // seek back to those samples (even ffmpeg may exit 0 with no decoded
        // audio). Preserve the baseline seekable local-transit input for M4A;
        // acquire before launch and still recheck/cancel/pause at child startup.
        const pipeInput = gated && extname(filePath).toLowerCase() !== '.m4a'
        const ffplay = this._spawnProcess(ffplayPath, [
          '-nodisp', '-autoexit', '-loglevel', 'error',
          // Shared transit pools also accept WAV/OGG/M4A. Let ffplay probe the
          // input container rather than incorrectly declaring every file MP3.
          ...(pipeInput ? ['-i', 'pipe:0'] : [filePath]),
        ], { windowsHide: true })
        const failure = playbackFailure(ffplay)
        ffplay.stdout?.resume()
        this.currentProcess = ffplay
        let started = false
        let source = null
        const abortPlayback = () => {
          source?.destroy()
          if (this.currentProcess === ffplay) {
            try { ffplay.kill('SIGKILL') } catch {}
            this.currentProcess = null
          }
          resolve({ ok: false, aborted: true })
        }
        pending.signal.addEventListener('abort', abortPlayback, { once: true })
        const cleanUp = () => {
          pending.signal.removeEventListener('abort', abortPlayback)
          source?.destroy()
        }
        if (this._paused) this.pause()
        ffplay.once('spawn', async () => {
          try {
            if (gated) {
              const allowed = await Promise.race([
                Promise.resolve(opts.waitForPlayback({ signal: pending.signal })), cancellation,
              ])
              if (allowed === false) { abortPlayback(); return }
            }
            if (cancelled() || (opts.beforePlay && !opts.beforePlay())) {
              abortPlayback()
              return
            }
            if (!started) {
              started = true
              try {
                if (opts.onAudioStart?.() === false) { abortPlayback(); return }
              } catch (err) {
                console.error('[AudioPlayer] onAudioStart hook threw:', err.message)
              }
            }
            if (pipeInput && !cancelled()) {
              source = createReadStream(filePath)
              source.once('error', err => { reject(err); abortPlayback() })
              source.pipe(ffplay.stdin)
            }
          } catch (err) {
            // Reject before cancellation resolves so the caller sees failures.
            reject(err)
            abortPlayback()
          }
        })
        if (pipeInput) ffplay.stdin.on('error', err => {
          if (err.code !== 'EPIPE') console.error('[AudioPlayer] ffplay stdin 错误:', err)
        })
        ffplay.once('error', (err) => {
          cleanUp()
          if (this.currentProcess === ffplay) this.currentProcess = null
          reject(err.code === 'ENOENT' ? new Error('ffplay 未找到') : err)
          pending.abort()
        })
        ffplay.once('close', (code) => {
          cleanUp()
          if (this.currentProcess === ffplay) this.currentProcess = null
          if (!cancelled() && code != null && code !== 0) reject(failure(code))
          else resolve(cancelled() ? { ok: false, aborted: true } : undefined)
        })
      })
    } finally {
      pending.signal.removeEventListener('abort', wakeCancellation)
      opts.signal?.removeEventListener('abort', abortExternal)
      if (this._pendingFile === pending) this._pendingFile = null
    }
  }

  async pause() {
    this._paused = true
    const child = this.currentProcess
    if (this._remoteSession) {
      await this._remoteSession.pause()
    }
    if (child && this.currentProcess === child) {
      if (process.platform === 'win32') {
        try {
          const ps = (await import('process-suspend')).default
          if (this.currentProcess === child && this._paused) ps.suspend(child)
        } catch (e) {
          console.error('[AudioPlayer] Windows pause 失败:', e.message)
        }
      } else {
        try {
          process.kill(child.pid, 'SIGSTOP')
        } catch (e) {
          console.error('[AudioPlayer] SIGSTOP 失败:', e.message)
        }
      }
    }
  }

  async resume() {
    this._paused = false
    const child = this.currentProcess
    if (this._remoteSession) {
      await this._remoteSession.resume()
    }
    if (child && this.currentProcess === child) {
      if (process.platform === 'win32') {
        try {
          const ps = (await import('process-suspend')).default
          if (this.currentProcess === child && !this._paused) ps.resume(child)
        } catch (e) {
          console.error('[AudioPlayer] Windows resume 失败:', e.message)
        }
      } else {
        try {
          process.kill(child.pid, 'SIGCONT')
        } catch (e) {
          console.error('[AudioPlayer] SIGCONT 失败:', e.message)
        }
      }
    }
  }

  stop({ clearPause = false } = {}) {
    if (clearPause) this._paused = false
    const pending = this._pendingFile
    this._pendingFile = null
    pending?.abort()
    if (this._remoteSession) {
      this.outputRouter?.stopSession(this._remoteSession)
      this._remoteSession = null
    }
    if (this.currentProcess) {
      try {
        this.currentProcess.kill('SIGKILL')
      } catch {}
      this.currentProcess = null
    }
  }

  isPlaying() {
    return this.currentProcess !== null || !!this._remoteSession?.isActive()
  }
}
