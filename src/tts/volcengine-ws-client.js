/**
 * src/tts/volcengine-ws-client.js
 *
 * 火山引擎 语音合成 WebSocket API client.
 * Uses the custom 8-byte binary framing protocol.
 */

import WebSocket from 'ws'
import crypto from 'crypto'

export class VolcengineTTSWSClient {
  constructor(config = {}) {
    this.apiKey    = config.TTS_ACCESS_TOKEN || process.env.TTS_ACCESS_TOKEN
    this.appId     = config.TTS_APP_ID       || process.env.TTS_APP_ID
    this.voiceType = config.TTS_VOICE_TYPE   || process.env.TTS_VOICE_TYPE || 'BV001_streaming'
    this.cluster   = config.TTS_CLUSTER      || process.env.TTS_CLUSTER    || 'volcano_tts'
    this.speedRatio  = parseFloat(config.TTS_SPEED  || process.env.TTS_SPEED  || '1.0')
    this.volumeRatio = parseFloat(config.TTS_VOLUME || process.env.TTS_VOLUME || '1.0')
    this.url       = config.TTS_WS_URL       || 'wss://openspeech.bytedance.com/api/v1/tts/ws_binary'
  }

  synthesizeStream(text, onAudioChunk, onFinished, onError) {
    // If using local mock URL, we don't need apiKey check
    if (!this.url.startsWith('ws://localhost') && !this.apiKey) {
      onError(new Error('火山引擎未配置 TTS_ACCESS_TOKEN'))
      return { abort: () => {} }
    }

    const reqId = crypto.randomUUID()
    const ws = new WebSocket(this.url, {
      headers: {
        'x-api-key': this.apiKey || ''
      }
    })

    // 原来这里只挂了 open / message / error 三个事件。
    // 如果服务端把连接干净地关掉却没发最终音频帧（空闲断开、代理掐断、半开连接），
    // onFinished 和 onError 都不会被调用 —— 上层 await 的 Promise 永远悬着，
    // playPoint 不返回，_goalHandling 一直为 true，之后每次"到点"都被丢弃。
    // 现场表现就是：机器人到了点位不说话、也不再往下走，而且没有任何报错。
    let settled = false
    const TIMEOUT_MS = parseInt(process.env.TTS_TIMEOUT_MS || '30000')
    const timer = setTimeout(() => {
      settle(() => onError(new Error(`TTS 合成超时（${TIMEOUT_MS}ms 内未完成）`)))
      try { ws.terminate() } catch {}
    }, TIMEOUT_MS)

    // 保证 onFinished / onError 恰好被调用一次，并清掉超时定时器
    const settle = (fn) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }

    ws.on('open', () => {
      const payload = {
        app: {
          appid:   this.appId,
          cluster: this.cluster
        },
        user: {
          uid: 'robot_live_system'
        },
        audio: {
          voice_type:   this.voiceType,
          encoding:     'mp3',
          speed_ratio:  this.speedRatio,
          volume_ratio: this.volumeRatio,
          pitch_ratio:  1.0
        },
        request: {
          reqid:     reqId,
          text:      text,
          operation: 'submit'
        }
      }

      const payloadStr = JSON.stringify(payload)
      const payloadBuffer = Buffer.from(payloadStr, 'utf8')

      // Construct 8-Byte Binary Header according to Volcengine Speech WebSocket specification:
      // Byte 1 (index 0): Version (1) & Header Length (1 word / 4 bytes) -> 0x11
      // Byte 2 (index 1): Message Type: Start request -> 0x10
      // Byte 3 (index 2): Message Type Specific Flags -> 0x00
      // Byte 4 (index 3): Serialization: JSON (1) & Compression: None (0) -> 0x10
      // Bytes 5-8 (index 4-7): Payload Length (Big Endian UInt32)
      const header = Buffer.alloc(8)
      header.writeUInt8(0x11, 0)
      header.writeUInt8(0x10, 1)
      header.writeUInt8(0x00, 2)
      header.writeUInt8(0x10, 3)
      header.writeUInt32BE(payloadBuffer.length, 4)

      const frame = Buffer.concat([header, payloadBuffer])
      ws.send(frame)
    })

    ws.on('message', (data) => {
      if (data.length < 8) return

      // In Volcengine response, msgType is at index 1 (Byte 2)
      const msgType = data.readUInt8(1)
      const payload = data.slice(12) // All payloads (JSON and Audio) start at offset 12

      if (msgType === 0xb1 || msgType === 0x1a) {
        // Raw Audio Chunk (0xb1 is server-to-client audio frame)
        onAudioChunk(payload)
      } else if (msgType === 0xb3 || msgType === 0x13) {
        // Final Audio Chunk (0xb3 is server-to-client final audio frame)
        if (payload.length > 0) {
          onAudioChunk(payload)
        }
        settle(onFinished)
        ws.close()
      } else if (msgType === 0xf0 || msgType === 0x1f) {
        // JSON Error response
        try {
          const err = JSON.parse(payload.toString('utf8'))
          settle(() => onError(new Error(`TTS Error ${err.code || 3099}: ${err.message || 'unknown error'}`)))
        } catch {
          settle(() => onError(new Error('TTS Error response received')))
        }
        ws.close()
      }
    })

    ws.on('error', (err) => {
      settle(() => onError(err))
    })

    // 连接关闭时如果还没有结果，就是"没收到完整音频就断了"，必须报错，
    // 否则调用方会一直等下去
    ws.on('close', (code) => {
      settle(() => onError(new Error(`TTS 连接已关闭但未收到完整音频 (code ${code})`)))
    })

    return {
      abort: () => {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.terminate()
        }
      }
    }
  }
}
