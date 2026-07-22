/**
 * src/tts/volcengine-client.js
 *
 * 火山引擎 语音合成 HTTP API client.
 * Updated for x-api-key authentication.
 */

import crypto from 'crypto'

const API_URL = 'https://openspeech.bytedance.com/api/v1/tts'

export class VolcengineTTSClient {
  constructor(config = {}) {
    this.appId       = config.TTS_APP_ID       || process.env.TTS_APP_ID
    this.apiKey      = config.TTS_ACCESS_TOKEN || process.env.TTS_ACCESS_TOKEN
    this.voiceType   = config.TTS_VOICE_TYPE   || process.env.TTS_VOICE_TYPE || 'BV001'
    this.cluster     = config.TTS_CLUSTER      || process.env.TTS_CLUSTER    || 'volcano_tts'
    this.speedRatio  = parseFloat(config.TTS_SPEED  || process.env.TTS_SPEED  || '1.0')
    this.volumeRatio = parseFloat(config.TTS_VOLUME || process.env.TTS_VOLUME || '1.0')
  }

  async synthesise(text, options = {}) {
    const reqId = crypto.randomUUID()

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
        operation: 'query'
      }
    }

    const res = await fetch(API_URL, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key':    this.apiKey // Swapped from Authorization: Bearer
      },
      body: JSON.stringify(payload),
      signal: options.signal
    })

    if (!res.ok) {
      const errText = await res.text()
      throw new Error(`TTS API error ${res.status}: ${errText}`)
    }

    const data = await res.json()

    // Volcengine returns 3000 for success
    if (data.code !== 3000) {
      throw new Error(`TTS error code ${data.code}: ${data.message}`)
    }

    // API returns base64-encoded audio in the data field
    const audioBase64 = data.data
    return Buffer.from(audioBase64, 'base64')
  }
}