import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import ffmpeg from 'ffmpeg-static'
import { createSpeechServices } from '../src/config/speech-services.js'
import { registerTourControls } from '../src/task/ui-controls.js'
import { StationarySpeech } from '../src/task/stationary-speech.js'
import { AudioOutputRouter } from '../src/tts/audio-output-router.js'
import { SpeechCoordinator } from '../src/tts/speech-coordinator.js'
import { SentenceBufferCache, SynthesisScheduler } from '../src/tts/sentence-preparation.js'

function convert(args, input) {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...args], {
    input, timeout: 2500, maxBuffer: 1024 * 1024, windowsHide: true,
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr.toString())
  return result.stdout
}

// The provider response is a real MP3. Independently decode its reference PCM;
// neither this oracle nor the robot route substitutes the production decoder.
const mp3 = convert(['-f', 'lavfi', '-i', 'sine=frequency=713:duration=0.12',
  '-ac', '2', '-ar', '24000', '-f', 'mp3', 'pipe:1'])
const expectedPcm = convert(['-f', 'mp3', '-i', 'pipe:0', '-vn', '-ac', '1',
  '-ar', '16000', '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1'], mp3)
assert.ok(expectedPcm.length > 640)

class FakeEndpoint extends EventEmitter {
  constructor() { super(); this.frames = []; this.connectionGeneration = 1 }
  isConnected() { return true }
  sendAudioFrame(buffer, seq, options) {
    this.frames.push({ buffer: Buffer.from(buffer), seq })
    options?.onComplete?.(null, { writeMs: 0, bufferedAmount: 0 })
  }
}

async function until(predicate) {
  const deadline = performance.now() + 2500
  while (!predicate()) {
    assert.ok(performance.now() < deadline, 'Audio state did not settle within 2.5 seconds')
    await delay(2)
  }
}

// Only the local ffplay process/device is mocked. The real AudioPlayer still
// handles startup, cancellation, complete MP3 writes and playback completion.
function mockLocalDevice(engine, writes) {
  engine.player._resolvePlaybackPath = () => '/synthetic/ffplay'
  engine.player._spawnProcess = (_path, args) => {
    assert.deepEqual(args.slice(-3), ['-f', 'mp3', '-'])
    const child = new EventEmitter()
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    const chunks = []
    let closed = false
    const close = () => {
      if (closed) return
      closed = true
      child.emit('close', 0)
    }
    child.stdin.on('data', chunk => chunks.push(Buffer.from(chunk)))
    child.stdin.on('finish', () => {
      if (!closed) writes.push({ role: engine.role, buffer: Buffer.concat(chunks) })
      queueMicrotask(close)
    })
    child.kill = close
    queueMicrotask(() => { if (!closed) child.emit('spawn') })
    return child
  }
}

async function fixture(t, { destination = 'robot', blankCruise = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'stationary-audio-test-'))
  const cacheDirectory = join(directory, 'robot-pcm-cache')
  await mkdir(cacheDirectory)
  const ownerPath = join(cacheDirectory, 'owner.json')
  const legacyOwner = JSON.stringify({ kind: 'robot-pcm-cache-v1', pid: process.pid, nonce: 'legacy-live-owner' })
  await writeFile(ownerPath, legacyOwner)
  const endpoint = new FakeEndpoint()
  const coordinator = new SpeechCoordinator()
  const router = new AudioOutputRouter({ robot: endpoint, filePath: join(directory, 'output.json'), cacheDirectory })
  router.setConfig({ destination, robotVolumePercent: 100 })
  const services = createSpeechServices({ audioOutput: router, coordinator, env: {
    SPEECH_PROFILES_VERSION: '1',
    TTS_API_KEY: blankCruise ? '' : 'synthetic-cruise-key',
    TTS_VOICE_TYPE: blankCruise ? '' : 'synthetic-cruise-voice',
    TRANSIT_TTS_API_KEY: 'synthetic-transit-key',
    TRANSIT_TTS_VOICE_TYPE: 'synthetic-transit-voice',
  } })
  const calls = [], localWrites = [], events = [], handlers = new Map()
  const provider = { hold: false }
  const engines = [services.tts, services.transitTts, services.barrageTts]
  for (const engine of engines) {
    // Keep each test independent of the process-wide compressed sentence cache.
    engine._sentenceOptions = { cache: new SentenceBufferCache(), scheduler: new SynthesisScheduler() }
    engine.wsClient.synthesizeStream = function (text, chunk, finish) {
      const call = {
        text, key: this.apiKey, voice: this.voiceType,
        headerKey: this._headers('synthetic-request')['X-Api-Key'],
        aborted: false,
        abort() { this.aborted = true },
        // Also used after cancellation to exercise stale provider callbacks.
        emit() { chunk(mp3.subarray(0, 100)); chunk(mp3.subarray(100)); finish() },
      }
      calls.push(call)
      if (!provider.hold) queueMicrotask(() => { if (!call.aborted) call.emit() })
      return call
    }
    if (destination === 'local') mockLocalDevice(engine, localWrites)
  }
  // Manual library harvesting is orthogonal here and must not write app data.
  // Stationary keeps its production default and suppresses harvest per utterance.
  services.manualTts.harvest = false
  const controls = registerTourControls({
    uiBridge: { on: (name, handler) => handlers.set(name, handler), broadcast: (type, data) => events.push({ type, data }) },
    tour: { isRunning: false, isPaused: false },
    tts: services.manualTts, stationaryTts: services.stationaryTts,
    stationaryLlm: { rewriteStationary: async text => ({ text }) },
    logger: { log() {}, error() {} },
  })
  assert.ok(controls.stationary instanceof StationarySpeech)
  t.after(async () => {
    try {
      controls.stationary.stop()
      coordinator.cancelAll()
      engines.forEach(engine => engine.destroy())
      await controls.stationary.finished
      await router.destroy()
      assert.equal(await readFile(ownerPath, 'utf8'), legacyOwner, 'Legacy live ownership metadata must remain untouched')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  return { router, endpoint, coordinator, services, calls, localWrites, controls, events, provider,
    invoke: (name, value) => handlers.get(name)(value) }
}

for (const destination of ['local', 'robot']) {
  test(`stationary cruise and manual transit profiles reach the real ${destination} audio route${destination === 'local' ? ' (device mocked)' : ''}`, { timeout: 5000 }, async t => {
    const h = await fixture(t, { destination })
    h.invoke('onStartStationarySpeech', { text: '原地完整句。', loop: false })
    await h.controls.stationary.finished
    assert.equal(h.controls.snapshot().state, 'completed')
    assert.deepEqual(h.calls.map(({ text, key, voice, headerKey }) => ({ text, key, voice, headerKey })), [{
      text: '原地完整句。', key: 'synthetic-cruise-key', voice: 'synthetic-cruise-voice', headerKey: 'synthetic-cruise-key',
    }])
    assert.ok(h.events.some(event => event.type === 'STATIONARY_SPEECH_STATE' && event.data.state === 'playing'))
    assert.equal(h.services.stationaryTts._harvests.size, 0)
    if (destination === 'robot') {
      assert.deepEqual(Buffer.concat(h.endpoint.frames.map(frame => frame.buffer)), expectedPcm)
      assert.deepEqual(h.endpoint.frames.map(frame => frame.seq), h.endpoint.frames.map((_, i) => i + 1))
      assert.equal(h.router.getCacheStats().entries, 1)
    } else {
      assert.deepEqual(h.localWrites, [{ role: 'cruise', buffer: mp3 }])
      assert.equal(h.endpoint.frames.length, 0)
    }
    const firstFrames = h.endpoint.frames.length
    await h.invoke('onTestSpeech', '手动完整句。')
    assert.deepEqual(h.calls[1] && [h.calls[1].text, h.calls[1].key, h.calls[1].voice, h.calls[1].headerKey],
      ['手动完整句。', 'synthetic-transit-key', 'synthetic-transit-voice', 'synthetic-transit-key'])
    assert.equal(h.calls.length, 2)
    assert.ok(h.events.some(event => event.type === 'TEST_SPEECH_STATUS' && event.data.state === 'completed'))
    if (destination === 'robot') {
      assert.deepEqual(Buffer.concat(h.endpoint.frames.slice(firstFrames).map(frame => frame.buffer)), expectedPcm)
    } else assert.deepEqual(h.localWrites[1], { role: 'transit', buffer: mp3 })
    assert.equal(h.coordinator.jobs.size, 0)
    assert.equal(h.controls.snapshot().manualActive, false)
  })
}

test('robot loop stop cancels later frames, iterations and late provider callbacks', { timeout: 5000 }, async t => {
  const h = await fixture(t)
  h.invoke('onStartStationarySpeech', { text: '循环完整句。', loop: true })
  await until(() => h.controls.snapshot().iteration === 2 && h.controls.snapshot().state === 'playing')
  assert.ok(h.endpoint.frames.length > Math.ceil(expectedPcm.length / 640), 'The second iteration must have started sending')
  await h.invoke('onTestSpeech', '不能插入的手动句。')
  assert.equal(h.controls.canStartTour(), false)
  assert.ok(h.calls.every(call => call.text === '循环完整句。'), 'Conflicting manual speech must not reach the provider')
  h.invoke('onStopStationarySpeech')
  await h.controls.stationary.finished
  assert.equal(h.controls.snapshot().state, 'cancelled')
  const stoppedFrames = h.endpoint.frames.length
  const stoppedCalls = h.calls.length
  await delay(320) // Longer than the production loop gap; no third iteration.
  assert.equal(h.endpoint.frames.length, stoppedFrames)
  assert.equal(h.calls.length, stoppedCalls)
  assert.equal(h.controls.snapshot().iteration, 2)

  h.provider.hold = true
  h.invoke('onStartStationarySpeech', { text: '等待合成后取消。', loop: true })
  await until(() => h.calls.length === stoppedCalls + 1)
  const pending = h.calls.at(-1)
  h.invoke('onStopStationarySpeech')
  await h.controls.stationary.finished
  assert.equal(pending.aborted, true)
  pending.emit() // A late provider completion must not reanimate cancelled audio.
  await delay(320)
  assert.equal(h.endpoint.frames.length, stoppedFrames)
  assert.equal(h.calls.length, stoppedCalls + 1)
  assert.equal(h.controls.snapshot().state, 'cancelled')
  assert.equal(h.coordinator.jobs.size, 0)
})

test('blank cruise credentials fail stationary speech without borrowing configured manual credentials', { timeout: 5000 }, async t => {
  const h = await fixture(t, { destination: 'local', blankCruise: true })
  h.invoke('onStartStationarySpeech', { text: '必须失败。', loop: true })
  await h.controls.stationary.finished
  assert.equal(h.controls.snapshot().state, 'failed')
  assert.match(h.controls.snapshot().message, /巡游讲解/)
  assert.equal(h.calls.length, 0)
  assert.equal(h.localWrites.length, 0)
  await h.invoke('onTestSpeech', '手动仍然可用。')
  assert.deepEqual(h.calls.map(call => [call.key, call.voice]), [['synthetic-transit-key', 'synthetic-transit-voice']])
  assert.deepEqual(h.localWrites, [{ role: 'transit', buffer: mp3 }])
  assert.equal(h.controls.snapshot().state, 'failed', 'Manual success must not restart the failed stationary loop')
})
