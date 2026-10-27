import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import vm from 'node:vm'
import { getTourState, registerTourControls } from '../src/task/ui-controls.js'

const blockedMessage = '请先停止巡游，再进行手动播报测试'
const bridgeSource = readFileSync(new URL('../src/ui-bridge.js', import.meta.url), 'utf8')

// Exercise the actual JSON dispatcher and registered handlers, with an in-memory
// WebSocket server. No app startup, robot, TTS provider, sockets, or disk writes.
function fixture(source = bridgeSource) {
  let server
  class FakeServer extends EventEmitter {
    constructor() { super(); this.clients = new Set(); server = this }
  }
  const logs = []
  const logger = { log(...args) { logs.push(args.join(' ')) }, error(...args) { logs.push(args.join(' ')) }, warn() {} }
  const context = vm.createContext({
    WebSocketServer: FakeServer, Buffer, console: logger,
    process: { env: {} }, writeSync() {},
  })
  // Git may check out CRLF on Windows. Normalize before stripping the module
  // declarations: JavaScript's dot does not match the CR before a newline.
  const script = source.replace(/\r\n?/g, '\n').replace(/^import .+\n/gm, '').replace(/^export /gm, '')
  vm.runInContext(script +
    '\nthis.bridge = { start, on, broadcast };', context)
  const bridge = context.bridge
  const tour = { isRunning: false, isPaused: false, repeatCount: 1, currentIteration: 0 }
  const calls = []
  const tts = { speak: async text => { calls.push(text); return { ok: true } } }
  const stationaryCalls = []
  const stationaryTts = { speak: async (text, options) => { stationaryCalls.push({ text, options }); return { ok: true } } }
  const stationaryLlm = { rewriteStationary: async text => ({ text: `改写：${text}` }) }
  const controls = registerTourControls({ uiBridge: bridge, tour, tts, stationaryTts, stationaryLlm, logger })
  bridge.start(0)
  const socket = new EventEmitter()
  socket.readyState = 1
  socket.messages = []
  socket.send = raw => socket.messages.push(JSON.parse(raw))
  server.clients.add(socket)
  server.emit('connection', socket)
  socket.messages.length = 0
  return {
    tour, tts, calls, socket, bridge, logs, controls, stationaryCalls, stationaryTts,
    async send(type, data = {}) {
      socket.emit('message', Buffer.from(JSON.stringify({ type, data })), false)
      await new Promise(resolve => setImmediate(resolve))
    },
  }
}

for (const [name, lineEnding] of [['LF', '\n'], ['CRLF', '\r\n']]) {
  test(`the bridge fixture loads and dispatches ${name} source independently of checkout defaults`, async () => {
    const source = bridgeSource.replace(/\r\n?/g, '\n').replace(/\n/g, lineEnding)
    assert.equal(source.includes('\r\n'), name === 'CRLF')
    const h = fixture(source)
    Object.assign(h.tour, { isRunning: true, isPaused: true, repeatCount: 3, currentIteration: 2 })
    await h.send('GET_TOUR_STATE')
    assert.deepEqual(h.socket.messages.at(-1).data, {
      running: true, paused: true, repeatCount: 3, currentIteration: 2,
    })
    await h.send('TEST_SPEECH', { text: 'Do not interrupt this tour.' })
    assert.deepEqual(h.calls, [])
    assert.equal(h.socket.messages.at(-1).data.message, blockedMessage)
  })
}

for (const paused of [false, true]) {
  test(`manual playback is rejected without touching TTS during a ${paused ? 'paused' : 'running'} tour`, async () => {
    const h = fixture()
    Object.assign(h.tour, { isRunning: true, isPaused: paused })
    await h.send('TEST_SPEECH', { text: 'Do not replace point narration.' })
    assert.deepEqual(h.calls, [])
    assert.equal(h.socket.messages.at(-1).type, 'ERROR')
    assert.equal(h.socket.messages.at(-1).data.message, blockedMessage)
  })
}

test('manual playback remains available outside a tour', async () => {
  const h = fixture()
  await h.send('TEST_SPEECH', { text: 'Test sentence.' })
  assert.deepEqual(h.calls, ['Test sentence.'])
  assert.deepEqual(h.socket.messages.filter(m => m.type === 'TEST_SPEECH_STATUS').map(m => m.data.state), ['preparing', 'completed'])
})

test('normal manual-test cancellation is not reported as an error', async () => {
  const h = fixture()
  h.tts.speak = async () => ({ ok: false, aborted: true })
  await h.send('TEST_SPEECH', { text: 'Cancelled test.' })
  assert.deepEqual(h.socket.messages.filter(m => m.type === 'TEST_SPEECH_STATUS').map(m => m.data.state), ['preparing', 'cancelled'])
})

test('manual playback failures retain useful messages and tolerate missing error details', async () => {
  const h = fixture()
  for (const [speak, expected] of [
    [async () => ({ ok: false, error: new Error('Decode failed') }), 'Decode failed'],
    [async () => ({ ok: false }), '语音播放失败'],
    [async () => { throw new Error('Playback failed') }, 'Playback failed'],
    [async () => { throw null }, '语音播放失败'],
  ]) {
    h.tts.speak = speak
    await h.send('TEST_SPEECH', { text: 'Test sentence.' })
    assert.equal(h.socket.messages.findLast(m => m.type === 'ERROR').data.message, `手动播报测试失败: ${expected}`)
  }
})

test('GET_TOUR_STATE returns the authoritative current tour state to its requester', async () => {
  const h = fixture()
  Object.assign(h.tour, { isRunning: true, isPaused: true, repeatCount: 4, currentIteration: 2 })
  await h.send('GET_TOUR_STATE')
  const reply = h.socket.messages.at(-1)
  assert.equal(reply.type, 'TOUR_STATE')
  assert.deepEqual(reply.data, { running: true, paused: true, repeatCount: 4, currentIteration: 2 })
  h.tour.isRunning = false
  h.tour.isPaused = false
  h.tour.currentIteration = 0
  await h.send('GET_TOUR_STATE')
  assert.deepEqual(h.socket.messages.at(-1).data, getTourState(h.tour))
})

test('late-joining clients also receive a tour snapshot from the application hook', () => {
  const indexSource = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  const begin = indexSource.indexOf("uiBridge.on('onNewClient',")
  const end = indexSource.indexOf('// ── UI Bridge commands', begin)
  assert.ok(begin >= 0 && end > begin)
  let hook
  const tour = { isRunning: true, isPaused: false, repeatCount: 3, currentIteration: 2 }
  const context = vm.createContext({
    uiBridge: { on: (_name, handler) => { hook = handler } }, tour, getTourState,
    tourControls: { snapshot: () => ({ active: true, loop: true, iteration: 3, manualActive: false }) },
    audioDiagnostics: { snapshot: () => ({}) }, transitAudio: { getConfig: () => ({}) },
    audioOutput: { getConfig: () => ({}) }, robotConnected: false,
  })
  vm.runInContext(indexSource.slice(begin, end), context)
  const sent = []
  hook((type, data) => sent.push({ type, data }))
  assert.deepEqual(sent.find(message => message.type === 'TOUR_STATE').data,
    { running: true, paused: false, repeatCount: 3, currentIteration: 2 })
  assert.equal(sent.find(message => message.type === 'STATIONARY_SPEECH_STATE').data.iteration, 3)
})

test('operator failures are recorded in backend output as well as UI events', async () => {
  const h = fixture()
  h.tts.speak = async () => ({ ok: false, error: new Error('Missing audio device') })
  await h.send('TEST_SPEECH', { text: 'private draft' })
  assert.ok(h.logs.some(line => line.includes('收到控制指令: TEST_SPEECH')))
  assert.ok(h.logs.some(line => line.includes('[UI ERROR]') && line.includes('Missing audio device')))
  assert.equal(h.logs.some(line => line.includes('private draft')), false)
  assert.ok(h.socket.messages.some(m => m.type === 'ERROR'))
})

test('sync and async command exceptions reach the UI instead of being lost', async () => {
  const h = fixture()
  for (const handler of [() => { throw new Error('sync failure') }, async () => { throw new Error('async failure') }]) {
    h.bridge.on('onStartTour', handler)
    await h.send('START_TOUR', { repeatCount: 1 })
    assert.equal(h.socket.messages.at(-1).type, 'ERROR')
    assert.match(h.socket.messages.at(-1).data.message, /failure/)
  }
})

test('manual playback reports preparation, actual playback and completion', async () => {
  const h = fixture()
  h.tts.speak = async (_text, options) => { options.onAudioStart(); return { ok: true } }
  await h.send('TEST_SPEECH', { text: 'hello' })
  assert.deepEqual(h.socket.messages.filter(m => m.type === 'TEST_SPEECH_STATUS').map(m => m.data.state), ['preparing', 'playing', 'completed'])
})

test('stationary commands use only the cruise service, publish state and query without replay', async () => {
  const h = fixture()
  await h.send('START_STATIONARY_SPEECH', { text: 'private stationary draft', loop: false })
  await h.controls.stationary.finished
  assert.deepEqual(h.calls, [])
  assert.deepEqual(h.stationaryCalls.map(call => call.text), ['改写：private stationary draft'])
  await h.send('GET_STATIONARY_SPEECH_STATE')
  assert.equal(h.socket.messages.at(-1).type, 'STATIONARY_SPEECH_STATE')
  assert.equal(h.socket.messages.at(-1).data.state, 'completed')
  assert.equal(h.socket.messages.at(-1).data.manualActive, false)
  assert.equal(h.stationaryCalls.length, 1)
  assert.equal(h.logs.some(line => line.includes('private stationary draft')), false)
})

test('backend refuses simultaneous tour, manual, duplicate stationary and rejects malformed commands', async () => {
  const h = fixture()
  for (const paused of [false, true]) {
    Object.assign(h.tour, { isRunning: true, isPaused: paused })
    await h.send('START_STATIONARY_SPEECH', { text: 'must not play', loop: true })
    assert.match(h.socket.messages.at(-1).data.message, /停止巡游/)
    assert.equal(h.stationaryCalls.length, 0)
  }
  Object.assign(h.tour, { isRunning: false, isPaused: false })
  for (const data of [null, {}, { text: ' ' }, { text: 'bad loop', loop: 'false' }]) {
    await h.send('START_STATIONARY_SPEECH', data)
    assert.equal(h.socket.messages.at(-1).type, 'ERROR')
    assert.equal(h.controls.stationary.active, false)
  }
  h.stationaryTts.speak = (_text, { signal }) => new Promise(resolve => {
    signal.addEventListener('abort', () => resolve({ aborted: true }), { once: true })
  })
  await h.send('START_STATIONARY_SPEECH', { text: 'hold', loop: true })
  await h.send('TEST_SPEECH', { text: 'blocked manual' })
  assert.deepEqual(h.calls, [])
  assert.equal(h.controls.canStartTour(), false)
  await h.send('START_STATIONARY_SPEECH', { text: 'duplicate' })
  assert.match(h.socket.messages.at(-1).data.message, /原地播报正在进行/)
  await h.send('STOP_STATIONARY_SPEECH')
  await h.controls.stationary.finished
  assert.equal(h.controls.canStartTour(), true)
  assert.equal(h.controls.snapshot().state, 'cancelled')
})

test('manual in-flight state excludes stationary/tour and is released after failure', async () => {
  const h = fixture()
  let finish
  h.tts.speak = () => new Promise(resolve => { finish = resolve })
  await h.send('TEST_SPEECH', { text: 'hold manual' })
  assert.equal(h.controls.snapshot().manualActive, true)
  assert.equal(h.controls.canStartTour(), false)
  await h.send('START_STATIONARY_SPEECH', { text: 'blocked', loop: true })
  assert.match(h.socket.messages.at(-1).data.message, /等待手动播报/)
  assert.deepEqual(h.stationaryCalls, [])
  finish({ ok: false, error: new Error('test failure') })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.controls.snapshot().manualActive, false)
  assert.equal(h.controls.canStartTour(), true)
})
