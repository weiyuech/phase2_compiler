import test from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises'
import { TTSEngine } from '../src/tts/index.js'
import { SpeechCoordinator } from '../src/tts/speech-coordinator.js'
import { SentenceBufferCache, SynthesisScheduler, sentenceCacheKey } from '../src/tts/sentence-preparation.js'
import { AudioPlayer } from '../src/tts/audio-player.js'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import ffmpegStatic from 'ffmpeg-static'

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture(t, { role = 'cruise', coordinator = new SpeechCoordinator(), robot = false, router: suppliedRouter } = {}) {
  const calls = [], plays = [], preparation = [], controls = []
  const router = suppliedRouter || {
    generation: 1, isRobotDestination: () => robot,
    async prepareBuffer(buffer) {
      const handle = { buffer, released: 0, release() { this.released++ } }
      preparation.push(handle)
      return handle
    },
    async prepareFile() {
      const handle = { buffer: Buffer.from('file'), released: 0, release() { this.released++ } }
      preparation.push(handle)
      return handle
    },
  }
  const engine = new TTSEngine({
    coordinator, role, audioOutput: router, harvest: false, TTS_API_KEY: 'test',
    sentenceCache: new SentenceBufferCache({ maxBytes: 1024 }), synthesisScheduler: new SynthesisScheduler(),
  })
  engine.enabled = true
  engine.wsClient.synthesizeStream = (text, chunk, finish, error) => {
    const call = { text, aborted: false, error, chunk, finish, abort() { this.aborted = true },
      ready() { chunk(Buffer.from(text)); finish() } }
    calls.push(call)
    return call
  }
  let current
  async function play(input, opts) {
    const done = deferred()
    const entry = { text: Buffer.isBuffer(input) ? input.toString() : input.buffer.toString(), opts, done, sequenceState: opts.sequenceState }
    current = entry
    if (opts.beforePlay?.() === false || opts.onAudioStart?.() === false) return { ok: false, aborted: true }
    plays.push(entry)
    const cancel = () => done.resolve({ ok: false, aborted: true })
    opts.signal?.addEventListener('abort', cancel, { once: true })
    try { return await done.promise }
    finally { opts.signal?.removeEventListener('abort', cancel); if (current === entry) current = null }
  }
  engine.player = {
    playSentence: play, playPrepared: play,
    playFile: (_file, opts) => play(Buffer.from('local-file'), opts),
    pause() { controls.push('pause') }, resume() { controls.push('resume') },
    stop() { current?.done.resolve({ ok: false, aborted: true }); current = null },
  }
  t.after(() => engine.destroy())
  return { engine, calls, plays, preparation, coordinator, controls, router }
}

test('TTS completely prepares each sentence, prefetches only two, and emits one utterance handoff', async t => {
  const h = fixture(t)
  let starts = 0, prepared = 0
  const captions = []
  const result = h.engine.speak('一。二。三。四。', {
    utteranceId: 'utterance-test', onAudioStart: () => starts++,
    onPrepared: () => prepared++, onSentenceStart: info => captions.push(info),
  })
  await nextTurn()
  assert.equal(h.calls.length, 2)
  h.calls[0].chunk(Buffer.from('partial'))
  await nextTurn()
  assert.equal(h.plays.length, 0)
  h.calls[0].finish()
  await nextTurn()
  assert.equal(h.plays.length, 1)
  assert.equal(h.calls.length, 3)
  h.calls[1].ready(); h.calls[2].ready()
  h.plays[0].done.resolve({ ok: true })
  await nextTurn()
  assert.equal(h.calls.length, 4)
  h.calls[3].ready()
  h.plays[1].done.resolve({ ok: true })
  await nextTurn()
  h.plays[2].done.resolve({ ok: true })
  await nextTurn()
  h.plays[3].done.resolve({ ok: true })
  assert.equal((await result).completedSentences, 4)
  assert.equal(starts, 1)
  assert.equal(prepared, 1)
  assert.deepEqual(captions.map(info => info.index), [0, 1, 2, 3])
  assert.ok(captions.every(info => info.utteranceId === 'utterance-test'))
})

test('ready barrage waits for current sentence then cruise resumes exactly at next sentence', async t => {
  const coordinator = new SpeechCoordinator()
  const cruise = fixture(t, { coordinator }), barrage = fixture(t, { coordinator, role: 'barrage' })
  const cruiseResult = cruise.engine.speak('第一句。第二句。')
  await nextTurn()
  cruise.calls.forEach(call => call.ready())
  await nextTurn()
  const barrageResult = barrage.engine.speak('回答。')
  await nextTurn()
  barrage.calls[0].ready()
  await nextTurn()
  assert.equal(barrage.plays.length, 0)
  assert.equal(cruise.controls.length, 0, 'automatic handoff did not pause sentence midstream')
  cruise.plays[0].done.resolve({ ok: true })
  await nextTurn()
  assert.equal(barrage.plays.length, 1)
  assert.equal(cruise.plays.length, 1)
  barrage.plays[0].done.resolve({ ok: true })
  await barrageResult
  await nextTurn()
  assert.equal(cruise.plays[1].text, '第二句。')
  cruise.plays[1].done.resolve({ ok: true })
  assert.equal((await cruiseResult).ok, true)
})

test('a missing next sentence holds silence instead of resuming lower-priority transit', async t => {
  const coordinator = new SpeechCoordinator()
  const cruise = fixture(t, { coordinator }), transit = fixture(t, { coordinator, role: 'transit' })
  const cruiseResult = cruise.engine.speak('准备好了。尚未准备。')
  await nextTurn()
  cruise.calls[0].ready()
  await nextTurn()
  const transitResult = transit.engine.speak('过渡。')
  await nextTurn()
  transit.calls[0].ready()
  await nextTurn()
  cruise.plays[0].done.resolve({ ok: true })
  await nextTurn()
  assert.equal(cruise.plays.length, 1)
  assert.equal(transit.plays.length, 0)
  cruise.calls[1].ready()
  await nextTurn()
  cruise.plays[1].done.resolve({ ok: true })
  await cruiseResult
  await nextTurn()
  assert.equal(transit.plays.length, 1)
  transit.plays[0].done.resolve({ ok: true })
  await transitResult
})

test('failed incoming preparation never acquires or pauses current narration', async t => {
  const coordinator = new SpeechCoordinator()
  const cruise = fixture(t, { coordinator }), barrage = fixture(t, { coordinator, role: 'barrage' })
  const current = cruise.engine.speak('当前句。')
  await nextTurn(); cruise.calls[0].ready(); await nextTurn()
  const incoming = barrage.engine.speak('失败句。')
  await nextTurn(); barrage.calls[0].error(new Error('provider unavailable'))
  const failed = await incoming
  assert.equal(failed.ok, false)
  assert.equal(failed.error.message, 'provider unavailable')
  assert.equal(cruise.controls.length, 0)
  assert.equal(barrage.plays.length, 0)
  cruise.plays[0].done.resolve({ ok: true })
  await current
})

test('host interruption is immediate; pausing tour does not globally mute barrage', async t => {
  const coordinator = new SpeechCoordinator()
  const cruise = fixture(t, { coordinator }), barrage = fixture(t, { coordinator, role: 'barrage' })
  const captions = []
  const current = cruise.engine.speak('当前句。', { onSentenceStart: caption => captions.push(caption) })
  await nextTurn(); cruise.calls[0].ready(); await nextTurn()
  coordinator.setPauseReason('host', ['transit', 'cruise', 'barrage'], true)
  assert.deepEqual(cruise.controls, ['pause'])
  const incoming = barrage.engine.speak('弹幕。')
  await nextTurn(); barrage.calls[0].ready(); await nextTurn()
  assert.equal(barrage.plays.length, 0)
  coordinator.setPauseReason('tour', ['cruise', 'transit'], true)
  coordinator.setPauseReason('host', ['transit', 'cruise', 'barrage'], false)
  await nextTurn()
  assert.equal(barrage.plays.length, 1)
  barrage.plays[0].done.resolve({ ok: true }); await incoming
  assert.deepEqual(cruise.controls, ['pause'])
  coordinator.setPauseReason('tour', ['cruise', 'transit'], false)
  await nextTurn()
  assert.deepEqual(cruise.controls, ['pause', 'resume'])
  assert.equal(captions.at(-1).resumed, true)
  assert.equal(captions.at(-1).index, 0)
  cruise.plays[0].done.resolve({ ok: true }); await current
})

test('stop cancels active speech and prefetched provider calls without later restart', async t => {
  const h = fixture(t)
  const result = h.engine.speak('一。二。三。')
  await nextTurn(); h.calls[0].ready(); await nextTurn()
  h.engine.stop()
  assert.equal((await result).aborted, true)
  for (const call of h.calls) { call.ready(); call.error(new Error('late')) }
  await nextTurn()
  assert.equal(h.plays.length, 1)
  assert.equal(h.coordinator.jobs.size, 0)
})

test('generation changes invalidate reusable prepared text even after a round trip', async t => {
  const h = fixture(t)
  const preparation = h.engine.prepareText('一次。')
  await nextTurn(); h.calls[0].ready()
  const source = await preparation
  h.router.generation += 2
  const result = await h.engine.speakPreparedText(source)
  assert.equal(result.aborted, true)
  assert.equal(h.plays.length, 0)
  source.release()
})

test('robot sentences decode entirely before acquire and share one packet sequence state', async t => {
  const h = fixture(t, { robot: true })
  const result = h.engine.speak('第一句。第二句。')
  await nextTurn(); h.calls.forEach(call => call.ready()); await nextTurn()
  assert.equal(h.preparation.length, 2)
  assert.equal(h.plays.length, 1)
  h.plays[0].sequenceState.nextSeq = 55
  h.plays[0].done.resolve({ ok: true }); await nextTurn()
  assert.equal(h.plays[1].sequenceState, h.plays[0].sequenceState)
  assert.equal(h.plays[1].sequenceState.nextSeq, 55)
  h.plays[1].done.resolve({ ok: true })
  assert.equal((await result).ok, true)
  assert.ok(h.preparation.every(handle => handle.released === 1))
})

test('robot file preparation does not claim the speaker before decode completes', async t => {
  const decode = deferred()
  const handle = { released: false, buffer: Buffer.from('prepared-file'), release() { this.released = true } }
  const router = { generation: 1, isRobotDestination: () => true, prepareFile: () => decode.promise }
  const h = fixture(t, { router })
  let ready = 0, started = 0
  const result = h.engine.speakFile('/fake/file.mp3', { onPrepared: () => ready++, onAudioStart: () => started++ })
  await nextTurn()
  assert.equal(h.coordinator.jobs.size, 0)
  assert.equal(started, 0)
  decode.resolve(handle); await nextTurn()
  assert.equal(ready, 1)
  assert.equal(started, 1)
  h.plays[0].done.resolve({ ok: true })
  assert.equal((await result).ok, true)
  assert.equal(handle.released, true)
})

test('cancelled blocking gate cannot leak an old handoff or stop a replacement', async t => {
  const h = fixture(t)
  const gate = deferred()
  let oldStarts = 0
  const old = h.engine.speak('旧句。', { waitForPlayback: () => gate.promise, onAudioStart: () => oldStarts++ })
  await nextTurn(); h.calls[0].ready(); await nextTurn()
  const replacement = h.engine.speak('新句。')
  assert.equal((await old).aborted, true)
  await nextTurn(); h.calls[1].ready(); await nextTurn()
  gate.resolve(true); await nextTurn()
  assert.equal(oldStarts, 0)
  assert.equal(h.plays.length, 1)
  h.plays[0].done.resolve({ ok: true })
  assert.equal((await replacement).ok, true)
})

test('speculative failure surfaces only when needed after current sentence completes', async t => {
  const h = fixture(t)
  const result = h.engine.speak('仍然播放。下一句失败。')
  await nextTurn(); h.calls[0].ready(); await nextTurn()
  h.calls[1].error(new Error('second sentence failed'))
  await nextTurn()
  assert.equal(h.plays.length, 1)
  h.plays[0].done.resolve({ ok: true })
  const ended = await result
  assert.equal(ended.ok, false)
  assert.equal(ended.error.message, 'second sentence failed')
})

function childPlayer() {
  const children = []
  const player = new AudioPlayer({
    resolvePlaybackPath: () => '/fake/ffplay',
    spawnProcess(_executable, args) {
      const child = new EventEmitter()
      child.args = args
      child.stdin = new PassThrough()
      child.stdout = new PassThrough()
      child.kill = () => child.emit('close', null)
      children.push(child)
      return child
    },
  })
  return { player, children }
}

test('local prepared sentence withholds all bytes through startup/readiness and rejects decode failure', async () => {
  const h = childPlayer(), gate = deferred()
  let starts = 0, bytes = 0
  const playback = h.player.playSentence(Buffer.from('full-sentence'), {
    waitForPlayback: () => gate.promise, onAudioStart: () => starts++,
  })
  h.children[0].stdin.on('data', chunk => { bytes += chunk.length })
  h.children[0].emit('spawn')
  await nextTurn()
  assert.equal(bytes, 0)
  assert.equal(starts, 0)
  gate.resolve(true)
  await nextTurn()
  assert.equal(bytes, Buffer.byteLength('full-sentence'))
  assert.equal(starts, 1)
  h.children[0].emit('close', 1)
  await assert.rejects(playback, /播放失败/)
})

test('local prepared sentence abort while startup waits never hands off or writes bytes', async () => {
  const h = childPlayer(), controller = new AbortController()
  let starts = 0
  const playback = h.player.playSentence(Buffer.from('sentence'), {
    signal: controller.signal, onAudioStart: () => starts++,
  })
  controller.abort()
  assert.equal((await playback).aborted, true)
  h.children[0].emit('spawn')
  await nextTurn()
  assert.equal(starts, 0)
  assert.equal(h.children[0].stdin.readableLength, 0)
})

test('gated local M4A retains seekable file input and cancels a startup pause without handoff', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gated-m4a-test-'))
  const file = join(directory, 'clip.M4A')
  await writeFile(file, 'container-fixture')
  const h = childPlayer(), gate = deferred(), controller = new AbortController()
  let starts = 0, checks = 0
  try {
    const playback = h.player.playFile(file, {
      signal: controller.signal, waitForPlayback: () => ++checks === 1 ? true : gate.promise,
      onAudioStart: () => starts++,
    })
    for (let tries = 0; tries < 100 && !h.children.length; tries++) await delay(1)
    assert.equal(h.children[0].args.at(-1), file)
    assert.equal(h.children[0].args.includes('pipe:0'), false)
    h.children[0].emit('spawn')
    await nextTurn()
    assert.equal(starts, 0)
    controller.abort()
    assert.equal((await playback).aborted, true)
    gate.resolve(true); await nextTurn()
    assert.equal(starts, 0)
  } finally { h.player.stop(); await rm(directory, { recursive: true, force: true }) }
})

test('coordinated stop clears a prior playback pause before creating a replacement job', t => {
  const engine = new TTSEngine({ coordinator: new SpeechCoordinator(), harvest: false })
  engine.player._paused = true
  engine.stop()
  assert.equal(engine.player._paused, false)
  t.after(() => engine.destroy())
})

for (const mode of ['stop', 'external abort']) {
  test(`${mode} tears down physical playback before releasing the coordinator lease`, async t => {
    const controller = new AbortController()
    const h = fixture(t)
    const events = []
    const originalCreate = h.coordinator.createJob.bind(h.coordinator)
    h.coordinator.createJob = options => {
      options.signal.addEventListener('abort', () => events.push('lease-aborted'), { once: true })
      return originalCreate(options)
    }
    const originalStop = h.engine.player.stop
    h.engine.player.stop = () => { events.push('player-stopped'); originalStop() }
    const speaking = h.engine.speak('正在讲话。', { signal: controller.signal })
    await nextTurn(); h.calls[0].ready(); await nextTurn()
    events.length = 0
    if (mode === 'stop') h.engine.stop()
    else controller.abort()
    assert.equal((await speaking).aborted, true)
    assert.ok(events.indexOf('player-stopped') < events.indexOf('lease-aborted'))
  })
}

test('reused transit prepared text loops from sentence zero without another synthesis call', async t => {
  const h = fixture(t, { role: 'transit' })
  const preparing = h.engine.prepareText('一。二。')
  await nextTurn(); h.calls.forEach(call => call.ready())
  const source = await preparing
  for (let loop = 0; loop < 2; loop++) {
    const playback = h.engine.speakPreparedText(source, { harvest: false })
    await nextTurn()
    h.plays[loop * 2].done.resolve({ ok: true }); await nextTurn()
    h.plays[loop * 2 + 1].done.resolve({ ok: true })
    assert.equal((await playback).ok, true)
  }
  assert.deepEqual(h.plays.map(play => play.text), ['一。', '二。', '一。', '二。'])
  assert.equal(h.calls.length, 2)
  source.release()
})

for (const mode of ['stop', 'arrival']) {
  test(`${mode} of reusable transit cancels obsolete prefetch and frees synthesis for foreground speech`, async t => {
    const coordinator = new SpeechCoordinator()
    const transit = fixture(t, { coordinator, role: 'transit' })
    const barrage = fixture(t, { coordinator, role: 'barrage' })
    const scheduler = transit.engine._sentenceOptions.scheduler
    barrage.engine._sentenceOptions.scheduler = scheduler
    const preparing = transit.engine.prepareText('当前句。待合成二。待合成三。')
    await nextTurn()
    transit.calls[0].ready()
    const source = await preparing
    t.after(() => source.release())
    let arriving = false
    const playback = transit.engine.speakPreparedText(source, { shouldFinish: () => arriving })
    await nextTurn()
    assert.equal(transit.plays.length, 1)
    assert.equal(transit.calls.length, 3)
    assert.equal(scheduler.running, 2)

    const incoming = barrage.engine.speak('新的回答。')
    await nextTurn()
    assert.equal(barrage.calls.length, 0, 'both provider slots are occupied by transit prefetch')
    if (mode === 'stop') transit.engine.stop()
    else { arriving = true; transit.plays[0].done.resolve({ ok: true }) }
    const ended = await playback
    assert.equal(mode === 'stop' ? ended.aborted : ended.ok, true)
    await nextTurn()
    assert.ok(transit.calls.slice(1).every(call => call.aborted), 'unused provider calls must be aborted before waiting for their responses')
    assert.equal(source.signal.aborted, false)
    assert.equal(source.units.size, 0)
    assert.equal(barrage.calls.length, 1, 'foreground synthesis must start without obsolete calls finishing or timing out')
    for (const call of transit.calls.slice(1)) { call.ready(); call.error(new Error('late obsolete response')) }
    barrage.calls[0].ready()
    await nextTurn()
    assert.equal(barrage.plays.length, 1)
    assert.equal(transit.plays.length, 1)
    barrage.plays[0].done.resolve({ ok: true })
    assert.equal((await incoming).ok, true)
    await nextTurn()
    assert.equal(scheduler.running, 0)
    assert.equal(scheduler.queue.length, 0)
    assert.equal(coordinator.jobs.size, 0)
  })
}

for (const robot of [false, true]) {
  test(`transit arrival finishes active sentence and discards prepared remainder (${robot ? 'robot' : 'local'})`, async t => {
    const h = fixture(t, { role: 'transit', robot })
    let arriving = false, ended = false
    const playback = h.engine.speak('当前句子。剩余句子。', {
      harvest: false, shouldFinish: () => arriving,
    }).then(result => { ended = true; return result })
    await nextTurn()
    h.calls.forEach(call => call.ready())
    await nextTurn()
    assert.equal(h.plays.length, 1)
    arriving = true
    await nextTurn()
    assert.equal(ended, false, 'arrival must not cut the active player')
    assert.deepEqual(h.controls, [])
    h.plays[0].done.resolve({ ok: true })
    const result = await playback
    assert.equal(result.ok, true)
    assert.equal(result.completedSentences, 1)
    assert.deepEqual(h.plays.map(play => play.text), ['当前句子。'])
    assert.equal(h.coordinator.jobs.size, 0)
  })
}

function ffmpeg(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegStatic, ['-hide_banner', '-loglevel', 'error', ...args], { stdio: ['pipe', 'pipe', 'ignore'] })
    const chunks = []
    child.stdout.on('data', chunk => chunks.push(chunk))
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg test fixture failed (${code})`)))
    child.stdin.end(input)
  })
}

test('successful independent sentence MP3s harvest once as a decodable complete utterance', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sentence-harvest-test-'))
  const previousUserData = process.env.USER_DATA_DIR
  process.env.USER_DATA_DIR = directory
  t.after(async () => {
    if (previousUserData === undefined) delete process.env.USER_DATA_DIR
    else process.env.USER_DATA_DIR = previousUserData
    await rm(directory, { recursive: true, force: true })
  })
  const audio = await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.15', '-f', 'mp3', '-'])
  const h = fixture(t)
  h.engine.harvest = true
  h.engine._sentenceOptions.cache = new SentenceBufferCache()
  const text = '第一句。第二句。'
  const playback = h.engine.speak(text)
  await nextTurn()
  for (const call of h.calls) { call.chunk(audio); call.finish() }
  await nextTurn()
  h.plays[0].done.resolve({ ok: true }); await nextTurn()
  h.plays[1].done.resolve({ ok: true })
  assert.equal((await playback).ok, true)
  for (let tries = 0; tries < 200 && h.engine._harvests.size; tries++) await delay(10)
  assert.equal(h.engine._harvests.size, 0)
  const hash = sentenceCacheKey(text, h.engine.wsClient)
  const cache = join(directory, 'data', 'tts-cache')
  assert.deepEqual((await readdir(cache)).sort(), [`${hash}.mp3`, `${hash}.txt`])
  const bytes = await readFile(join(cache, `${hash}.mp3`))
  const pcm = await ffmpeg(['-f', 'mp3', '-i', '-', '-ac', '1', '-ar', '16000', '-f', 's16le', '-'], bytes)
  assert.ok(pcm.length > 9600, 'both independently encoded sentences survived container-safe re-encoding')
  assert.equal(await readFile(join(cache, `${hash}.txt`), 'utf8'), text)
})

test('local player retains bounded decoder/device stderr in playback failures', async () => {
  const h = childPlayer()
  // Add stderr before AudioPlayer subscribes to the new process.
  const spawn = h.player._spawnProcess
  h.player._spawnProcess = (...args) => {
    const child = spawn(...args)
    child.stderr = new PassThrough()
    return child
  }
  const stream = h.player.startStream()
  const child = h.children[0]
  assert.equal(child.args[child.args.indexOf('-loglevel') + 1], 'error')
  const failed = assert.rejects(stream.promise, error => {
    assert.match(error.message, /No audio device/)
    assert.ok(error.message.length < 4200)
    return true
  })
  child.emit('spawn')
  child.stderr.write('x'.repeat(10000))
  child.stderr.write('\nNo audio device\n')
  child.emit('close', 1)
  await failed
})
