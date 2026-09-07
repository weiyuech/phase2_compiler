import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises'
import ffmpeg from 'ffmpeg-static'
import { AudioOutputRouter } from '../src/tts/audio-output-router.js'
import { RobotListener } from '../src/robot/listener.js'
import { TTSEngine } from '../src/tts/index.js'
import { SpeechCoordinator } from '../src/tts/speech-coordinator.js'
import { SentenceBufferCache, SynthesisScheduler } from '../src/tts/sentence-preparation.js'
import { PreparedAudioCache } from '../src/tts/prepared-audio-cache.js'

function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
class Robot extends EventEmitter {
  constructor() { super(); this.frames = []; this.connected = true; this.connectionGeneration = 1 }
  isConnected() { return this.connected }
  sendAudioFrame(buffer, seq, opts) {
    this.frames.push({ buffer: Buffer.from(buffer), seq, time: performance.now() })
    opts?.onComplete?.(null, { writeMs: 0, bufferedAmount: 0 })
  }
}
async function harness(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'prepared-robot-test-'))
  const robot = new Robot()
  const events = [], packets = []
  const router = new AudioOutputRouter({ robot, filePath: join(directory, 'output.json'), ffmpegPath: ffmpeg,
    diagnostics: { event: (type, data) => events.push({ type, ...data }), packet: data => packets.push(data) }, ...options })
  router.setConfig({ destination: 'robot' })
  t.after(async () => { await router.destroy(); await rm(directory, { recursive: true, force: true }) })
  return { directory, router, robot, events, packets }
}
function fakeClock() {
  let now = 0, id = 0
  const tasks = new Map()
  return {
    now: () => now,
    schedule: (fn, delay) => { const taskId = ++id; tasks.set(taskId, { fn, at: now + delay }); return taskId },
    unschedule: taskId => tasks.delete(taskId),
    pending: () => tasks.size,
    advance(ms) {
      const until = now + ms
      for (;;) {
        const next = [...tasks.entries()].sort((a, b) => a[1].at - b[1].at)[0]
        if (!next || next[1].at > until) break
        tasks.delete(next[0]); now = Math.max(now, next[1].at); next[1].fn()
      }
      now = until
    },
    stall(ms) { now += ms },
  }
}
function fakeDecode(router, bytes = 1280) {
  let calls = 0
  router._decode = async (_source, write) => { calls++; await write(Buffer.alloc(bytes, 17)) }
  return () => calls
}

function pcm16(...samples) {
  const result = Buffer.alloc(samples.length * 2)
  samples.forEach((sample, index) => result.writeInt16LE(sample, index * 2))
  return result
}

async function until(predicate) {
  const deadline = performance.now() + 3000
  while (!predicate()) {
    assert.ok(performance.now() < deadline, 'expected asynchronous state was not reached')
    await delay(1)
  }
}

function coordinatedEngine(t, router, coordinator, role) {
  const engine = new TTSEngine({
    audioOutput: router, coordinator, role, harvest: false, TTS_API_KEY: 'test',
    sentenceCache: new SentenceBufferCache({ maxBytes: 1024 }), synthesisScheduler: new SynthesisScheduler(),
  })
  engine.enabled = true
  engine.wsClient.synthesizeStream = (text, chunk, finish) => {
    let aborted = false
    queueMicrotask(() => { if (!aborted) { chunk(Buffer.from(text)); finish() } })
    return { abort() { aborted = true } }
  }
  t.after(() => engine.destroy())
  return engine
}

test('real engine/coordinator/router hand off TTS at sentence boundary and retain utterance sequence', async t => {
  const clock = fakeClock()
  const h = await harness(t, clock)
  h.router._decode = async (source, write) => {
    const tag = source.buffer.toString().startsWith('一') ? 1 : source.buffer.toString().startsWith('二') ? 2 : 3
    await write(Buffer.alloc(2560, tag))
  }
  const coordinator = new SpeechCoordinator()
  const cruise = coordinatedEngine(t, h.router, coordinator, 'cruise')
  const barrage = coordinatedEngine(t, h.router, coordinator, 'barrage')
  const captions = []
  const cruiseResult = cruise.speak('一。二。', {
    utteranceId: 'cruise-integration', onSentenceStart: value => captions.push(value.index),
  })
  await until(() => coordinator.active?.role === 'cruise' && clock.pending() === 1)
  clock.advance(0)
  const barrageResult = barrage.speak('回答。', { utteranceId: 'barrage-integration' })
  await until(() => [...coordinator.jobs].some(job => job.role === 'barrage' && job.ready))
  assert.equal(coordinator.active.role, 'cruise')
  assert.equal(h.robot.frames.length, 1)
  clock.advance(80)
  await until(() => coordinator.active?.role === 'barrage' && clock.pending() === 1)
  assert.deepEqual(h.robot.frames.map(frame => frame.buffer[0]), [1, 1, 1, 1])
  clock.advance(80)
  assert.equal((await barrageResult).ok, true)
  await until(() => coordinator.active?.role === 'cruise' && clock.pending() === 1)
  clock.advance(80)
  assert.equal((await cruiseResult).ok, true)
  assert.deepEqual(h.robot.frames.map(frame => frame.buffer[0]), [1, 1, 1, 1, 3, 3, 3, 3, 2, 2, 2, 2])
  assert.deepEqual(h.robot.frames.filter(frame => frame.buffer[0] !== 3).map(frame => frame.seq), [1, 2, 3, 4, 5, 6, 7, 8])
  assert.deepEqual(captions, [0, 1])
  assert.ok(h.packets.some(packet => packet.utteranceId === 'cruise-integration' && packet.source === 'point'))
  assert.equal(coordinator.jobs.size, 0)
})

test('real engine/router preserve MP3 packet cursor through host pause and aborted barrage', async t => {
  const clock = fakeClock()
  const h = await harness(t, clock)
  h.router._decode = async (source, write) => write(Buffer.alloc(2560, source.filePath ? 5 : 6))
  const file = join(h.directory, 'input.mp3')
  await writeFile(file, Buffer.from('mock-decode-input'))
  const coordinator = new SpeechCoordinator()
  const cruise = coordinatedEngine(t, h.router, coordinator, 'cruise')
  const barrage = coordinatedEngine(t, h.router, coordinator, 'barrage')
  const cruiseResult = cruise.speakFile(file)
  await until(() => coordinator.active?.role === 'cruise' && clock.pending() === 1)
  clock.advance(0)
  coordinator.setPauseReason('host', ['cruise', 'transit', 'barrage'], true)
  clock.advance(1000)
  assert.equal(h.robot.frames.length, 1)
  coordinator.setPauseReason('host', ['cruise', 'transit', 'barrage'], false)
  assert.equal(clock.pending(), 1)
  const abort = new AbortController()
  const barrageResult = barrage.speak('回答。', { signal: abort.signal })
  await until(() => coordinator.active?.role === 'barrage' && clock.pending() === 1)
  clock.advance(0)
  assert.deepEqual(h.robot.frames.map(frame => frame.buffer[0]), [5, 6])
  abort.abort()
  assert.equal((await barrageResult).aborted, true)
  await until(() => coordinator.active?.role === 'cruise' && clock.pending() === 1)
  clock.advance(60)
  assert.equal((await cruiseResult).ok, true)
  assert.deepEqual(h.robot.frames.map(frame => frame.buffer[0]), [5, 6, 5, 5, 5])
  assert.deepEqual(h.robot.frames.filter(frame => frame.buffer[0] === 5).map(frame => frame.seq), [1, 2, 3, 4])
  assert.equal(coordinator.jobs.size, 0)
})

test('full file decodes before readiness with no frames; PCM equals independent ffmpeg output', async t => {
  const h = await harness(t)
  const file = join(h.directory, 'tone.mp3')
  const generation = spawnSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=713:duration=0.11', '-ac', '2', '-ar', '44100', file])
  assert.equal(generation.status, 0)
  const reference = spawnSync(ffmpeg, ['-v', 'error', '-nostdin', '-i', file, '-vn', '-f', 's16le', '-acodec', 'pcm_s16le', '-ac', '1', '-ar', '16000', 'pipe:1'])
  assert.equal(reference.status, 0)
  const prepared = await h.router.prepareFile(file)
  assert.equal(h.robot.frames.length, 0)
  assert.equal(prepared.byteLength, reference.stdout.length)
  assert.equal(prepared.durationMs, reference.stdout.length / 32)
  let starts = 0
  const session = h.router.playPrepared({}, prepared, { managed: true, onAudioStart: () => starts++ })
  prepared.release() // Active session retains its own cache lease.
  assert.equal((await session.promise).ok, true)
  assert.equal(starts, 1)
  assert.deepEqual(Buffer.concat(h.robot.frames.map(f => f.buffer)), reference.stdout)
  assert.ok(h.events.some(e => e.type === 'robot_audio_sent' && e.playbackAcknowledged === false))
})

test('legacy MP3 stream never prepares, preempts, or sends until end', async t => {
  const h = await harness(t)
  const calls = fakeDecode(h.router)
  const legacy = h.router.startMp3Stream({})
  legacy.write(Buffer.from('first'))
  legacy.write(Buffer.from('second'))
  await nextTurn()
  assert.equal(calls(), 0)
  assert.equal(h.robot.frames.length, 0)
  legacy.end()
  assert.equal((await legacy.promise).ok, true)
  assert.equal(calls(), 1)
  assert.equal(h.robot.frames.length, 2)
})

test('one monotonic timer, actual short-tail duration, and shared sentence sequence', async t => {
  const clock = fakeClock()
  const h = await harness(t, clock)
  fakeDecode(h.router, 672) // 20 ms + 1 ms, not a padded second20ms packet.
  const prepared = await h.router.prepareBuffer(Buffer.from('one sentence'))
  const sequenceState = { nextSeq: 7 }
  const session = h.router.playPrepared({}, prepared, { managed: true, sequenceState })
  await session.ready
  assert.equal(clock.pending(), 1)
  clock.advance(0)
  assert.equal(h.robot.frames.length, 1)
  assert.equal(clock.pending(), 1)
  clock.advance(19)
  assert.equal(h.robot.frames.length, 1)
  clock.advance(1)
  assert.equal(h.robot.frames.length, 2)
  assert.equal(session.isActive(), true)
  clock.advance(1)
  assert.equal((await session.promise).ok, true)
  assert.deepEqual(h.robot.frames.map(f => f.seq), [7, 8])
  const second = h.router.playPrepared({}, prepared, { managed: true, sequenceState })
  await second.ready
  clock.advance(21)
  await second.promise
  assert.deepEqual(h.robot.frames.map(f => f.seq), [7, 8, 9, 10])
  assert.equal(sequenceState.nextSeq, 11)
  prepared.release()
})

test('robot volume defaults legacy config to 100 and validates and persists its own setting', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'robot-volume-config-test-'))
  await writeFile(join(directory, 'output.json'), JSON.stringify({ destination: 'robot' }))
  const robot = new Robot()
  const router = new AudioOutputRouter({ robot, filePath: join(directory, 'output.json'), ffmpegPath: ffmpeg })
  t.after(async () => { await router.destroy(); await rm(directory, { recursive: true, force: true }) })
  assert.deepEqual(router.getConfig(), { destination: 'robot', robotVolumePercent: 100 })
  const generation = router.generation
  assert.deepEqual(router.setConfig({ robotVolumePercent: 73 }), { destination: 'robot', robotVolumePercent: 73 })
  assert.equal(router.generation, generation)
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'output.json'), 'utf8')),
    { destination: 'robot', robotVolumePercent: 73 })
  for (const robotVolumePercent of [-1, 20.5, 151, '100']) {
    assert.throws(() => router.setConfig({ robotVolumePercent }), /0 到 150/)
  }
  router.setConfig({ destination: 'local' })
  const localGeneration = router.generation
  router.setConfig({ robotVolumePercent: 40 })
  assert.equal(router.generation, localGeneration, 'local playback generation is not affected by robot volume')
})

test('robot gain is exact at 100 percent and handles zero, half and saturated boost without mutating prepared PCM', async t => {
  const clock = fakeClock()
  const h = await harness(t, clock)
  const original = pcm16(10000, -10000, 30000, -30000, 12345)
  h.router._decode = async (_source, write) => write(original)
  const prepared = await h.router.prepareBuffer(Buffer.from('volume-source'))

  async function playAt(percent) {
    h.robot.frames = []
    h.router.setConfig({ robotVolumePercent: percent })
    const session = h.router.playPrepared({}, prepared, { managed: true })
    await session.ready
    clock.advance(prepared.durationMs)
    await session.promise
    return Buffer.concat(h.robot.frames.map(frame => frame.buffer))
  }

  assert.deepEqual(await playAt(100), original)
  assert.deepEqual(await playAt(0), pcm16(0, 0, 0, 0, 0))
  assert.deepEqual(await playAt(50), pcm16(5000, -5000, 15000, -15000, 6173))
  assert.deepEqual(await playAt(150), pcm16(15000, -15000, 32767, -32768, 18518))
  assert.deepEqual(original, pcm16(10000, -10000, 30000, -30000, 12345))
  assert.equal(h.packets.filter(packet => packet.stage === 'scheduled_send').at(-1).clippedSamples, 2)
  prepared.release()
})

test('active robot volume update ramps for 100ms without cancelling or resetting sequence', async t => {
  const clock = fakeClock()
  const h = await harness(t, clock)
  const samples = Array.from({ length: 3200 }, () => 10000)
  h.router._decode = async (_source, write) => write(pcm16(...samples))
  const prepared = await h.router.prepareBuffer(Buffer.from('ramp-source'))
  const session = h.router.playPrepared({}, prepared, { managed: true })
  await session.ready
  clock.advance(0)
  const generation = h.router.generation
  h.router.setConfig({ destination: 'robot', robotVolumePercent: 0 })
  assert.equal(h.router.generation, generation)
  assert.equal(session.isActive(), true)
  clock.advance(40)
  session.pause('host')
  const beforePause = h.robot.frames.length
  clock.advance(500)
  assert.equal(h.robot.frames.length, beforePause, 'volume ramp must not advance while playback is paused')
  session.resume('host')
  clock.advance(80)
  assert.equal(session.isActive(), true)
  assert.deepEqual(h.robot.frames.map(frame => frame.seq), [1, 2, 3, 4, 5, 6, 7, 8])
  assert.equal(h.robot.frames[0].buffer.readInt16LE(0), 10000)
  assert.equal(h.robot.frames[1].buffer.readInt16LE(0), 10000)
  assert.ok(h.robot.frames[5].buffer.readInt16LE(638) < 10)
  assert.ok(h.robot.frames[6].buffer.every(byte => byte === 0))
  clock.advance(60)
  assert.equal((await session.promise).ok, true)
  assert.deepEqual(h.robot.frames.map(frame => frame.seq), Array.from({ length: 10 }, (_, index) => index + 1))
  assert.ok(h.events.some(event => event.type === 'robot_volume_change' && event.robotVolumePercent === 0 && event.ramped))
  prepared.release()
})

test('a stall over 200ms rebases before sending and never bursts a second packet', async t => {
  const clock = fakeClock()
  const h = await harness(t, clock)
  fakeDecode(h.router, 2560)
  const prepared = await h.router.prepareBuffer(Buffer.from('stall'))
  const session = h.router.playPrepared({}, prepared, { managed: true })
  await session.ready
  clock.advance(0)
  clock.stall(500)
  clock.advance(0)
  assert.equal(h.robot.frames.length, 2)
  assert.equal(clock.pending(), 1)
  assert.equal(h.packets.find(packet => packet.stage === 'scheduled_send' && packet.seq === 2).latenessMs, 480)
  clock.advance(19)
  assert.equal(h.robot.frames.length, 2)
  clock.advance(41)
  assert.equal((await session.promise).ok, true)
  assert.equal(h.robot.frames.length, 4)
  prepared.release()
})

test('late final short packet keeps its actual PCM tail before completing the sentence', async t => {
  const clock = fakeClock()
  const h = await harness(t, clock)
  fakeDecode(h.router, 672)
  const prepared = await h.router.prepareBuffer(Buffer.from('late-tail'))
  const session = h.router.playPrepared({}, prepared, { managed: true })
  await session.ready
  clock.advance(0)
  clock.stall(25)
  clock.advance(0)
  assert.deepEqual(h.robot.frames.map(frame => frame.buffer.length), [640, 32])
  assert.equal(session.isActive(), true, '25ms deadline cannot consume a tail only sent at25ms')
  clock.advance(0.5)
  assert.equal(session.isActive(), true)
  clock.advance(0.5)
  assert.equal((await session.promise).ok, true)
  prepared.release()
})

test('short-stall catch-up packets accumulate PCM duration in the sender completion estimate', async t => {
  const clock = fakeClock()
  const h = await harness(t, clock)
  fakeDecode(h.router, 2560)
  const prepared = await h.router.prepareBuffer(Buffer.from('catch-up-tail'))
  const session = h.router.playPrepared({}, prepared, { managed: true })
  await session.ready
  clock.advance(0)
  clock.stall(85)
  clock.advance(0)
  assert.equal(h.robot.frames.length, 4)
  assert.equal(session.isActive(), true)
  clock.advance(59)
  assert.equal(session.isActive(), true, 'three catch-up frames require60ms of PCM duration')
  clock.advance(1)
  assert.equal((await session.promise).ok, true)
  prepared.release()
})

test('pause reasons retain PCM/sequence; managed finish does not restore another source', async t => {
  const clock = fakeClock()
  const h = await harness(t, clock)
  fakeDecode(h.router, 1920)
  const prepared = await h.router.prepareBuffer(Buffer.from('long'))
  const lower = h.router.playPrepared({ source: 'cruise' }, prepared, { managed: true })
  await lower.ready; clock.advance(0)
  lower.pause('host'); lower.pause('barrage')
  clock.advance(200)
  lower.resume('host')
  assert.equal(clock.pending(), 0)
  const higher = h.router.playPrepared({ source: 'barrage' }, prepared, { managed: true })
  await higher.ready; clock.advance(60); await higher.promise
  assert.equal(lower.paused, true)
  const afterHigher = h.robot.frames.length
  clock.advance(100)
  assert.equal(h.robot.frames.length, afterHigher)
  lower.resume('barrage'); clock.advance(40); await lower.promise
  assert.deepEqual(h.robot.frames.slice(-2).map(f => f.seq), [2, 3])
  prepared.release()
})

test('managed ownership conflict cannot interleave audio', async t => {
  const clock = fakeClock()
  const h = await harness(t, clock)
  fakeDecode(h.router, 1280)
  const prepared = await h.router.prepareBuffer(Buffer.from('clip'))
  const first = h.router.playPrepared({}, prepared, { managed: true })
  await first.ready; clock.advance(0)
  const conflict = h.router.playPrepared({}, prepared, { managed: true })
  const rejected = assert.rejects(conflict.promise, { code: 'AUDIO_OWNERSHIP_CONFLICT' })
  await conflict.ready; clock.advance(0); await rejected
  assert.equal(h.robot.frames.length, 1)
  first.stop(); prepared.release()
})

test('denied or stale first-frame handoff never sends a packet', async t => {
  const h = await harness(t)
  fakeDecode(h.router)
  const prepared = await h.router.prepareBuffer(Buffer.from('clip'))
  let starts = 0
  const denied = h.router.playPrepared({}, prepared, { beforePlay: () => false, onAudioStart: () => starts++ })
  assert.equal((await denied.promise).aborted, true)
  const vetoed = h.router.playPrepared({}, prepared, { onAudioStart: () => false })
  assert.equal((await vetoed.promise).aborted, true)
  assert.equal(starts, 0)
  assert.equal(h.robot.frames.length, 0)
  prepared.release()
})

for (const change of ['output-roundtrip', 'socket-replacement', 'disconnect']) {
  test(`${change} invalidates prepared handles and cancels active sessions`, async t => {
    const clock = fakeClock()
    const h = await harness(t, clock)
    fakeDecode(h.router)
    const prepared = await h.router.prepareBuffer(Buffer.from('clip'))
    const generation = h.router.generation
    const session = h.router.playPrepared({}, prepared)
    const rejected = assert.rejects(session.promise)
    await session.ready
    if (change === 'output-roundtrip') {
      h.router.setConfig({ destination: 'local' }); h.router.setConfig({ destination: 'robot' })
    } else if (change === 'socket-replacement') {
      h.robot.connectionGeneration++; h.robot.emit('connected')
    } else { h.robot.connected = false; h.robot.emit('disconnected') }
    await rejected
    assert.ok(h.router.generation > generation)
    assert.throws(() => h.router.playPrepared({}, prepared))
    clock.advance(100)
    assert.equal(h.robot.frames.length, 0)
    prepared.release()
  })
}

test('cached immutable assets share leases, evict unused only, and count disk/read-ahead within bounds', async t => {
  const h = await harness(t, { cacheMemoryBytes: 2560, cacheDiskBytes: 4096 })
  const calls = fakeDecode(h.router, 2048)
  const first = await h.router.prepareBuffer(Buffer.from('one'))
  const shared = await h.router.prepareBuffer(Buffer.from('one'))
  assert.equal(first.storage, 'disk')
  assert.equal(calls(), 1)
  const second = await h.router.prepareBuffer(Buffer.from('two'))
  await assert.rejects(h.router.prepareBuffer(Buffer.from('three')), { code: 'AUDIO_CACHE_LIMIT' })
  first.release(); shared.release()
  const third = await h.router.prepareBuffer(Buffer.from('three'))
  assert.ok(h.router.getCacheStats().diskBytes <= 4096)
  const session = h.router.playPrepared({}, second)
  await session.ready
  assert.ok(h.router.getCacheStats().memoryBytes <= 2560)
  assert.equal((await session.promise).ok, true)
  assert.equal(Buffer.concat(h.robot.frames.map(f => f.buffer)).length, 2048)
  assert.equal(h.router.getCacheStats().memoryBytes, 0)
  second.release(); third.release()
})

test('concurrent duplicate preparation cannot leak untracked RAM or disk reservations', async t => {
  const h = await harness(t, { cacheMemoryBytes: 8192, cacheDiskBytes: 8192 })
  const bothWritten = deferred(), finish = deferred()
  let decodes = 0, written = 0
  h.router._decode = async (_source, write) => {
    decodes++
    await write(Buffer.alloc(1280))
    if (++written === 2) bothWritten.resolve()
    await finish.promise
  }
  const results = Array.from({ length: 3 }, () => h.router.prepareBuffer(Buffer.from('same')))
  for (const result of results) result.catch(() => {})
  try {
    // Force two real decodes to overlap; three ordinary cache hits would not
    // exercise duplicate spool cleanup or the reserved decode slot transfer.
    await bothWritten.promise
    finish.resolve()
    await Promise.all(results)
    assert.equal(decodes, 2)
    assert.equal(h.router.getCacheStats().entries, 1)
    assert.equal(h.router.getCacheStats().memoryBytes, 1280)
    assert.equal(h.router.getCacheStats().diskBytes, 0)
  } finally {
    finish.resolve()
    for (const result of await Promise.allSettled(results)) {
      if (result.status === 'fulfilled') result.value.release()
    }
  }
})

test('duplicate cleanup failure rolls back the retained winner before rejecting preparation', async t => {
  const h = await harness(t, { cacheMemoryBytes: 2560, cacheDiskBytes: 8192 })
  const firstWritten = deferred(), secondWritten = deferred()
  const finishFirst = deferred(), finishSecond = deferred()
  const firstInput = Buffer.from('same'), secondInput = Buffer.from('same')
  h.router._decode = async (source, write) => {
    assert.ok(source.buffer === firstInput || source.buffer === secondInput)
    const isFirst = source.buffer === firstInput
    await write(Buffer.alloc(2048))
    const written = isFirst ? firstWritten : secondWritten
    written.resolve()
    await (isFirst ? finishFirst.promise : finishSecond.promise)
  }
  const results = []
  try {
    const firstResult = h.router.prepareBuffer(firstInput)
    results.push(firstResult)
    firstResult.catch(() => {})
    // File-open completion is not FIFO on Windows. Establish which request
    // owns the first gate before launching another identical preparation.
    await firstWritten.promise
    const secondResult = h.router.prepareBuffer(secondInput)
    results.push(secondResult)
    secondResult.catch(() => {})
    await secondWritten.promise
    finishFirst.resolve()
    const first = await firstResult
    const cache = h.router._cache
    const winner = [...cache.entries.values()][0]
    const unlink = cache._unlink.bind(cache)
    let denied = false
    cache._unlink = async path => {
      if (path !== winner.path && !denied) {
        denied = true
        throw Object.assign(new Error('simulated temporary cleanup denial'), { code: 'EPERM' })
      }
      return unlink(path)
    }
    finishSecond.resolve()
    await assert.rejects(secondResult, { code: 'EPERM' })
    assert.equal(denied, true)
    assert.equal(winner.refs, 1, 'only the successfully returned handle owns a reference')
    first.release()
    assert.equal(winner.refs, 0)
    assert.equal(cache.stats().diskBytes, 2048)
  } finally {
    // A failed assertion must not leave the fake decoder blocking destroy().
    finishFirst.resolve()
    finishSecond.resolve()
    for (const result of await Promise.allSettled(results)) {
      if (result.status === 'fulfilled') result.value.release()
    }
  }
})

test('failed initial ownership write closes and removes only its newly-created partial lock', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pcm-owner-failure-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  let failedLock
  class WriteFailureCache extends PreparedAudioCache {
    async _writeOwnerLock(lock) {
      failedLock = lock
      await lock.writeFile('{"kind":')
      throw Object.assign(new Error('simulated ownership write failure'), { code: 'ENOSPC' })
    }
  }
  const failed = new WriteFailureCache({ directory })
  await assert.rejects(failed._ready, { code: 'ENOSPC' })
  await assert.rejects(failedLock.stat(), { code: 'EBADF' })
  assert.deepEqual(await readdir(directory), [])
  await failed.close()
  const recovered = new PreparedAudioCache({ directory })
  await recovered._ready
  await recovered.close()
  assert.deepEqual(await readdir(directory), [])
})

test('cache hit cannot retain a disk entry while eviction is unlinking it', async t => {
  const h = await harness(t, { cacheMemoryBytes: 2560, cacheDiskBytes: 2048 })
  fakeDecode(h.router, 2048)
  const first = await h.router.prepareBuffer(Buffer.from('one'))
  first.release()
  const cache = h.router._cache
  const oldEntry = [...cache.entries.values()][0]
  const oldPath = oldEntry.path
  const unlinkStarted = deferred(), allowUnlink = deferred()
  const unlink = cache._unlink.bind(cache)
  let delayed = false
  cache._unlink = async path => {
    if (path === oldPath && !delayed) {
      delayed = true
      unlinkStarted.resolve()
      await allowUnlink.promise
    }
    return unlink(path)
  }
  const replacement = h.router.prepareBuffer(Buffer.from('two'))
  const results = [replacement]
  replacement.catch(() => {})
  try {
    await unlinkStarted.promise
    const lookupStarted = deferred()
    const cached = cache._cached.bind(cache)
    cache._cached = key => {
      const result = cached(key)
      lookupStarted.resolve()
      return result
    }
    let settled = false
    const reacquired = h.router.prepareBuffer(Buffer.from('one')).finally(() => { settled = true })
    results.push(reacquired)
    reacquired.catch(() => {})
    await lookupStarted.promise
    assert.equal(oldEntry.refs, 0, 'lookup cannot retain an entry being evicted')
    assert.equal(settled, false, 'cache lookup waits behind the eviction transaction')
    allowUnlink.resolve()
    const second = await replacement
    await assert.rejects(reacquired, { code: 'AUDIO_CACHE_LIMIT' })
    const session = h.router.playPrepared({}, second)
    assert.equal((await session.promise).ok, true)
    assert.equal(h.router.getCacheStats().diskBytes, 2048)
  } finally {
    allowUnlink.resolve()
    for (const result of await Promise.allSettled(results)) {
      if (result.status === 'fulfilled') result.value.release()
    }
  }
})

test('destroy cancels pending decode/queued jobs before removing cache ownership', async t => {
  const h = await harness(t, { decodeConcurrency: 1 })
  const started = deferred(), exited = deferred()
  h.router._decode = async (_source, write, signal) => {
    await write(Buffer.alloc(640))
    started.resolve()
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
    await nextTurn() // Model decoder teardown after cancellation.
    exited.resolve()
    throw Object.assign(new Error('cancelled'), { name: 'AbortError' })
  }
  const first = h.router.prepareBuffer(Buffer.from('first'))
  const rejectedFirst = assert.rejects(first)
  await started.promise
  const queued = deferred()
  const cache = h.router._cache
  const decodeSlot = cache._decodeSlot.bind(cache)
  cache._decodeSlot = signal => {
    const result = decodeSlot(signal)
    if (cache._decodeWaiters.length === 1) queued.resolve()
    return result
  }
  const second = h.router.prepareBuffer(Buffer.from('queued'))
  const rejectedSecond = assert.rejects(second)
  await queued.promise
  await h.router.destroy()
  await exited.promise
  await Promise.all([rejectedFirst, rejectedSecond])
  assert.deepEqual(await readdir(join(h.directory, 'robot-pcm-cache')), [])
  assert.equal(h.robot.frames.length, 0)
})

test('audio send disables compression, reports callback timing, and enforces backlog/generation', () => {
  const robot = new RobotListener()
  let options, callback, raw, metric
  robot._socket = { readyState: 1, bufferedAmount: 3, send(message, opts, cb) { raw = message; options = opts; callback = cb } }
  robot.sendAudioFrame(Buffer.alloc(640), 1, { generation: 0, onComplete: (err, data) => { assert.equal(err, null); metric = data } })
  assert.deepEqual(options, { compress: false })
  assert.equal(JSON.parse(raw).audio.sample, '16')
  callback(null)
  assert.ok(metric.writeMs >= 0)
  assert.equal(metric.bufferedAmount, 3)
  robot._socket.bufferedAmount = 256 * 1024 + 1
  assert.throws(() => robot.sendAudioFrame(Buffer.alloc(640), 2), /积压/)
  robot._socket.bufferedAmount = 0
  robot.connectionGeneration++
  assert.throws(() => robot.sendAudioFrame(Buffer.alloc(640), 2, { generation: 0 }), /更换/)
})

test('robot connection changes do not invalidate local sentence generation', async t => {
  const h = await harness(t)
  h.router.setConfig({ destination: 'local' })
  const before = h.router.generation
  h.robot.emit('connected')
  h.robot.emit('disconnected')
  assert.equal(h.router.generation, before)
})

test('expected pauses reset packet-gap baseline and correlate transport with utterance', async t => {
  const clock = fakeClock()
  const h = await harness(t, clock)
  fakeDecode(h.router)
  const clip = await h.router.prepareBuffer(Buffer.from('clip'))
  const session = h.router.playPrepared({}, clip, { managed: true, utteranceId: 'utterance-test', role: 'cruise' })
  await session.ready; clock.advance(0)
  session.pause('host'); clock.advance(1000); session.resume('host'); clock.advance(20)
  await session.promise
  const sent = h.packets.filter(p => p.stage === 'scheduled_send')
  assert.equal(sent[1].gapMs, null)
  assert.equal(sent[1].utteranceId, 'utterance-test')
  assert.equal(sent[1].source, 'point')
  const lifecycle = h.events.filter(e => ['pause', 'resume'].includes(e.type))
  assert.deepEqual(lifecycle.map(e => e.sessionId), [session.id, session.id])
  clip.release()
})

test('abort listener order cannot prevent managed lower-source resumption', async t => {
  const clock = fakeClock()
  const h = await harness(t, clock)
  fakeDecode(h.router)
  const clip = await h.router.prepareBuffer(Buffer.from('clip'))
  const lower = h.router.playPrepared({}, clip, { managed: true })
  await lower.ready; clock.advance(0); lower.pause()
  const signal = new AbortController()
  let resumeError
  // Coordinator listener is installed first, as in real engine integration.
  signal.signal.addEventListener('abort', () => { try { lower.resume() } catch (err) { resumeError = err } })
  const upper = h.router.playPrepared({}, clip, { managed: true, signal: signal.signal })
  await upper.ready; clock.advance(0)
  signal.abort()
  assert.equal((await upper.promise).aborted, true)
  assert.equal(resumeError, undefined)
  clock.advance(40) // Two lower-source packets sent at the same clock instant.
  assert.equal((await lower.promise).ok, true)
  clip.release()
})
