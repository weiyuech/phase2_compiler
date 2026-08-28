import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { WebSocketServer } from 'ws'

import {
  VolcengineTTSWSClient,
  V3_EVENTS,
  buildV3TextFrame,
  inferV3ResourceId,
  parseV3Frame,
} from '../src/tts/volcengine-ws-client.js'

function buildServerEventFrame(event, payload, { messageType = 0x09, id = 'session-test' } = {}) {
  const idBuffer = Buffer.from(id, 'utf8')
  const payloadBuffer = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload), 'utf8')
  const frame = Buffer.alloc(16 + idBuffer.length + payloadBuffer.length)
  frame.set([0x11, (messageType << 4) | 0x04, 0x10, 0x00], 0)
  frame.writeInt32BE(event, 4)
  frame.writeUInt32BE(idBuffer.length, 8)
  idBuffer.copy(frame, 12)
  const payloadLengthOffset = 12 + idBuffer.length
  frame.writeUInt32BE(payloadBuffer.length, payloadLengthOffset)
  payloadBuffer.copy(frame, payloadLengthOffset + 4)
  return frame
}

function buildServerErrorFrame(code, message) {
  const payload = Buffer.from(JSON.stringify({ message }), 'utf8')
  const frame = Buffer.alloc(12 + payload.length)
  frame.set([0x11, 0xf0, 0x10, 0x00], 0)
  frame.writeUInt32BE(code, 4)
  frame.writeUInt32BE(payload.length, 8)
  payload.copy(frame, 12)
  return frame
}

function decodeClientTextFrame(frame) {
  assert.deepEqual([...frame.subarray(0, 4)], [0x11, 0x10, 0x10, 0x00])
  const payloadLength = frame.readUInt32BE(4)
  assert.equal(payloadLength, frame.length - 8)
  return JSON.parse(frame.subarray(8).toString('utf8'))
}

async function createServer() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  const address = server.address()
  return {
    server,
    url: `ws://127.0.0.1:${address.port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

test('V3 text request frame contains the complete long text', () => {
  const text = '这是一段超过旧版三百字符限制的测试文本。'.repeat(40)
  assert.ok(Array.from(text).length > 300)
  const frame = buildV3TextFrame({ user: { uid: 'test' }, req_params: { text } })
  const payload = decodeClientTextFrame(frame)
  assert.equal(payload.req_params.text, text)
})

test('V3 frame parser decodes audio, completion metadata, and errors', () => {
  const audio = Buffer.from([1, 2, 3, 4])
  const audioFrame = parseV3Frame(buildServerEventFrame(
    V3_EVENTS.TTS_RESPONSE,
    audio,
    { messageType: 0x0b },
  ))
  assert.equal(audioFrame.event, V3_EVENTS.TTS_RESPONSE)
  assert.deepEqual(audioFrame.payload, audio)

  const finishedFrame = parseV3Frame(buildServerEventFrame(
    V3_EVENTS.SESSION_FINISHED,
    { status_code: 20000000, message: 'ok', usage: { text_words: 800 } },
  ))
  assert.equal(finishedFrame.json.status_code, 20000000)
  assert.equal(finishedFrame.json.usage.text_words, 800)

  const errorFrame = parseV3Frame(buildServerErrorFrame(45000001, 'invalid request'))
  assert.equal(errorFrame.errorCode, 45000001)
  assert.equal(errorFrame.json.message, 'invalid request')
})

test('V3 client streams audio and waits for SessionFinished', async (t) => {
  const mock = await createServer()
  t.after(() => mock.close())

  const longText = '机器人正在进行长文本语音合成测试。'.repeat(45)
  assert.ok(Array.from(longText).length > 300)
  let receivedRequest
  let receivedHeaders

  mock.server.once('connection', (socket, request) => {
    receivedHeaders = request.headers
    socket.once('message', (data) => {
      receivedRequest = decodeClientTextFrame(Buffer.from(data))
      socket.send(buildServerEventFrame(
        V3_EVENTS.TTS_RESPONSE,
        Buffer.from([0x49, 0x44, 0x33, 0x04]),
        { messageType: 0x0b },
      ))
      socket.send(buildServerEventFrame(
        V3_EVENTS.SESSION_FINISHED,
        { status_code: 20000000, message: 'ok', usage: { text_words: Array.from(longText).length } },
      ))
    })
  })

  const client = new VolcengineTTSWSClient({
    TTS_WS_URL: mock.url,
    TTS_APP_ID: 'app-test',
    TTS_ACCESS_TOKEN: 'access-test',
    TTS_AUTH_MODE: 'legacy',
    TTS_VOICE_TYPE: 'S_test',
    TTS_CLUSTER: 'volcano_icl',
    TTS_RESOURCE_ID: 'seed-icl-1.0',
    TTS_TIMEOUT_MS: 1000,
    TTS_MAX_TIMEOUT_MS: 2000,
  })

  const chunks = []
  const metadata = await new Promise((resolve, reject) => {
    client.synthesizeStream(longText, chunk => chunks.push(chunk), resolve, reject)
  })

  assert.equal(receivedHeaders['x-api-app-id'], 'app-test')
  assert.equal(receivedHeaders['x-api-access-key'], 'access-test')
  assert.equal(receivedHeaders['x-api-resource-id'], 'seed-icl-1.0')
  assert.equal(receivedRequest.req_params.text, longText)
  assert.equal(receivedRequest.req_params.speaker, 'S_test')
  assert.equal(receivedRequest.req_params.audio_params.format, 'mp3')
  assert.deepEqual(Buffer.concat(chunks), Buffer.from([0x49, 0x44, 0x33, 0x04]))
  assert.equal(metadata.usage.text_words, Array.from(longText).length)
})

test('V3 client reports a server error with its code', async (t) => {
  const mock = await createServer()
  t.after(() => mock.close())

  mock.server.once('connection', (socket) => {
    socket.once('message', () => {
      socket.send(buildServerErrorFrame(45000001, 'speaker is not available'))
    })
  })

  const client = new VolcengineTTSWSClient({
    TTS_WS_URL: mock.url,
    TTS_API_KEY: 'api-test',
    TTS_RESOURCE_ID: 'seed-tts-1.0',
    TTS_TIMEOUT_MS: 1000,
    TTS_MAX_TIMEOUT_MS: 2000,
  })

  await assert.rejects(
    new Promise((resolve, reject) => {
      client.synthesizeStream('错误测试', () => {}, resolve, reject)
    }),
    /TTS V3 Error 45000001: speaker is not available/,
  )
})

test('V3 resource ID inference preserves built-in and cloned voice compatibility', () => {
  assert.equal(inferV3ResourceId('volcano_tts'), 'seed-tts-1.0')
  assert.equal(inferV3ResourceId('volcano_icl'), 'seed-icl-1.0')
})
