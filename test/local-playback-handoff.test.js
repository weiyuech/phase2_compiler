import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { TTSEngine } from '../src/tts/index.js'
import { AudioPlayer } from '../src/tts/audio-player.js'

const temp = mkdtempSync(join(tmpdir(), 'local-handoff-test-'))
const previousUserData = process.env.USER_DATA_DIR
process.env.USER_DATA_DIR = temp
const audioFile = join(temp, 'clip.mp3')
writeFileSync(audioFile, Buffer.from('ID3-local-test-fixture'))
after(() => {
  if (previousUserData === undefined) delete process.env.USER_DATA_DIR
  else process.env.USER_DATA_DIR = previousUserData
  rmSync(temp, { recursive: true, force: true })
})

function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function engineHarness(t, { ready } = {}) {
  const engine = new TTSEngine({ TTS_API_KEY: 'test-only' })
  engine.enabled = true // Provider is fully mocked; no runtime credentials required.
  const calls = []
  const streams = []
  let stops = 0
  engine.wsClient.synthesizeStream = (_text, chunk, finish, error) => {
    const call = { chunk, finish, error, aborted: false, abort() { this.aborted = true } }
    calls.push(call)
    return call
  }
  engine.player = {
    stop() { stops++ },
    startStream() {
      const done = deferred()
      const stream = {
        ready, promise: done.promise, done, chunks: [], ends: 0,
        write(bytes) { this.chunks.push(Buffer.from(bytes)) },
        end() { this.ends++ },
      }
      streams.push(stream)
      return stream
    },
  }
  t.after(() => engine.destroy())
  return { engine, calls, streams, get stops() { return stops } }
}

test('TTS completion during readiness wait retains every chunk and ends once', async t => {
  const h = engineHarness(t)
  const gate = deferred()
  let starts = 0
  const result = h.engine.speak('等待中完成合成', {
    waitForPlayback: () => gate.promise,
    onAudioStart: () => starts++,
  })
  const a = Buffer.alloc(4096, 1), b = Buffer.alloc(1234, 2), c = Buffer.alloc(7, 3)
  h.calls[0].chunk(a)
  await nextTurn()
  h.calls[0].chunk(b)
  h.calls[0].chunk(c)
  h.calls[0].finish()
  h.calls[0].finish() // duplicate completion is harmless
  assert.equal(h.streams.length, 0)
  assert.equal(starts, 0)
  gate.resolve(true)
  await nextTurn()
  assert.equal(h.streams.length, 1)
  assert.equal(starts, 1)
  assert.deepEqual(Buffer.concat(h.streams[0].chunks), Buffer.concat([a, b, c]))
  assert.equal(h.streams[0].ends, 1)
  h.calls[0].chunk(Buffer.from('late'))
  h.streams[0].done.resolve()
  assert.deepEqual(await result, { ok: true })
})

test('local TTS handoff waits for successful spawn and rechecks eligibility', async t => {
  const ready = deferred()
  const pauseGate = deferred()
  const h = engineHarness(t, { ready: ready.promise })
  let checks = 0, starts = 0
  const result = h.engine.speak('启动期间主播说话', {
    waitForPlayback: () => ++checks === 1 ? true : pauseGate.promise,
    onAudioStart: () => starts++,
  })
  h.calls[0].chunk(Buffer.alloc(4096))
  await nextTurn()
  assert.equal(h.streams.length, 1)
  assert.equal(starts, 0)
  ready.resolve()
  await nextTurn()
  h.calls[0].finish()
  assert.equal(checks, 2)
  assert.equal(starts, 0)
  assert.equal(h.streams[0].chunks.length, 0)
  pauseGate.resolve(true)
  await nextTurn()
  assert.equal(starts, 1)
  assert.equal(h.streams[0].ends, 1)
  h.streams[0].done.resolve()
  assert.equal((await result).ok, true)
})

for (const action of ['stop', 'external abort', 'replacement']) {
  test(`TTS ${action} cancels pending readiness and ignores old provider callbacks`, async t => {
    const h = engineHarness(t)
    const gate = deferred(), signal = new AbortController()
    let starts = 0, gateSignal
    const old = h.engine.speak('旧的播报', {
      signal: signal.signal,
      waitForPlayback: ({ signal }) => { gateSignal = signal; return gate.promise },
      onAudioStart: () => starts++,
    })
    h.calls[0].chunk(Buffer.alloc(4096))
    await nextTurn()
    let replacement
    if (action === 'stop') h.engine.stop()
    else if (action === 'external abort') signal.abort()
    else replacement = h.engine.speak('新的播报')
    assert.deepEqual(await old, { ok: false, aborted: true })
    assert.equal(gateSignal.aborted, true)
    assert.equal(h.calls[0].aborted, true)
    const stopsAfterCancel = h.stops
    h.calls[0].chunk(Buffer.alloc(4096))
    h.calls[0].finish()
    h.calls[0].error(new Error('late old provider error'))
    gate.resolve(true)
    await nextTurn()
    assert.equal(starts, 0)
    assert.equal(h.streams.length, 0)
    assert.equal(h.stops, stopsAfterCancel)
    if (replacement) {
      assert.equal(h.engine.activeWSCall, h.calls[1])
      h.calls[1].chunk(Buffer.from([1]))
      h.calls[1].finish()
      h.streams[0].done.resolve()
      assert.equal((await replacement).ok, true)
    }
  })
}

test('TTS gate denial, stale validity and empty audio never hand off', async t => {
  for (const kind of ['denied', 'invalid', 'empty']) {
    const h = engineHarness(t)
    let starts = 0
    const result = h.engine.speak(`拒绝${kind}`, {
      waitForPlayback: async () => kind !== 'denied',
      beforePlay: () => kind !== 'invalid',
      onAudioStart: () => starts++,
    })
    if (kind !== 'empty') h.calls[0].chunk(Buffer.from([1]))
    h.calls[0].finish()
    assert.equal((await result).ok, false)
    assert.equal(h.streams.length, 0)
    assert.equal(starts, 0)
  }
})

test('TTS child startup failure never cuts transit and aborts synthesis', async t => {
  const ready = deferred()
  const h = engineHarness(t, { ready: ready.promise })
  let starts = 0
  const result = h.engine.speak('启动失败', {
    waitForPlayback: async () => true,
    onAudioStart: () => starts++,
  })
  h.calls[0].chunk(Buffer.alloc(4096))
  await nextTurn()
  ready.reject(new Error('ffplay not found'))
  assert.equal((await result).ok, false)
  assert.equal(starts, 0)
  assert.equal(h.calls[0].aborted, true)
})

test('ungated TTS preserves synchronous 4KB streaming and barrage hook', async t => {
  const h = engineHarness(t)
  const order = []
  const result = h.engine.speak('现有流式播报', {
    beforePlay: () => { order.push('check'); return true },
    onAudioStart: () => order.push('start'),
  })
  h.calls[0].chunk(Buffer.alloc(4095))
  assert.equal(h.streams.length, 0)
  h.calls[0].chunk(Buffer.from([7]))
  assert.equal(h.streams.length, 1)
  assert.equal(order.at(-1), 'start')
  assert.equal(h.streams[0].chunks.length, 2)
  h.calls[0].finish()
  h.streams[0].done.resolve()
  assert.deepEqual(await result, { ok: true })
})

function fileHarness(t) {
  const children = []
  const player = new AudioPlayer({
    resolvePlaybackPath: () => '/mock/ffplay',
    spawnProcess(_exe, args) {
      const child = new EventEmitter()
      child.args = args
      child.stdin = new PassThrough()
      child.stdout = new PassThrough()
      child.killed = false
      child.kill = () => { child.killed = true; queueMicrotask(() => child.emit('close', null)) }
      children.push(child)
      return child
    },
  })
  t.after(() => player.stop())
  return { player, children }
}

test('denied TTS handoff never writes audio bytes', async t => {
  const h = engineHarness(t)
  const result = h.engine.speak('拒绝过期交接', {
    waitForPlayback: async () => true,
    onAudioStart: () => false,
  })
  h.calls[0].chunk(Buffer.alloc(4096))
  await nextTurn()
  assert.equal((await result).aborted, true)
  assert.equal(h.streams[0].chunks.length, 0)
})

test('denied file handoff never pipes audio bytes', async t => {
  const h = fileHarness(t)
  const result = h.player.playFile(audioFile, {
    waitForPlayback: async () => true,
    onAudioStart: () => false,
  })
  const child = await awaitChild(h)
  child.emit('spawn')
  assert.equal((await result).aborted, true)
  assert.equal(child.stdin.readableLength, 0)
  assert.equal(child.killed, true)
})

async function awaitChild(h) {
  for (let i = 0; i < 100 && h.children.length === 0; i++) await nextTurn()
  assert.equal(h.children.length, 1)
  return h.children[0]
}

test('local file waits through initial and spawn-time gates; handoff fires once', async t => {
  const h = fileHarness(t)
  const first = deferred(), second = deferred()
  let checks = 0, starts = 0
  const result = h.player.playFile(audioFile, {
    waitForPlayback: () => ++checks === 1 ? first.promise : second.promise,
    onAudioStart: () => starts++,
  })
  for (let i = 0; i < 30; i++) await nextTurn()
  assert.equal(h.children.length, 0)
  first.resolve(true)
  const child = await awaitChild(h)
  assert.equal(starts, 0)
  child.emit('spawn')
  await nextTurn()
  assert.equal(checks, 2)
  assert.equal(starts, 0)
  assert.equal(child.stdin.readableLength, 0)
  second.resolve(true)
  await nextTurn()
  assert.equal(starts, 1)
  child.emit('spawn')
  assert.equal(starts, 1)
  child.emit('close', 0)
  await result
})

for (const when of ['before spawn', 'during spawn gate']) {
  test(`local file cancellation ${when} stops pending handoff`, async t => {
    const h = fileHarness(t)
    const gate = deferred()
    const external = new AbortController()
    let checks = 0, starts = 0, gateSignal
    const result = h.player.playFile(audioFile, {
      signal: external.signal,
      waitForPlayback: ({ signal }) => {
        gateSignal = signal
        return when === 'during spawn gate' && ++checks === 1 ? true : gate.promise
      },
      onAudioStart: () => starts++,
    })
    if (when === 'during spawn gate') (await awaitChild(h)).emit('spawn')
    for (let i = 0; i < 30; i++) await nextTurn()
    external.abort()
    assert.equal((await result).aborted, true)
    if (gateSignal) assert.equal(gateSignal.aborted, true)
    gate.resolve(true)
    await nextTurn()
    assert.equal(starts, 0)
    if (h.children[0]) assert.equal(h.children[0].killed, true)
  })
}

test('missing file and unsuccessful ffplay spawn never fire local handoff', async t => {
  const h = fileHarness(t)
  let starts = 0
  await assert.rejects(h.player.playFile(join(temp, 'missing.mp3'), { onAudioStart: () => starts++ }), /ENOENT/)
  assert.equal(h.children.length, 0)
  const result = h.player.playFile(audioFile, { onAudioStart: () => starts++ })
  const rejection = assert.rejects(result, /ffplay 未找到/)
  const child = await awaitChild(h)
  child.emit('error', Object.assign(new Error('not found'), { code: 'ENOENT' }))
  await rejection
  child.emit('close', -2)
  assert.equal(starts, 0)
})

test('ungated local file retains direct input path', async t => {
  const h = fileHarness(t)
  const result = h.player.playFile(audioFile)
  const child = await awaitChild(h)
  assert.equal(child.args.at(-1), audioFile)
  child.emit('spawn')
  child.emit('close', 0)
  assert.equal(await result, undefined)
})

test('TTSEngine.stop cancels speakFile readiness without a playback process', async t => {
  const h = fileHarness(t)
  const engine = new TTSEngine({})
  engine.player = h.player
  t.after(() => engine.destroy())
  let signal, starts = 0
  const result = engine.speakFile(audioFile, {
    waitForPlayback: input => { signal = input.signal; return new Promise(() => {}) },
    onAudioStart: () => starts++,
  })
  for (let i = 0; i < 100 && !signal; i++) await nextTurn()
  assert.ok(signal)
  engine.stop()
  assert.equal((await result).aborted, true)
  assert.equal(signal.aborted, true)
  assert.equal(h.children.length, 0)
  assert.equal(starts, 0)
})

test('late errors/close from replaced local file cannot clear the current player', async t => {
  const h = fileHarness(t)
  const first = h.player.playFile(audioFile)
  const old = await awaitChild(h)
  old.emit('spawn')
  const second = h.player.playFile(audioFile)
  assert.equal((await first).aborted, true)
  for (let i = 0; i < 100 && h.children.length < 2; i++) await nextTurn()
  const current = h.children[1]
  assert.ok(current)
  current.emit('spawn')
  old.emit('error', new Error('late old child error'))
  old.emit('close', 0)
  assert.equal(h.player.currentProcess, current)
  assert.equal(current.killed, false)
  current.emit('close', 0)
  await second
})

test('stopped buffer synthesis callbacks cannot invalidate a new speech job', async t => {
  const h = engineHarness(t)
  const old = h.engine.synthesizeBuffer('旧的过渡音频')
  const rejected = assert.rejects(old, /TTS playback stopped/)
  const current = h.engine.speak('新的音频')
  await rejected
  h.calls[0].finish()
  h.calls[0].error(new Error('late old buffer failure'))
  assert.equal(h.engine.activeWSCall, h.calls[1])
  h.calls[1].chunk(Buffer.from([1]))
  h.calls[1].finish()
  h.streams[0].done.resolve()
  assert.equal((await current).ok, true)
})
