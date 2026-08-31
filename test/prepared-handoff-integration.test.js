import test from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { TTSEngine } from '../src/tts/index.js'
import { SpeechCoordinator } from '../src/tts/speech-coordinator.js'
import { SentenceBufferCache, SynthesisScheduler } from '../src/tts/sentence-preparation.js'
import { TransitAudioManager } from '../src/transit/manager.js'
import { createPointNarrator } from '../src/task/point-narrator.js'

function deferred() {
  let resolve
  return { promise: new Promise(r => { resolve = r }), resolve: value => resolve(value) }
}
async function until(predicate) {
  for (let n = 0; n < 100; n++) { if (predicate()) return; await nextTurn() }
  assert.fail('handoff did not reach expected state')
}
function setup(t, robot) {
  const coordinator = new SpeechCoordinator(), events = []
  const router = {
    generation: 0, isRobotDestination: () => robot,
    prepareBuffer: async buffer => ({ buffer, release() {} }),
  }
  const scheduler = new SynthesisScheduler(), cache = new SentenceBufferCache()
  const engine = role => {
    const tts = new TTSEngine({ role, coordinator, audioOutput: router, TTS_API_KEY: 'test',
      harvest: false, synthesisScheduler: scheduler, sentenceCache: cache })
    tts.enabled = true
    const state = { plays: [], calls: [], fail: false, current: null }
    tts.wsClient.synthesizeStream = (text, chunk, finish, error) => {
      const call = { aborted: false, abort() { this.aborted = true } }
      state.calls.push(text)
      queueMicrotask(() => {
        if (call.aborted) return
        if (state.fail) error(new Error('preparation failed'))
        else { chunk(Buffer.from(text)); finish() }
      })
      return call
    }
    const play = async (input, opts) => {
      if (opts.beforePlay() === false || opts.onAudioStart() === false) return { ok: false, aborted: true }
      const done = deferred()
      const current = { text: (Buffer.isBuffer(input) ? input : input.buffer).toString(), done }
      state.current = current
      state.plays.push(current)
      const cancel = () => done.resolve({ ok: false, aborted: true })
      opts.signal.addEventListener('abort', cancel, { once: true })
      if (opts.signal.aborted) cancel()
      try { return await done.promise }
      finally { opts.signal.removeEventListener('abort', cancel); if (state.current === current) state.current = null }
    }
    tts.player = { playSentence: play, playPrepared: play, pause() {}, resume() {},
      stop: () => state.current?.done.resolve({ ok: false, aborted: true }), isPlaying: () => !!state.current }
    t.after(() => tts.destroy())
    return { tts, state }
  }
  const transit = engine('transit'), point = engine('cruise')
  const manager = new TransitAudioManager({ filePath: null, tts: transit.tts })
  manager.saveConfig({ enabled: true, type: 'tts', text: '过渡一句。过渡二句。' })
  t.after(() => manager.stop())
  const narrator = createPointNarrator({
    kb: { getContent: async () => ({ body: '点位一句。点位二句。' }) },
    llm: { rewrite: async input => ({ text: input.body }) },
    tts: point.tts, dataDir: '/unused', broadcast: (type, data) => events.push({ type, data }),
  })
  return { coordinator, transit, point, manager, narrator, events }
}

for (const robot of [false, true]) {
  test(`${robot ? 'robot' : 'local'} transit-to-point waits for ready sentence then discards remaining transit passage`, async t => {
    const h = setup(t, robot)
    await h.manager.start(h.transit.tts, { rewrite: async ({ body }) => ({ text: body }) })
    await until(() => h.transit.state.plays.length === 1)
    let handoffs = 0
    const narration = h.narrator({ play_mode: 'tts' }, {}, {
      onAudioStart: () => { handoffs++; h.manager.stop(); return true },
    })
    await until(() => [...h.coordinator.jobs].some(job => job.role === 'cruise' && job.ready))
    assert.equal(h.point.state.plays.length, 0)
    assert.equal(handoffs, 0)
    h.transit.state.plays[0].done.resolve({ ok: true })
    await until(() => h.point.state.plays.length === 1)
    assert.equal(handoffs, 1)
    assert.equal(h.manager.isRunning(), false)
    assert.equal(h.transit.state.plays.length, 1)
    h.point.state.plays[0].done.resolve({ ok: true })
    await until(() => h.point.state.plays.length === 2)
    h.point.state.plays[1].done.resolve({ ok: true })
    await narration
    assert.equal(h.transit.state.plays.length, 1, 'old transit must not resume after point finishes')
    assert.equal(h.events.filter(event => event.type === 'SPEECH_START').length, 1)
    assert.equal(h.events.filter(event => event.type === 'SPEECH_END').length, 1)
    assert.deepEqual(h.events.filter(event => event.type === 'SPEECH_SENTENCE').map(event => event.data.index), [0, 1])
  })

  test(`${robot ? 'robot' : 'local'} failed point preparation leaves transit active and surfaces failure`, async t => {
    const h = setup(t, robot)
    await h.manager.start(h.transit.tts, { rewrite: async ({ body }) => ({ text: body }) })
    await until(() => h.transit.state.plays.length === 1)
    h.point.state.fail = true
    let handoffs = 0
    await h.narrator({ play_mode: 'tts' }, {}, { onAudioStart: () => { handoffs++; h.manager.stop() } })
    assert.equal(handoffs, 0)
    assert.equal(h.manager.isRunning(), true)
    assert.equal(h.coordinator.active.role, 'transit')
    assert.equal(h.events.some(event => event.type === 'ERROR'), true)
    assert.equal(h.events.some(event => event.type === 'SPEECH_START'), false)
  })

  test(`${robot ? 'robot' : 'local'} skipping prepared point before transit boundary cannot revive its speech`, async t => {
    const h = setup(t, robot), controller = new AbortController()
    await h.manager.start(h.transit.tts, { rewrite: async ({ body }) => ({ text: body }) })
    await until(() => h.transit.state.plays.length === 1)
    let handoffs = 0
    const narration = h.narrator({ play_mode: 'tts' }, {}, {
      signal: controller.signal, onAudioStart: () => { handoffs++; h.manager.stop() },
    })
    await until(() => [...h.coordinator.jobs].some(job => job.role === 'cruise' && job.ready))
    controller.abort()
    await narration
    h.transit.state.plays[0].done.resolve({ ok: true })
    await until(() => h.transit.state.plays.length === 2)
    assert.equal(handoffs, 0)
    assert.equal(h.point.state.plays.length, 0)
    assert.equal(h.events.some(event => event.type === 'SPEECH_START'), false)
  })
}
