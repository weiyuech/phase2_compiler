import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { createPointNarrator } from '../src/task/point-narrator.js'
import { CruiseController } from '../src/task/cruise-controller.js'
import { TaskManager } from '../src/task/manager.js'

function deferred() {
  let resolve
  const promise = new Promise(r => { resolve = r })
  return { promise, resolve }
}
const point = id => ({ map_name: 'map', path_file: 'path', goal_id: id })
const item = id => ({ map_name: 'map', path_name: 'path', goal_id: id, play_mode: 'tts' })

function narratorHarness(overrides = {}) {
  const state = { host: false, barrage: false, paused: false, epoch: 0, current: true }
  const signal = new AbortController()
  const events = [], calls = []
  const tts = {
    async speak(text, opts) {
      calls.push({ text, opts })
      if (!await opts.waitForPlayback({ signal: signal.signal }) || !opts.beforePlay()) {
        return { ok: false, aborted: true }
      }
      opts.onAudioStart()
      return { ok: true }
    },
    async speakFile(file, opts) { return this.speak(file, opts) },
  }
  const narrate = createPointNarrator({
    kb: { getContent: async () => ({ body: 'point text' }) },
    llm: { rewrite: async ({ body }) => ({ text: body }) },
    tts, dataDir: '/__missing_point_handoff_test__',
    broadcast: (type, data) => events.push({ type, data }),
    getOutputGeneration: () => state.epoch,
    isSpeechBlocked: () => state.host || state.barrage || state.paused,
    pollMs: 1,
    ...overrides,
  })
  const context = {
    signal: signal.signal,
    isCurrent: () => state.current,
    onAudioStart: () => { events.push({ type: 'TRANSIT_CUTOFF' }); return true },
  }
  return { state, signal, events, calls, tts, narrate, context }
}

test('local point preparation leaves transit alone until the playback handoff', async () => {
  const prepared = deferred()
  const h = narratorHarness({ llm: { rewrite: () => prepared.promise } })
  const playing = h.narrate(item(1), point(1), h.context)
  await nextTurn()
  assert.deepEqual(h.events, [])
  prepared.resolve({ text: 'ready narration' })
  await playing
  assert.deepEqual(h.events.map(e => e.type), ['TRANSIT_CUTOFF', 'SPEECH_START', 'SPEECH_END'])
  h.calls[0].opts.onAudioStart()
  assert.equal(h.events.filter(e => e.type === 'TRANSIT_CUTOFF').length, 1)
  assert.equal(h.calls[0].opts.beforePlay(), false, 'completed point cannot acquire the next segment')
})

test('all pause reasons must clear before a prepared point can interrupt transit', async () => {
  const h = narratorHarness()
  Object.assign(h.state, { host: true, barrage: true, paused: true })
  const playing = h.narrate(item(1), point(1), h.context)
  await nextTurn()
  assert.equal(h.calls.length, 1, 'TTS may prepare while audio is blocked')
  h.state.host = false
  h.state.barrage = false
  await nextTurn()
  assert.deepEqual(h.events, [])
  h.state.paused = false
  await playing
  assert.equal(h.events[0].type, 'TRANSIT_CUTOFF')
})

for (const change of ['abort', 'skip', 'output-roundtrip']) {
  test(`${change} during preparation prevents late narration or transit cutoff`, async () => {
    const prepared = deferred()
    const h = narratorHarness({ llm: { rewrite: () => prepared.promise } })
    const playing = h.narrate(item(1), point(1), h.context)
    await nextTurn()
    if (change === 'abort') h.signal.abort()
    else if (change === 'skip') h.state.current = false
    else h.state.epoch += 2
    prepared.resolve({ text: 'obsolete' })
    await playing
    assert.equal(h.calls.length, 0)
    assert.deepEqual(h.events, [])
  })
}

test('output changes while waiting for host release cancel rather than fall through to a new output', async () => {
  const h = narratorHarness()
  h.state.host = true
  const playing = h.narrate(item(1), point(1), h.context)
  await nextTurn()
  h.state.epoch++
  await playing
  assert.deepEqual(h.events, [])
})

test('output switching ends the active caption without allowing a stale point to clear its successor', async () => {
  for (const superseded of [false, true]) {
    const stopped = deferred()
    const h = narratorHarness({ tts: {
      async speak(text, opts) {
        assert.equal(await opts.waitForPlayback(), true)
        assert.equal(opts.onAudioStart(), true)
        await stopped.promise
        assert.equal(opts.beforePlay(), false)
        return { ok: false, aborted: true }
      },
    } })
    const playing = h.narrate(item(1), point(1), h.context)
    await nextTurn()
    assert.deepEqual(h.events.map(e => e.type), ['TRANSIT_CUTOFF', 'SPEECH_START'])
    h.state.epoch++
    if (superseded) h.state.current = false
    stopped.resolve()
    await playing
    assert.equal(h.events.filter(e => e.type === 'SPEECH_END').length, superseded ? 0 : 1)
  }
})

test('missing content, no MP3, and preparation failure do not cut transit or claim speech started', async () => {
  for (const mode of ['missing', 'mp3', 'failure']) {
    const h = narratorHarness({
      kb: { getContent: async () => mode === 'missing' ? null : { body: 'text' } },
      llm: { rewrite: async () => { throw new Error('test synthesis failure') } },
    })
    await h.narrate({ ...item(1), play_mode: mode === 'mp3' ? 'mp3' : 'tts' }, point(1), h.context)
    assert.equal(h.events.some(e => ['TRANSIT_CUTOFF', 'SPEECH_START'].includes(e.type)), false)
  }
})

test('point MP3 uses the same guarded handoff and only chooses that point\'s pool', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'point-handoff-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const pool = join(dir, 'cruising-audio', 'map', 'path', '1')
  await mkdir(pool, { recursive: true })
  await writeFile(join(pool, 'one.mp3'), 'fixture')
  await writeFile(join(pool, 'ignore.txt'), 'not audio')
  const h = narratorHarness({ dataDir: dir })
  await h.narrate({ ...item(1), play_mode: 'mp3' }, point(1), h.context)
  assert.equal(h.calls[0].text, join(pool, 'one.mp3'))
  assert.deepEqual(h.events.map(e => e.type), ['TRANSIT_CUTOFF', 'SPEECH_START', 'SPEECH_END'])
})

test('an MP3 startup error is visible and does not claim the speaker', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'point-handoff-error-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const pool = join(dir, 'cruising-audio', 'map', 'path', '1')
  await mkdir(pool, { recursive: true })
  await writeFile(join(pool, 'one.mp3'), 'fixture')
  const h = narratorHarness({ dataDir: dir, tts: {
    speakFile: async () => ({ ok: false, error: new Error('cannot start player') }),
  } })
  await h.narrate({ ...item(1), play_mode: 'mp3' }, point(1), h.context)
  assert.deepEqual(h.events.map(e => e.type), ['ERROR'])
  assert.match(h.events[0].data.message, /cannot start player/)
})

function cruiseHarness(t, { deferredHandoff = true, playPoint } = {}) {
  const tour = new TaskManager({ filePath: '/__missing_point_handoff_test__/tour.json' })
  tour._list = [item(1), item(2), item(3)]
  const state = { transit: false, cuts: 0, sent: [] }
  let navigation
  const robot = {
    sendSetGoal(item) {
      state.sent.push(item.goal_id)
      navigation = deferred()
      return navigation.promise
    },
    cancelPendingGoal() { navigation?.resolve(point(-1)) },
  }
  const scopes = []
  const cruise = new CruiseController({
    robot, tour, getSelectedMap: () => 'map',
    playPoint: async (item, point, context) => {
      scopes.push(context)
      if (playPoint) return playPoint(item, context)
      context.onAudioStart()
    },
    stopSpeech() {},
    startTransit() { state.transit = true },
    stopTransit() { state.transit = false; state.cuts++ },
    isTransitRunning: () => state.transit,
    deferTransitUntilSpeech: () => deferredHandoff,
    broadcast() {},
  })
  t.after(() => cruise.stop())
  return { cruise, tour, state, scopes, arrive: id => navigation.resolve(point(id)) }
}

test('controller defers local arrival cutoff and retires callbacks separately for each point', async t => {
  const ready = deferred()
  let second
  const h = cruiseHarness(t, { playPoint: async (item, context) => {
    if (item.goal_id === 1) { context.onAudioStart(); return }
    second = context
    await ready.promise
  } })
  h.cruise.start()
  h.arrive(1)
  await nextTurn()
  assert.equal(h.state.transit, true)
  const cuts = h.state.cuts
  assert.equal(h.scopes[0].onAudioStart(), false)
  assert.equal(h.state.cuts, cuts)
  h.arrive(2)
  await nextTurn()
  assert.equal(h.state.transit, true, 'arrival must not silence transit during point preparation')
  h.cruise.pause()
  assert.equal(second.onAudioStart(), false)
  h.cruise.resume()
  assert.equal(second.onAudioStart(), true)
  assert.equal(second.onAudioStart(), true)
  assert.equal(h.state.cuts, cuts + 1, 'handoff cuts transit only once')
  ready.resolve()
  await nextTurn()
  assert.equal(h.state.transit, true)
  assert.equal(second.onAudioStart(), false)
  h.cruise.stop()
  await h.cruise.finished
})

test('skipping a preparing point preserves transit and invalidates its late handoff', async t => {
  const ready = deferred()
  let second
  const h = cruiseHarness(t, { playPoint: async (item, context) => {
    if (item.goal_id === 1) { context.onAudioStart(); return }
    second = context
    await ready.promise
  } })
  h.cruise.start()
  h.arrive(1)
  await nextTurn()
  h.arrive(2)
  await nextTurn()
  const oldRun = h.cruise.finished
  h.cruise.skip()
  assert.equal(h.state.transit, true)
  assert.equal(second.signal.aborted, true)
  assert.equal(second.onAudioStart(), false)
  ready.resolve()
  await oldRun
  assert.equal(h.state.transit, true)
  h.cruise.stop()
  await h.cruise.finished
})

test('transport without deferred handoff keeps its existing arrival cutoff', async t => {
  const ready = deferred()
  const h = cruiseHarness(t, { deferredHandoff: false, playPoint: async item => {
    if (item.goal_id === 2) await ready.promise
  } })
  h.cruise.start()
  h.arrive(1)
  await nextTurn()
  assert.equal(h.state.transit, true)
  h.arrive(2)
  await nextTurn()
  assert.equal(h.state.transit, false)
  ready.resolve()
  await nextTurn()
  h.cruise.stop()
  await h.cruise.finished
})
