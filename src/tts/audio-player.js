/**
 * src/tts/audio-player.js
 *
 * 播放器：使用系统/打包的 ffplay 执行音频播放，完全无 Node.js 编译依赖。
 */

import { spawn, execSync } from 'child_process'
import { existsSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'

let _ffplayPath = null
function getFfplayPath() {
  if (_ffplayPath !== null) return _ffplayPath

  // 1. 尝试常见的 macOS 绝对路径（GUI App 不会继承终端 shell 的 PATH 变量）
  if (process.platform === 'darwin') {
    const paths = [
      '/usr/local/bin/ffplay',
      '/opt/homebrew/bin/ffplay'
    ]
    for (const p of paths) {
      if (existsSync(p)) {
        _ffplayPath = p
        return _ffplayPath
      }
    }
  }

  // 2. 尝试使用 which 寻找
  try {
    const path = execSync('which ffplay', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (path) {
      _ffplayPath = path
      return _ffplayPath
    }
  } catch {}

  // 3. 兜底直接执行
  try {
    execSync('ffplay -version', { stdio: 'ignore' })
    _ffplayPath = 'ffplay'
  } catch {
    _ffplayPath = false
  }

  return _ffplayPath
}

function hasFfplay() {
  return getFfplayPath() !== false
}

export class AudioPlayer {
  constructor() {
    this.currentProcess = null
    this._paused        = false
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
    const tempFile = join(DATA_DIR, 'temp-tts-play.mp3')

    try {
      mkdirSync(DATA_DIR, { recursive: true })
      writeFileSync(tempFile, audioBuffer)
    } catch (err) {
      console.error('[AudioPlayer] 写入临时音频文件失败:', err.message)
      return
    }

    return this.playFile(tempFile)
  }

  async playFile(filePath) {
    const ffplayPath = getFfplayPath()
    if (!ffplayPath) {
      console.error('[AudioPlayer] 错误: 系统未检测到 ffplay，无法播放声音，请安装 ffmpeg!')
      return
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
