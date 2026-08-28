/**
 * Compatibility client for classic V1 voices such as BV001_streaming.
 * Long-form narration uses the V3 client; this remains available for short
 * barrage replies whose legacy voice is not accepted by a V3 resource ID.
 */

import WebSocket from 'ws'
import crypto from 'crypto'

const DEFAULT_V1_URL = 'wss://openspeech.bytedance.com/api/v1/tts/ws_binary'

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function parseV1Frame(input) {
  const data = Buffer.isBuffer(input) ? input : Buffer.from(input)
  if (data.length < 8) throw new Error('TTS V1 响应帧过短')

  const messageType = data[1] >> 4
  const flags = data[1] & 0x0f

  if (messageType === 0x0f) {
    if (data.length < 12) throw new Error('TTS V1 错误帧不完整')
    const code = data.readUInt32BE(4)
    const payloadLength = data.readUInt32BE(8)
    const payload = data.subarray(12, 12 + payloadLength)
    let detail = payload.toString('utf8')
    try {
      const json = JSON.parse(detail)
      detail = json.message || detail
    } catch {}
    return { error: new Error(`TTS V1 Error ${code}: ${detail}`) }
  }

  if (messageType !== 0x0b) return { ignored: true }

  let offset = 4
  let sequence = null
  if (flags === 0x01 || flags === 0x02 || flags === 0x03) {
    if (data.length < offset + 4) throw new Error('TTS V1 音频序号缺失')
    sequence = data.readInt32BE(offset)
    offset += 4
  }
  if (data.length < offset + 4) throw new Error('TTS V1 音频长度缺失')
  const payloadLength = data.readUInt32BE(offset)
  offset += 4
  if (payloadLength > data.length - offset) throw new Error('TTS V1 音频长度无效')

  return {
    audio: data.subarray(offset, offset + payloadLength),
    finished: sequence != null ? sequence < 0 : flags === 0x02 || flags === 0x03,
  }
}

export class VolcengineTTSV1WSClient {
  constructor(config = {}) {
    this.apiKey = config.TTS_ACCESS_TOKEN || process.env.TTS_ACCESS_TOKEN || ''
    this.appId = config.TTS_APP_ID || process.env.TTS_APP_ID || ''
    this.voiceType = config.TTS_VOICE_TYPE || process.env.TTS_VOICE_TYPE || 'BV001_streaming'
    this.cluster = config.TTS_CLUSTER || process.env.TTS_CLUSTER || 'volcano_tts'
    this.speedRatio = Number.parseFloat(config.TTS_SPEED || process.env.TTS_SPEED || '1.0')
    this.volumeRatio = Number.parseFloat(config.TTS_VOLUME || process.env.TTS_VOLUME || '1.0')
    this.timeoutMs = parsePositiveInt(config.TTS_TIMEOUT_MS || process.env.TTS_TIMEOUT_MS, 30000)
    this.url = config.TTS_V1_WS_URL || process.env.TTS_V1_WS_URL || DEFAULT_V1_URL
  }

  isConfigured() {
    return !!(this.apiKey && this.appId)
  }

  synthesizeStream(text, onAudioChunk, onFinished, onError) {
    if (!this.isConfigured() && !this.url.startsWith('ws://localhost') && !this.url.startsWith('ws://127.0.0.1')) {
      onError(new Error('火山引擎 V1 TTS 未配置 TTS_APP_ID + TTS_ACCESS_TOKEN'))
      return { abort: () => {} }
    }

    const ws = new WebSocket(this.url, {
      headers: { 'x-api-key': this.apiKey },
    })
    const reqId = crypto.randomUUID()
    let settled = false

    const settle = (fn) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }

    const timer = setTimeout(() => {
      settle(() => onError(new Error(`TTS V1 合成超时（${this.timeoutMs}ms）`)))
      try { ws.terminate() } catch {}
    }, this.timeoutMs)

    ws.on('open', () => {
      const payloadBuffer = Buffer.from(JSON.stringify({
        app: { appid: this.appId, cluster: this.cluster },
        user: { uid: 'robot_live_system' },
        audio: {
          voice_type: this.voiceType,
          encoding: 'mp3',
          speed_ratio: this.speedRatio,
          volume_ratio: this.volumeRatio,
          pitch_ratio: 1.0,
        },
        request: { reqid: reqId, text, operation: 'submit' },
      }), 'utf8')

      const frame = Buffer.alloc(8 + payloadBuffer.length)
      frame.set([0x11, 0x10, 0x10, 0x00], 0)
      frame.writeUInt32BE(payloadBuffer.length, 4)
      payloadBuffer.copy(frame, 8)
      ws.send(frame)
    })

    ws.on('message', (data) => {
      let frame
      try {
        frame = parseV1Frame(data)
      } catch (err) {
        settle(() => onError(err))
        try { ws.close() } catch {}
        return
      }

      if (frame.error) {
        settle(() => onError(frame.error))
        try { ws.close() } catch {}
        return
      }
      if (frame.audio?.length) onAudioChunk(frame.audio)
      if (frame.finished) {
        settle(() => onFinished())
        try { ws.close() } catch {}
      }
    })

    ws.on('error', err => settle(() => onError(err)))
    ws.on('close', code => {
      settle(() => onError(new Error(`TTS V1 连接已关闭但合成未完成 (code ${code})`)))
    })

    return {
      abort: () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try { ws.terminate() } catch {}
      },
    }
  }
}
