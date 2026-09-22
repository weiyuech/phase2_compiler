/**
 * 火山引擎语音合成 WebSocket V3 单向流式客户端。
 *
 * 客户端一次性提交完整文本，服务端以 V3 event 帧持续返回 MP3 音频。
 * 官方接口：wss://openspeech.bytedance.com/api/v3/tts/unidirectional/stream
 */

import WebSocket from 'ws'
import crypto from 'crypto'
import { gunzipSync } from 'zlib'

const DEFAULT_V3_URL = 'wss://openspeech.bytedance.com/api/v3/tts/unidirectional/stream'

export const V3_EVENTS = Object.freeze({
  FINISH_CONNECTION:   2,
  CONNECTION_FINISHED: 52,
  SESSION_FINISHED:    152,
  SENTENCE_START:      350,
  SENTENCE_END:        351,
  TTS_RESPONSE:        352,
})

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function ratioToV3Rate(value) {
  const ratio = Number.parseFloat(value)
  if (!Number.isFinite(ratio)) return 0
  return Math.max(-50, Math.min(100, Math.round((ratio - 1) * 100)))
}

export function inferV3ResourceId(cluster = '') {
  return String(cluster).toLowerCase().includes('icl') ? 'seed-icl-1.0' : 'seed-tts-1.0'
}

export function buildV3TextFrame(payload) {
  const payloadBuffer = Buffer.from(JSON.stringify(payload), 'utf8')
  const header = Buffer.from([
    0x11, // binary framing version 1, 4-byte header
    0x10, // full-client request, no event number
    0x10, // JSON, no compression
    0x00,
  ])
  const payloadLength = Buffer.alloc(4)
  payloadLength.writeUInt32BE(payloadBuffer.length)
  return Buffer.concat([header, payloadLength, payloadBuffer])
}

export function buildV3FinishConnectionFrame() {
  const payload = Buffer.from('{}', 'utf8')
  const frame = Buffer.alloc(12 + payload.length)
  frame.set([0x11, 0x14, 0x10, 0x00], 0)
  frame.writeInt32BE(V3_EVENTS.FINISH_CONNECTION, 4)
  frame.writeUInt32BE(payload.length, 8)
  payload.copy(frame, 12)
  return frame
}

function decodePayload(payload, compression) {
  if (compression === 0x01 && payload.length > 0) return gunzipSync(payload)
  return payload
}

function parseJsonPayload(payload) {
  if (!payload.length) return null
  try {
    return JSON.parse(payload.toString('utf8'))
  } catch {
    return null
  }
}

/**
 * Decode a V3 server frame. V3 event responses contain:
 * header -> event -> session/connection id -> payload length -> payload.
 */
export function parseV3Frame(input) {
  const data = Buffer.isBuffer(input) ? input : Buffer.from(input)
  if (data.length < 4) throw new Error('TTS V3 响应帧过短')

  const headerSize = (data[0] & 0x0f) * 4
  const messageType = data[1] >> 4
  const flags = data[1] & 0x0f
  const serialization = data[2] >> 4
  const compression = data[2] & 0x0f

  if (headerSize < 4 || data.length < headerSize) {
    throw new Error('TTS V3 响应帧头无效')
  }

  let offset = headerSize
  let event = null
  let id = ''
  let errorCode = null

  if (messageType === 0x0f) {
    if (data.length < offset + 8) throw new Error('TTS V3 错误帧不完整')
    errorCode = data.readUInt32BE(offset)
    offset += 4
    const payloadLength = data.readUInt32BE(offset)
    offset += 4
    if (payloadLength > data.length - offset) throw new Error('TTS V3 错误帧长度无效')
    const payload = decodePayload(data.subarray(offset, offset + payloadLength), compression)
    return {
      messageType, flags, serialization, compression,
      event, id, errorCode, payload,
      json: parseJsonPayload(payload),
      text: payload.toString('utf8'),
    }
  }

  if (flags & 0x04) {
    if (data.length < offset + 4) throw new Error('TTS V3 event 帧不完整')
    event = data.readInt32BE(offset)
    offset += 4

    // All documented V3 downlink event frames carry a session/connection ID.
    if (data.length < offset + 4) throw new Error('TTS V3 event ID 缺失')
    const idLength = data.readUInt32BE(offset)
    offset += 4
    if (idLength > data.length - offset) throw new Error('TTS V3 event ID 长度无效')
    id = data.subarray(offset, offset + idLength).toString('utf8')
    offset += idLength
  }

  if (data.length < offset + 4) throw new Error('TTS V3 payload 长度缺失')
  const payloadLength = data.readUInt32BE(offset)
  offset += 4
  if (payloadLength > data.length - offset) throw new Error('TTS V3 payload 长度无效')
  const payload = decodePayload(data.subarray(offset, offset + payloadLength), compression)
  const isAudio = messageType === 0x0b || event === V3_EVENTS.TTS_RESPONSE

  return {
    messageType, flags, serialization, compression,
    event, id, errorCode, payload,
    json: isAudio ? null : parseJsonPayload(payload),
    text: isAudio ? '' : payload.toString('utf8'),
  }
}

export class VolcengineTTSWSClient {
  constructor(config = {}) {
    this.apiKey = (config.TTS_API_KEY ?? process.env.TTS_API_KEY) || ''
    this.appId = (config.TTS_APP_ID ?? process.env.TTS_APP_ID) || ''
    this.accessKey = (config.TTS_ACCESS_TOKEN ?? process.env.TTS_ACCESS_TOKEN) || ''
    this.authMode = (config.TTS_AUTH_MODE ?? process.env.TTS_AUTH_MODE) || 'api-key'
    this.voiceType = (config.TTS_VOICE_TYPE ?? process.env.TTS_VOICE_TYPE) || ''
    this.cluster = (config.TTS_CLUSTER ?? process.env.TTS_CLUSTER) || 'volcano_tts'
    this.resourceId = (config.TTS_RESOURCE_ID ?? process.env.TTS_RESOURCE_ID) || inferV3ResourceId(this.cluster)
    this.speedRatio = Number.parseFloat((config.TTS_SPEED ?? process.env.TTS_SPEED) || '1.0')
    this.volumeRatio = Number.parseFloat((config.TTS_VOLUME ?? process.env.TTS_VOLUME) || '1.0')
    this.sampleRate = parsePositiveInt((config.TTS_SAMPLE_RATE ?? process.env.TTS_SAMPLE_RATE), 24000)
    this.baseTimeoutMs = parsePositiveInt((config.TTS_TIMEOUT_MS ?? process.env.TTS_TIMEOUT_MS), 30000)
    this.maxTimeoutMs = parsePositiveInt((config.TTS_MAX_TIMEOUT_MS ?? process.env.TTS_MAX_TIMEOUT_MS), 600000)
    this.url = (config.TTS_WS_URL ?? process.env.TTS_WS_URL) || DEFAULT_V3_URL
  }

  isConfigured() {
    const hasCredentials = this.apiKey || (this.appId && this.accessKey) || this.accessKey
    return !!(this.voiceType && hasCredentials)
  }

  _headers(requestId) {
    const headers = {
      'X-Api-Resource-Id': this.resourceId,
      'X-Api-Request-Id': requestId,
      'X-Control-Require-Usage-Tokens-Return': 'text_words',
    }

    if (this.authMode === 'legacy' && this.appId && this.accessKey && !this.apiKey) {
      headers['X-Api-App-Id'] = this.appId
      headers['X-Api-Access-Key'] = this.accessKey
    } else {
      // Accept the existing ACCESS_TOKEN field as an API key so installations
      // can move to this endpoint without rewriting stored credentials.
      headers['X-Api-Key'] = this.apiKey || this.accessKey
    }

    return headers
  }

  _timeoutFor(text) {
    const characterCount = Array.from(text).length
    const safeSpeed = Number.isFinite(this.speedRatio) && this.speedRatio > 0 ? this.speedRatio : 1
    const longTextAllowance = 30000 + Math.ceil((characterCount * 250) / safeSpeed)
    return Math.min(this.maxTimeoutMs, Math.max(this.baseTimeoutMs, longTextAllowance))
  }

  synthesizeStream(text, onAudioChunk, onFinished, onError) {
    if (!this.isConfigured() && !this.url.startsWith('ws://localhost') && !this.url.startsWith('ws://127.0.0.1')) {
      onError(new Error('火山引擎 V3 TTS 未配置：请填写 TTS_VOICE_TYPE，以及 TTS_API_KEY 或 TTS_APP_ID + TTS_ACCESS_TOKEN'))
      return { abort: () => {} }
    }

    const requestId = crypto.randomUUID()
    const timeoutMs = this._timeoutFor(text)
    const characterCount = Array.from(text).length
    const byteCount = Buffer.byteLength(text, 'utf8')
    let settled = false
    let logId = ''
    let audioByteCount = 0

    const ws = new WebSocket(this.url, {
      headers: this._headers(requestId),
    })

    const settle = (fn) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }

    const timer = setTimeout(() => {
      settle(() => onError(new Error(`TTS V3 合成超时（${timeoutMs}ms，${characterCount} 字符）`)))
      try { ws.terminate() } catch {}
    }, timeoutMs)

    ws.on('upgrade', (response) => {
      logId = String(response.headers['x-tt-logid'] || '')
      console.log(`[TTS V3] 已连接 resource=${this.resourceId} chars=${characterCount} bytes=${byteCount}${logId ? ` logid=${logId}` : ''}`)
    })

    ws.on('open', () => {
      const payload = {
        user: { uid: 'robot_live_system' },
        req_params: {
          text,
          speaker: this.voiceType,
          audio_params: {
            format: 'mp3',
            sample_rate: this.sampleRate,
            speech_rate: ratioToV3Rate(this.speedRatio),
            loudness_rate: ratioToV3Rate(this.volumeRatio),
          },
        },
      }

      try {
        ws.send(buildV3TextFrame(payload))
      } catch (err) {
        settle(() => onError(err))
      }
    })

    ws.on('message', (data) => {
      let frame
      try {
        frame = parseV3Frame(data)
      } catch (err) {
        settle(() => onError(err))
        try { ws.close() } catch {}
        return
      }

      if (frame.messageType === 0x0f) {
        const detail = frame.json?.message || frame.json?.error || frame.text || 'unknown error'
        settle(() => onError(new Error(`TTS V3 Error ${frame.errorCode}: ${detail}${logId ? ` (logid ${logId})` : ''}`)))
        try { ws.close() } catch {}
        return
      }

      if (frame.event === V3_EVENTS.TTS_RESPONSE) {
        if (frame.payload.length) {
          audioByteCount += frame.payload.length
          onAudioChunk(frame.payload)
        }
        return
      }

      if (frame.event === V3_EVENTS.SESSION_FINISHED) {
        const statusCode = frame.json?.status_code
        if (statusCode != null && statusCode !== 20000000) {
          const message = frame.json?.message || 'session failed'
          settle(() => onError(new Error(`TTS V3 Session ${statusCode}: ${message}${logId ? ` (logid ${logId})` : ''}`)))
        } else {
          console.log(`[TTS V3] 合成完成 chars=${characterCount} audioBytes=${audioByteCount}${logId ? ` logid=${logId}` : ''}`)
          settle(() => onFinished({ logId, usage: frame.json?.usage || null }))
        }
        try { ws.close() } catch {}
      }
    })

    ws.on('unexpected-response', (_request, response) => {
      const chunks = []
      let size = 0
      response.on('data', (chunk) => {
        if (size >= 8192) return
        const part = Buffer.from(chunk).subarray(0, 8192 - size)
        chunks.push(part)
        size += part.length
      })
      response.on('end', () => {
        const detail = Buffer.concat(chunks).toString('utf8').trim()
        settle(() => onError(new Error(`TTS V3 握手失败 HTTP ${response.statusCode}${detail ? `: ${detail}` : ''}`)))
      })
    })

    ws.on('error', (err) => {
      settle(() => onError(err))
    })

    ws.on('close', (code) => {
      settle(() => onError(new Error(`TTS V3 连接已关闭但合成未完成 (code ${code})${logId ? ` (logid ${logId})` : ''}`)))
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
