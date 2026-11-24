// Shared framing for the existing Volcengine V3 unidirectional protocol.
import { gunzipSync } from 'node:zlib'

export const V3_EVENTS = Object.freeze({
  FINISH_CONNECTION:   2,
  CONNECTION_FINISHED: 52,
  SESSION_FINISHED:    152,
  SENTENCE_START:      350,
  SENTENCE_END:        351,
  TTS_RESPONSE:        352,
})

export function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function ratioToV3Rate(value) {
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

