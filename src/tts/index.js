import { VolcengineTTSWSClient } from './volcengine-ws-client.js'
import { AudioPlayer }           from './audio-player.js'
import fs                        from 'fs'
import path                      from 'path'
import crypto                    from 'crypto'
import * as uiBridge             from '../ui-bridge.js'

export function filterTtsText(text) {
  if (!text) return ''
  return text
    // Only allow Chinese, English, numbers, standard spaces, and standard punctuation/math symbols
    .replace(/[^\u4e00-\u9fa5a-zA-Z0-9\s，。！？、；：（）“”《》——~～‘’…\-_\/.?!,:;'"()\[\]\\*=+@#%&]/g, '')
    // Normalize whitespace
    .replace(/\s+/g, ' ')
    .trim()
}

export class TTSEngine {
  constructor(config = {}) {
    this.wsClient     = new VolcengineTTSWSClient(config)
    this.player       = new AudioPlayer({ outputRouter: config.audioOutput })
    this.activeWSCall = null

    this.enabled = this.wsClient.isConfigured()
    console.log('[TTS] 使用火山引擎 V3 单向流式接口')
  }

  /**
   * Synthesize filtered text through the V3 streaming API and return one MP3 buffer.
   * This is used by callers that manage playback themselves (for example, transit
   * audio that synthesizes once and then loops the same audio).
   */
  async synthesizeBuffer(text) {
    const cleanedText = filterTtsText(text)
    if (!cleanedText) {
      throw new Error('TTS 合成文本为空')
    }
    if (!this.enabled) {
      throw new Error('TTS 未配置，无法合成音频')
    }

    this.stop()

    return new Promise((resolve, reject) => {
      let settled = false
      const chunks = []

      const cleanUp = () => {
        if (this.activeReject === safeReject) {
          this.activeReject = null
        }
      }
      const safeResolve = (value) => {
        if (settled) return
        settled = true
        cleanUp()
        resolve(value)
      }
      const safeReject = (err) => {
        if (settled) return
        settled = true
        cleanUp()
        reject(err)
      }

      this.activeReject = safeReject

      try {
        const call = this.wsClient.synthesizeStream(
          cleanedText,
          (chunk) => {
            if (!settled) chunks.push(Buffer.from(chunk))
          },
          () => {
            this.activeWSCall = null
            safeResolve(Buffer.concat(chunks))
          },
          (err) => {
            this.activeWSCall = null
            safeReject(err)
          },
        )
        if (!settled) this.activeWSCall = call
      } catch (err) {
        this.activeWSCall = null
        safeReject(err)
      }
    })
  }

  /**
   * Speak text using streaming TTS (WS → ffplay).
   * @param {string} text
   * @param {object} [opts]
   * @param {() => boolean} [opts.beforePlay] - Sync predicate called RIGHT BEFORE
   *   audio playback starts (ffplay about to spawn). If it returns false, playback
   *   is aborted silently: WS call is cancelled, ffplay never spawns, cruising audio
   *   is never paused. Resolves with { ok: false, aborted: true }.
   * @param {() => void} [opts.onAudioStart] - Fires at the exact moment ffplay is
   *   spawned to consume audio. Use this to pause other audio at the handoff point.
   */
  async speak(text, opts = {}) {
    if (!text) return
    const cleanedText = filterTtsText(text)
    if (!cleanedText) return

    if (!this.enabled) {
      console.log(`[TTS] 测试模式 — 播报内容: "${cleanedText}"`)
      return
    }

    this.stop()

    let aborted = false
    try {
      await new Promise((resolve, reject) => {
        let settled = false
        const cleanUp = () => {
          if (this.activeReject === safeReject) {
            this.activeReject = null
          }
        }

        const safeResolve = (val) => {
          if (settled) return
          settled = true
          cleanUp()
          resolve(val)
        }

        const safeReject = (err) => {
          if (settled) return
          settled = true
          cleanUp()
          reject(err)
        }

        this.activeReject = safeReject

        try {
          let stream = null
          let bufferedChunks = []
          let totalBufferedSize = 0
          const PRE_BUFFER_THRESHOLD = 4096 // 4KB (approx 0.25 seconds of audio, starts playing almost instantly)
          let isStarted = false
          let terminal = false
          const capturedChunks = []

          const abortActiveCall = () => {
            const call = this.activeWSCall
            this.activeWSCall = null
            if (call) {
              try { call.abort() } catch {}
            }
          }

          const failPlayback = (err) => {
            if (terminal) return
            terminal = true
            isStarted = true
            bufferedChunks = []
            abortActiveCall()
            try { this.player.stop() } catch {}
            safeReject(err)
          }

          const startPlayback = () => {
            if (isStarted || terminal) return

            // Gate: if beforePlay returns false (e.g. host is still speaking at the
            // moment of play), abort silently without spawning ffplay or pausing cruising.
            if (opts.beforePlay && !opts.beforePlay()) {
              isStarted = true            // block any later startPlayback attempt
              terminal = true
              aborted = true
              bufferedChunks = []
              abortActiveCall()
              safeResolve()
              return
            }

            try {
              stream = this.player.startStream()
            } catch (err) {
              failPlayback(err)
              return
            }
            if (!stream) {
              failPlayback(new Error('无法启动音频播放流'))
              return
            }
            isStarted = true

            // Fire "audio really starts now" hook — used by barrage to pause
            // cruising at the exact handoff moment (seamless transition).
            try { opts.onAudioStart?.() } catch (e) {
              console.error('[TTS] onAudioStart hook threw:', e.message)
            }

            // Write all buffered chunks at once
            try {
              for (const chunk of bufferedChunks) {
                stream.write(chunk)
              }
            } catch (err) {
              failPlayback(err)
              return
            }
            bufferedChunks = []
          }

          const call = this.wsClient.synthesizeStream(
            cleanedText,
            (chunk) => {
              if (terminal) return
              capturedChunks.push(Buffer.from(chunk))
              if (!isStarted) {
                bufferedChunks.push(chunk)
                totalBufferedSize += chunk.length
                if (totalBufferedSize >= PRE_BUFFER_THRESHOLD) {
                  startPlayback()
                }
              } else if (stream) {
                try {
                  stream.write(chunk)
                } catch (err) {
                  failPlayback(err)
                }
              }
            },
            () => {
              this.activeWSCall = null
              if (terminal) return
              // If download completed before reaching threshold, start playing now
              if (!isStarted) {
                startPlayback()
              }
              if (terminal) return
              if (stream) {
                try {
                  stream.end()
                } catch (err) {
                  failPlayback(err)
                  return
                }
                stream.promise.then((val) => {
                  if (terminal) return
                  terminal = true
                  saveHarvestedAudio(cleanedText, capturedChunks)
                  safeResolve(val)
                }).catch(failPlayback)
              } else {
                terminal = true
                safeResolve()
              }
            },
            (err) => {
              this.activeWSCall = null
              if (terminal) return
              terminal = true
              if (stream) {
                try { stream.end() } catch {}
              }
              safeReject(err)
            }
          )
          if (terminal) {
            try { call?.abort() } catch {}
          } else {
            this.activeWSCall = call
          }
        } catch (err) {
          safeReject(err)
        }
      })
      if (aborted) return { ok: false, aborted: true }
      return { ok: true }
    } catch (err) {
      if (aborted) return { ok: false, aborted: true }
      console.error('[TTS] 播报播放失败:', err.message)
      return { ok: false, error: err }
    }
  }

  async speakFile(filePath) {
    if (!filePath) return
    this.stop()
    try {
      await this.player.playFile(filePath)
    } catch (err) {
      console.error('[TTS] 播放文件出错:', err.message)
    }
  }

  stop() {
    if (this.activeWSCall) {
      try {
        this.activeWSCall.abort()
      } catch {}
      this.activeWSCall = null
    }
    this.player.stop()
    if (this.activeReject) {
      this.activeReject(new Error('TTS playback stopped'))
      this.activeReject = null
    }
  }

  destroy() {
    this.stop()
  }
}

function saveHarvestedAudio(text, chunks) {
  try {
    const hash = crypto.createHash('md5').update(text).digest('hex')
    const USER_DATA = process.env.USER_DATA_DIR
    const DATA_DIR = USER_DATA ? path.join(USER_DATA, 'data') : './data'
    const cacheDir = path.join(DATA_DIR, 'tts-cache')
    
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true })
    }
    
    const mp3Path = path.join(cacheDir, `${hash}.mp3`)
    const txtPath = path.join(cacheDir, `${hash}.txt`)
    
    const fullBuffer = Buffer.concat(chunks)
    fs.writeFileSync(mp3Path, fullBuffer)
    fs.writeFileSync(txtPath, text, 'utf8')
    console.log(`[TTS Harvester] Saved: ${hash} ("${text.slice(0, 15)}...")`)
    
    // Broadcast event to UI
    uiBridge.broadcast('TTS_HARVESTED', { hash })
  } catch (err) {
    console.error('[TTS Harvester] Failed to save harvested audio:', err.message)
  }
}
