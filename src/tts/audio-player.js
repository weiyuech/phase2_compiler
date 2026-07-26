/**
 * src/tts/audio-player.js
 *
 * 播放器：使用系统/打包的 ffplay 执行音频播放，完全无 Node.js 编译依赖。
 */

import { spawn, execSync } from 'child_process'
import { existsSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'

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

export class AudioPlayer {
  constructor() {
    this.currentProcess = null
    this._paused        = false
    // 每个实例一个独立的临时文件后缀，避免多个 AudioPlayer（如过渡音频 + 主 TTS）
    // 同时写入 data/temp-tts-play.mp3 时在 Windows 上因 ffplay 占用文件而 EBUSY
    this._instanceId    = ++_instanceCounter
  }

  startStream() {
    const wasPaused = this._paused
    this.stop()

    const ffplayPath = getFfplayPath()
    if (!ffplayPath) {
      console.error('[AudioPlayer] 错误: 系统未检测到 ffplay，无法播放声音，请安装 ffmpeg!')
      return null
    }

    const ffplay = spawn(ffplayPath, [
      '-nodisp',
      '-autoexit',
      '-loglevel', 'quiet',
      '-infbuf',
      '-f', 'mp3',
      '-'
    ])

    this.currentProcess = ffplay
    this._paused = wasPaused

    if (this._paused) {
      this.pause()
    }

    ffplay.stdout.resume()

    ffplay.stdin.on('error', (err) => {
      if (err.code !== 'EPIPE') console.error('[AudioPlayer] ffplay stdin 错误:', err)
    })

    const playPromise = new Promise((resolve, reject) => {
      ffplay.on('error', (err) => {
        this.currentProcess = null
        reject(err.code === 'ENOENT' ? new Error('ffplay 未找到') : err)
      })

      ffplay.on('close', () => {
        if (this.currentProcess === ffplay) this.currentProcess = null
        resolve()
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
      promise: playPromise
    }
  }



  async play(audioBuffer) {
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

  async playFile(filePath) {
    const ffplayPath = getFfplayPath()
    if (!ffplayPath) {
      const msg = '系统未检测到 ffplay，无法播放声音，请安装 ffmpeg 或将 ffplay.exe 放到应用目录下'
      console.error(`[AudioPlayer] 错误: ${msg}`)
      // 必须 throw：调用方（过渡音频循环等）依赖异常来打破 while(true)
      throw new Error(msg)
    }

    const wasPaused = this._paused

    return new Promise((resolve, reject) => {
      this.stop()
      this._paused = wasPaused

      const ffplay = spawn(ffplayPath, [
        '-nodisp',
        '-autoexit',
        '-loglevel', 'quiet',
        filePath
      ])

      this.currentProcess = ffplay

      if (this._paused) {
        this.pause()
      }

      ffplay.on('error', (err) => {
        this.currentProcess = null
        reject(err.code === 'ENOENT' ? new Error('ffplay 未找到') : err)
      })

      ffplay.on('close', () => {
        if (this.currentProcess === ffplay) this.currentProcess = null
        resolve()
      })
    })
  }

  async pause() {
    this._paused = true
    if (this.currentProcess) {
      if (process.platform === 'win32') {
        try {
          const ps = (await import('process-suspend')).default
          ps.suspend(this.currentProcess)
        } catch (e) {
          console.error('[AudioPlayer] Windows pause 失败:', e.message)
        }
      } else {
        try {
          process.kill(this.currentProcess.pid, 'SIGSTOP')
        } catch (e) {
          console.error('[AudioPlayer] SIGSTOP 失败:', e.message)
        }
      }
    }
  }

  async resume() {
    this._paused = false
    if (this.currentProcess) {
      if (process.platform === 'win32') {
        try {
          const ps = (await import('process-suspend')).default
          ps.resume(this.currentProcess)
        } catch (e) {
          console.error('[AudioPlayer] Windows resume 失败:', e.message)
        }
      } else {
        try {
          process.kill(this.currentProcess.pid, 'SIGCONT')
        } catch (e) {
          console.error('[AudioPlayer] SIGCONT 失败:', e.message)
        }
      }
    }
  }

  stop() {
    if (this.currentProcess) {
      try {
        this.currentProcess.kill('SIGKILL')
      } catch {}
      this.currentProcess = null
    }
  }

  isPlaying() {
    return this.currentProcess !== null
  }
}
