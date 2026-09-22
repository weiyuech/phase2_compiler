/**
 * src/transit/manager.js
 *
 * 过渡音频管理器：机器人行进期间循环播放背景音频。
 * 支持 TTS 文字（先 LLM 改写一次，合成后缓存循环）或共享音频素材池。
 * 播放交接时由巡游控制器调用 stop()；不在此处决定点位或音频优先级。
 */

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { resolve }                                 from 'node:path'
import { AudioPlayer }                              from '../tts/audio-player.js'

const DEFAULT_CONFIG = {
  enabled:  false,
  type:     'tts',
  text:     '',
  mp3_file: '',
  mp3_files: [],
  mp3_mode: 'repeat',
}

function audioPath(value) {
  if (typeof value !== 'string') return ''
  const file = value.trim()
  return file && !file.includes('\0') && /\.(mp3|wav|ogg|m4a)$/i.test(file) ? file : ''
}

/**
 * mp3_files is the authoritative shared pool when present (including []).
 * Legacy mp3_file-only settings migrate to a singleton pool. mp3_file remains
 * the selected repeat track, while mp3_mode defaults to legacy single repeat.
 * Missing files remain in settings; availability is checked before playback.
 */
export function normalizeTransitConfig(value = {}) {
  const config = value && typeof value === 'object' ? value : {}
  const legacy = audioPath(config.mp3_file)
  const candidates = Array.isArray(config.mp3_files) ? config.mp3_files : [legacy]
  const seen = new Set()
  const files = []
  for (const candidate of candidates) {
    const file = audioPath(candidate)
    if (!file) continue
    const absolute = resolve(file)
    const key = process.platform === 'win32' ? absolute.toLowerCase() : absolute
    if (seen.has(key)) continue
    seen.add(key)
    files.push(file)
  }
  return {
    enabled: config.enabled === true,
    type: config.type === 'mp3' ? 'mp3' : 'tts',
    text: typeof config.text === 'string' ? config.text : '',
    mp3_file: files.includes(legacy) ? legacy : (files[0] || ''),
    mp3_files: files,
    mp3_mode: config.mp3_mode === 'shuffle' ? 'shuffle' : 'repeat',
  }
}

export class TransitAudioManager {
  constructor({ filePath, audioOutput = null, player = null, tts = null, random = Math.random, now = Date.now, onError = () => {} }) {
    this._onError = onError
    this._filePath = filePath
    this._tts = tts
    this._player   = player || tts?.player || new AudioPlayer({ outputRouter: audioOutput })
    this._random   = random
    this._now      = now
    this._runId    = null   // unique object per run; null = stopped
    this._config   = this._load()
  }

  _reportError(message) {
    console.error('[过渡音频]', message)
    this._onError(`过渡音频失败: ${message}`)
  }

  _load() {
    if (this._filePath && existsSync(this._filePath)) {
      try {
        return normalizeTransitConfig(JSON.parse(readFileSync(this._filePath, 'utf8')))
      } catch { /* fall through */ }
    }
    return normalizeTransitConfig(DEFAULT_CONFIG)
  }

  saveConfig(config) {
    const normalized = normalizeTransitConfig(config)
    if (this._filePath) writeFileSync(this._filePath, JSON.stringify(normalized, null, 2))
    this._config = normalized
  }

  getConfig() {
    return { ...this._config, mp3_files: [...this._config.mp3_files] }
  }

  /**
   * 开始循环播放过渡音频（非阻塞，后台运行）。
   * @param {TTSEngine}   tts - 用于合成 TTS
   * @param {LLMRewriter} llm - 用于改写文字
   */
  async start(tts, llm) {
    const cfg = normalizeTransitConfig(this._config)

    // Every explicit start applies the latest config, including disabling it.
    this.stop()
    if (!cfg.enabled) return

    // 分配新的运行 ID，防止旧循环在异步挂起后"复活"
    const runId = { controller: new AbortController(), type: cfg.type, finishSentence: false }
    this._runId = runId

    if (cfg.type === 'mp3') {
      this._loopMp3(cfg, runId)
    } else {
      const text = cfg.text?.trim()
      if (!text) { this._runId = null; this._reportError('请输入过渡播报文字并保存'); return }
      if (!tts.enabled) {
        this._reportError('TTS 未配置，请在“系统设置 → 过渡音频与手动播报”填写语音凭据和音色，再保存并重启后端')
        this._runId = null
        return
      }
      runId.finished = this._loopTts(text, tts, llm, runId)
    }
  }

  _isPlayableFile(filePath) {
    try { return statSync(filePath).isFile() } catch { return false }
  }

  _nextMp3(state) {
    const available = state.files.filter(file => {
      if (state.failed.has(file)) return false
      if (this._isPlayableFile(file)) return true
      state.failed.add(file)
      console.warn(`[过渡音频] 音频路径不存在或不是文件，本次循环跳过: ${file}`)
      return false
    })
    if (!available.length) return null
    if (state.mode === 'repeat') return available[0]

    state.bag = state.bag.filter(file => available.includes(file))
    if (!state.bag.length) {
      state.bag = [...available]
      for (let i = state.bag.length - 1; i > 0; i--) {
        const j = Math.floor(this._random() * (i + 1))
        ;[state.bag[i], state.bag[j]] = [state.bag[j], state.bag[i]]
      }
      // The next track is popped from the end. Avoid repeats across bag cycles.
      const end = state.bag.length - 1
      if (end > 0 && state.bag[end] === state.last) {
        ;[state.bag[0], state.bag[end]] = [state.bag[end], state.bag[0]]
      }
    }
    return state.bag.pop()
  }

  async _loopMp3(cfg, runId) {
    // 兜底防呆：如果 playFile 异常快速返回（例如 ffplay 找不到但没抛错，或 mp3 秒崩），
    // 同一素材连续 MAX_FAST_ITERS 次快速返回后跳过，全部不可用时终止循环
    // 阈值取 800ms：合法的过渡音频（通常几秒到几十秒）远大于此；ffplay 冷启动 + 失败退出
    // 在 Windows 上约 100-500ms，因此坏文件会被稳定判定为"异常快速返回"
    const MIN_ITER_MS = 800
    const MAX_FAST_ITERS = 5
    const state = {
      files: [cfg.mp3_file, ...cfg.mp3_files.filter(file => file !== cfg.mp3_file)].filter(Boolean),
      mode: cfg.mp3_mode,
      bag: [],
      last: null,
      failed: new Set(),
      fastCounts: new Map(),
    }

    while (this._runId === runId) {
      const filePath = this._nextMp3(state)
      if (!filePath) {
        this._reportError('没有可播放的音频，请检查素材池文件是否存在且可播放')
        break
      }
      const start = this._now()
      try {
        if (this._tts) {
          const result = await this._tts.speakFile(filePath, { signal: runId.controller.signal })
          if (result?.aborted) break
          if (result?.ok === false) throw result.error || new Error('过渡音频播放失败')
        } else await this._player.playFile(filePath)
      } catch (err) {
        if (this._runId === runId) this._reportError(`音频播放出错: ${err.message}`)
        state.failed.add(filePath)
        continue
      }
      if (this._runId !== runId) break
      state.last = filePath

      if (this._now() - start < MIN_ITER_MS) {
        const fastCount = (state.fastCounts.get(filePath) || 0) + 1
        state.fastCounts.set(filePath, fastCount)
        if (fastCount >= MAX_FAST_ITERS) {
          console.error(`[过渡音频] 音频连续 ${MAX_FAST_ITERS} 次异常快速返回，本次循环跳过：${filePath}`)
          state.failed.add(filePath)
          continue
        }
        // 快速返回时主动让出事件循环，防止在真的坏了的情况下 CPU 被打满
        await new Promise(r => setTimeout(r, 500))
      } else {
        state.fastCounts.set(filePath, 0)
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
    if (runId.finishSentence) { this._runId = null; return }

    if (this._tts?.prepareText) {
      return this._loopPreparedTts(playText, runId)
    }

    // 合成一次，缓存 buffer
    let buffer
    try {
      buffer = await tts.synthesizeBuffer(playText)
    } catch (err) {
      if (this._runId === runId) this._reportError(`TTS 合成出错: ${err.message}`)
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
      const start = this._now()
      try {
        await this._player.play(buffer)
      } catch (err) {
        if (this._runId === runId) this._reportError(`播放出错: ${err.message}`)
        break
      }
      if (this._runId !== runId) break

      if (this._now() - start < MIN_ITER_MS) {
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

  async _loopPreparedTts(text, runId) {
    let source
    try {
      source = await this._tts.prepareText(text, { signal: runId.controller.signal })
      let fastCount = 0
      while (this._runId === runId) {
        const started = this._now()
        const result = await this._tts.speakPreparedText(source, {
          signal: runId.controller.signal, harvest: false,
          shouldFinish: () => runId.finishSentence,
        })
        if (runId.finishSentence) break
        if (this._runId !== runId || result?.aborted) break
        if (result?.ok === false) throw result.error || new Error('过渡 TTS 播放失败')
        if (this._now() - started < 800) {
          if (++fastCount >= 5) throw new Error('过渡 TTS 连续异常快速返回')
          await new Promise(resolve => setTimeout(resolve, 500))
        } else fastCount = 0
      }
    } catch (err) {
      if (this._runId === runId) this._reportError(`准备/播放失败: ${err.message}`)
    } finally {
      source?.release()
      if (this._runId === runId) this._runId = null
    }
  }

  finishCurrentSentence() {
    const run = this._runId
    if (!run || run.type !== 'tts' || !this._tts?.prepareText) return Promise.resolve()
    run.finishSentence = true
    return run.finished || Promise.resolve()
  }

  stop() {
    this._runId?.controller?.abort()
    this._runId = null
    if (this._tts) this._tts.stop()
    else this._player.stop()
  }

  pause() {
    if (this._tts?.coordinator) return this._tts.coordinator.setPauseReason('transit-owner', ['transit'], true)
    return this._player.pause()
  }

  resume() {
    if (this._tts?.coordinator) return this._tts.coordinator.setPauseReason('transit-owner', [], false)
    return this._player.resume()
  }

  isRunning() {
    return this._runId !== null
  }
}
