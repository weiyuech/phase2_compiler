/**
 * 火山引擎语音合成 WebSocket V3 单向流式客户端。
 *
 * 客户端一次性提交完整文本，服务端以 V3 event 帧持续返回 MP3 音频。
 * 官方接口：wss://openspeech.bytedance.com/api/v3/tts/unidirectional/stream
 */

import WebSocket from 'ws'
import crypto from 'crypto'
import { V3_EVENTS, parsePositiveInt, ratioToV3Rate, inferV3ResourceId, buildV3TextFrame, parseV3Frame } from './volcengine-v3-protocol.js'
export { V3_EVENTS, inferV3ResourceId, buildV3TextFrame, buildV3FinishConnectionFrame, parseV3Frame } from './volcengine-v3-protocol.js'

const DEFAULT_V3_URL = 'wss://openspeech.bytedance.com/api/v3/tts/unidirectional/stream'

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
    let closeTimer = null
    let handshakeResponse = null

    let ws
    try {
      ws = new WebSocket(this.url, {
        headers: this._headers(requestId),
      })
    } catch (err) {
      onError(err)
      return { abort: () => {} }
    }

    const settle = (fn, { graceful = false } = {}) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // Dispose the provider session before calling user code. Even a thrown
      // callback must not leave a synthesis request alive in the background.
      try { handshakeResponse?.destroy() } catch {}
      if (graceful && ws.readyState === WebSocket.OPEN) {
        try { ws.close() } catch { try { ws.terminate() } catch {} }
        // A peer that never acknowledges close must not retain one socket per
        // finished sentence. All audio arrived before SESSION_FINISHED.
        if (ws.readyState !== WebSocket.CLOSED) {
          closeTimer = setTimeout(() => { try { ws.terminate() } catch {} }, 1000)
          closeTimer.unref?.()
        }
      } else {
        try { ws.terminate() } catch {}
      }
      fn()
    }

    const timer = setTimeout(() => {
      settle(() => onError(new Error(`TTS V3 合成超时（${timeoutMs}ms，${characterCount} 字符）`)))
    }, timeoutMs)

    ws.on('upgrade', (response) => {
      if (settled) return
      logId = String(response.headers['x-tt-logid'] || '')
      console.log(`[TTS V3] 已连接 resource=${this.resourceId} chars=${characterCount} bytes=${byteCount}${logId ? ` logid=${logId}` : ''}`)
    })

    ws.on('open', () => {
      if (settled) return
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
        ws.send(buildV3TextFrame(payload), (err) => {
          if (err) settle(() => onError(err))
        })
      } catch (err) {
        settle(() => onError(err))
      }
    })

    ws.on('message', (data) => {
      if (settled) return
      let frame
      try {
        frame = parseV3Frame(data)
      } catch (err) {
        settle(() => onError(err))
        return
      }

      if (frame.messageType === 0x0f) {
        const detail = frame.json?.message || frame.json?.error || frame.text || 'unknown error'
        settle(() => onError(new Error(`TTS V3 Error ${frame.errorCode}: ${detail}${logId ? ` (logid ${logId})` : ''}`)))
        return
      }

      if (frame.event === V3_EVENTS.TTS_RESPONSE) {
        if (frame.payload.length) {
          audioByteCount += frame.payload.length
          try { onAudioChunk(frame.payload) } catch (err) { settle(() => onError(err)) }
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
          settle(() => onFinished({ logId, usage: frame.json?.usage || null }), { graceful: true })
        }
      }
    })

    ws.on('unexpected-response', (_request, response) => {
      response.on('error', (err) => settle(() => onError(err)))
      if (settled) { response.destroy(); return }
      handshakeResponse = response
      const chunks = []
      let size = 0
      response.on('data', (chunk) => {
        if (settled) return
        if (size >= 8192) return
        const part = Buffer.from(chunk).subarray(0, 8192 - size)
        chunks.push(part)
        size += part.length
      })
      response.on('end', () => {
        const detail = Buffer.concat(chunks).toString('utf8').trim()
        settle(() => onError(new Error(`TTS V3 握手失败 HTTP ${response.statusCode}${detail ? `: ${detail}` : ''}`)))
      })
      response.on('aborted', () => settle(() => onError(new Error(`TTS V3 握手响应中断 HTTP ${response.statusCode}`))))
    })

    ws.on('error', (err) => {
      settle(() => onError(err))
    })

    ws.on('close', (code) => {
      clearTimeout(closeTimer)
      settle(() => onError(new Error(`TTS V3 连接已关闭但合成未完成 (code ${code})${logId ? ` (logid ${logId})` : ''}`)))
    })

    return {
      abort: () => {
        settle(() => {})
      },
    }
  }
}
