import { VolcengineTTSClient }   from './volcengine-client.js'
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
    this.client       = new VolcengineTTSClient(config)
    this.wsClient     = new VolcengineTTSWSClient(config)
    this.player       = new AudioPlayer(config)
    this.activeWSCall = null

    this.enabled = !!(
      (config.TTS_APP_ID       || process.env.TTS_APP_ID) &&
      (config.TTS_ACCESS_TOKEN || process.env.TTS_ACCESS_TOKEN)
    )
  }

  async speak(text) {
    if (!text) return
    const cleanedText = filterTtsText(text)
    if (!cleanedText) return

    if (!this.enabled) {
      console.log(`[TTS] 测试模式 — 播报内容: "${cleanedText}"`)
      return
    }

    this.stop()

    try {
      await new Promise((resolve, reject) => {
        const cleanUp = () => {
          if (this.activeReject === safeReject) {
            this.activeReject = null
          }
        }

        const safeResolve = (val) => {
          cleanUp()
          resolve(val)
        }

        const safeReject = (err) => {
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
          const capturedChunks = []

          const startPlayback = () => {
            if (isStarted) return
            isStarted = true

            stream = this.player.startStream()
            if (!stream) {
              safeReject(new Error('无法启动音频播放流'))
              return
            }

            // Write all buffered chunks at once
            for (const chunk of bufferedChunks) {
              stream.write(chunk)
            }
            bufferedChunks = []
          }

          this.activeWSCall = this.wsClient.synthesizeStream(
            cleanedText,
            (chunk) => {
              capturedChunks.push(chunk)
              if (!isStarted) {
                bufferedChunks.push(chunk)
                totalBufferedSize += chunk.length
                if (totalBufferedSize >= PRE_BUFFER_THRESHOLD) {
                  startPlayback()
                }
              } else {
                stream.write(chunk)
              }
            },
            () => {
              this.activeWSCall = null
              // If download completed before reaching threshold, start playing now
              if (!isStarted) {
                startPlayback()
              }
              if (stream) {
                stream.end()
                stream.promise.then((val) => {
                  saveHarvestedAudio(cleanedText, capturedChunks)
                  safeResolve(val)
                }).catch(safeReject)
              } else {
                safeResolve()
              }
            },
            (err) => {
              this.activeWSCall = null
              if (stream) {
                stream.end()
              }
              safeReject(err)
            }
          )
        } catch (err) {
          safeReject(err)
        }
      })
      return { ok: true }
    } catch (err) {
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
