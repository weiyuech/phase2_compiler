/**
 * src/transit/manager.js
 *
 * 过渡音频管理器：机器人行进期间循环播放背景音频。
 * 支持 TTS 文字（先 LLM 改写一次，合成后缓存循环）或 MP3 文件（循环播放）。
 * 到达下一个点位时调用 stop() 立即终止。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { AudioPlayer }                              from '../tts/audio-player.js'

const DEFAULT_CONFIG = {
  enabled:  false,
  type:     'tts',
  text:     '',
  mp3_file: '',
}

export class TransitAudioManager {
  constructor({ filePath, audioOutput = null }) {
    this._filePath = filePath
    this._player   = new AudioPlayer({ outputRouter: audioOutput })
    this._runId    = null   // unique object per run; null = stopped
    this._config   = this._load()
  }

  _load() {
    if (existsSync(this._filePath)) {
      try {
        return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(this._filePath, 'utf8')) }
      } catch { /* fall through */ }
    }
    return { ...DEFAULT_CONFIG }
  }

  saveConfig(config) {
    this._config = { ...DEFAULT_CONFIG, ...config }
    writeFileSync(this._filePath, JSON.stringify(this._config, null, 2))
  }

  getConfig() {
    return this._config
  }

  /**
   * 开始循环播放过渡音频（非阻塞，后台运行）。
   * @param {TTSEngine}   tts - 用于合成 TTS
   * @param {LLMRewriter} llm - 用于改写文字
   */
  async start(tts, llm) {
    const cfg = this._config
    if (!cfg.enabled) return

    // 停止旧循环，分配新的运行 ID（唯一对象引用，防止旧循环在异步挂起后"复活"）
    this.stop()
    const runId = {}
    this._runId = runId

    if (cfg.type === 'mp3') {
      if (!cfg.mp3_file) { this._runId = null; return }
      if (!existsSync(cfg.mp3_file)) {
        console.error(`[过渡音频] MP3 文件不存在，跳过循环: ${cfg.mp3_file}`)
        this._runId = null
        return
      }
      this._loopMp3(cfg.mp3_file, runId)
    } else {
      const text = cfg.text?.trim()
      if (!text) { this._runId = null; return }
      if (!tts.enabled) {
        console.log('[过渡音频] TTS 未启用，跳过')
        this._runId = null
        return
      }
      this._loopTts(text, tts, llm, runId)
    }
  }

  async _loopMp3(filePath, runId) {
    // 兜底防呆：如果 playFile 异常快速返回（例如 ffplay 找不到但没抛错，或 mp3 秒崩），
    // 连续 MAX_FAST_ITERS 次快速返回后终止循环，防止 tight loop 榨干 CPU
    // 阈值取 800ms：合法的过渡音频（通常几秒到几十秒）远大于此；ffplay 冷启动 + 失败退出
    // 在 Windows 上约 100-500ms，因此坏文件会被稳定判定为"异常快速返回"
    const MIN_ITER_MS = 800
    const MAX_FAST_ITERS = 5
    let fastCount = 0

    while (this._runId === runId) {
      const start = Date.now()
      try {
        await this._player.playFile(filePath)
      } catch (err) {
        if (this._runId === runId) console.error('[过渡音频] MP3 播放出错:', err.message)
        break
      }
      if (this._runId !== runId) break

      if (Date.now() - start < MIN_ITER_MS) {
        if (++fastCount >= MAX_FAST_ITERS) {
          console.error(`[过渡音频] MP3 循环连续 ${MAX_FAST_ITERS} 次异常快速返回（可能文件损坏或 ffplay 异常），已终止以防 CPU 占满：${filePath}`)
          break
        }
        // 快速返回时主动让出事件循环，防止在真的坏了的情况下 CPU 被打满
        await new Promise(r => setTimeout(r, 500))
      } else {
        fastCount = 0
      }
    }
    if (this._runId === runId) this._runId = null
  }

  async _loopTts(text, tts, llm, runId) {
    // 改写一次
    let playText = text
    try {
      const result = await llm.rewrite({ body: text })
      playText = result.text
      console.log(`[过渡音频] LLM 改写完成: "${playText.slice(0, 40)}..."`)
    } catch (err) {
      console.warn('[过渡音频] LLM 改写失败，使用原文:', err.message)
    }

    if (this._runId !== runId) return  // 在 LLM 期间被 stop() 或新的 start() 打断

    // 合成一次，缓存 buffer
    let buffer
    try {
      buffer = await tts.client.synthesise(playText)
    } catch (err) {
      console.error('[过渡音频] TTS 合成出错:', err.message)
      if (this._runId === runId) this._runId = null
      return
    }

    if (this._runId !== runId) return  // 在合成期间被 stop() 或新的 start() 打断

    // 循环播放缓存 buffer
    // 兜底防呆：与 _loopMp3 同款保护，防止 play 异常快速返回时形成 tight loop
    // 阈值取 800ms：合法的过渡音频（通常几秒到几十秒）远大于此；ffplay 冷启动 + 失败退出
    // 在 Windows 上约 100-500ms，因此坏文件会被稳定判定为"异常快速返回"
    const MIN_ITER_MS = 800
    const MAX_FAST_ITERS = 5
    let fastCount = 0

    while (this._runId === runId) {
      const start = Date.now()
      try {
        await this._player.play(buffer)
      } catch (err) {
        if (this._runId === runId) console.error('[过渡音频] 播放出错:', err.message)
        break
      }
      if (this._runId !== runId) break

      if (Date.now() - start < MIN_ITER_MS) {
        if (++fastCount >= MAX_FAST_ITERS) {
          console.error(`[过渡音频] TTS 循环连续 ${MAX_FAST_ITERS} 次异常快速返回（可能 ffplay 异常），已终止以防 CPU 占满`)
          break
        }
        await new Promise(r => setTimeout(r, 500))
      } else {
        fastCount = 0
      }
    }
    if (this._runId === runId) this._runId = null
  }

  stop() {
    this._runId = null
    this._player.stop()
  }

  pause() {
    return this._player.pause()
  }

  resume() {
    return this._player.resume()
  }

  isRunning() {
    return this._runId !== null
  }
}
