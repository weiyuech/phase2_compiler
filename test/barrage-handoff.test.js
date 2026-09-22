import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { BarrageManager } from '../src/phase2/barrage-manager.js'
import { barrageProvider } from '../src/knowledge/barrage-provider.js'

function deferred() { let resolve; return { promise: new Promise(r => { resolve = r }), resolve: (...args) => resolve(...args) } }
function harness(t, overrides = {}) {
  const previous = barrageProvider.getConfig
  barrageProvider.getConfig = async () => ({ mode: 'llm-general', cooldown: 0 })
  t.after(() => { barrageProvider.getConfig = previous })
  const state = { host: false, starts: 0, ends: 0, stops: 0 }, events = [], prompts = []
  const tts = {
    player: { isPlaying: () => false },
    stop: () => { state.stops++ },
    speak: async (text, opts) => {
      opts.onPrepared?.({ utteranceId: opts.utteranceId })
      if (opts.beforePlay?.() === false || opts.onAudioStart?.() === false) return { ok: false, aborted: true }
      opts.onSentenceStart?.({ text, index: 0 })
      return { ok: true }
    },
    ...overrides.tts,
  }
  const manager = new BarrageManager({
    tts, llm: { rewriteBarrage: async (_system, prompt) => { prompts.push(prompt); return 'ready sentence。' }, ...overrides.llm },
    uiBridge: { broadcast: (type, data) => events.push({ type, data }) },
    checkIsSpeaking: () => state.host,
    onBarrageSpeechStart: () => { state.starts++ },
    onBarrageSpeechEnd: () => { state.ends++ },
  })
  manager.isActive = true
  manager.configDir = '/__missing_barrage_handoff_config__'
  t.after(() => manager.stop())
  return { manager, state, events, prompts, tts }
}
const event = text => ({ text, actions: [{ type: 'llm', mode: 'llm-general' }] })

test('in-flight barrage uses immutable OCR text and retains only one latest pending event', async t => {
  const pending = deferred()
  const entered = deferred()
  const h = harness(t, { llm: { rewriteBarrage: async (_system, prompt) => { h.prompts.push(prompt); entered.resolve(); return pending.promise } } })
  const playing = h.manager.playActionSequence(event('original viewer'))
  h.manager.lastRecognizedText = 'mutated viewer'
  await entered.promise
  await h.manager.handleOcrText('older pending')
  await h.manager.handleOcrText('newest pending')
  assert.equal(h.manager.latestBarrageEvent.text, 'newest pending')
  assert.match(h.prompts[0], /original viewer/)
  assert.doesNotMatch(h.prompts[0], /mutated viewer/)
  h.manager.latestBarrageEvent = null
  pending.resolve('reply。')
  await playing
  assert.equal(h.state.starts, 1)
  assert.equal(h.state.ends, 1)
})

test('host does not cancel generating reply, but drops a prepared reply waiting for a boundary', async t => {
  const preparing = deferred(), prepared = deferred(), waitingForBoundary = deferred(), finish = deferred()
  const h = harness(t, { tts: { speak: async (_text, opts) => {
    preparing.resolve()
    await prepared.promise
    opts.onPrepared({ utteranceId: opts.utteranceId })
    waitingForBoundary.resolve()
    await finish.promise
    assert.equal(opts.signal.aborted, true)
    assert.equal(opts.beforePlay(), false)
    return { ok: false, aborted: true }
  } } })
  const playing = h.manager.playActionSequence(event('viewer'))
  // Template file IO may take several event-loop turns on Windows. Wait for
  // the actual stage instead of assuming setImmediate means preparation ran.
  await preparing.promise
  h.manager.stopSpeech()
  assert.equal(h.state.stops, 0)
  prepared.resolve()
  await waitingForBoundary.promise
  h.state.host = true
  h.manager.stopSpeech()
  assert.equal(h.state.stops, 1)
  finish.resolve()
  await playing
  assert.equal(h.state.starts, 0)
  assert.equal(h.state.ends, 0)
  assert.equal(h.events.some(e => e.type === 'SPEECH_START'), false)
})

test('cancelled old LLM completion cannot clear or start over a newer barrage job', async t => {
  const old = deferred(), newer = deferred(), oldEntered = deferred(), newerEntered = deferred()
  let calls = 0
  const h = harness(t, { llm: { rewriteBarrage: () => {
    if (++calls === 1) { oldEntered.resolve(); return old.promise }
    newerEntered.resolve()
    return newer.promise
  } } })
  const first = h.manager.playActionSequence(event('first'))
  await oldEntered.promise
  h.manager.cancelPendingSpeech()
  const second = h.manager.playActionSequence(event('second'))
  await newerEntered.promise
  old.resolve('obsolete reply')
  await first
  assert.equal(h.manager.isPlaying, true)
  assert.equal(h.state.starts, 0)
  newer.resolve('new reply。')
  await second
  assert.equal(h.state.starts, 1)
  assert.equal(h.manager.isPlaying, false)
})

test('MP3 barrage does not claim speech until preparation and playback hook succeed', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'barrage-handoff-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(join(dir, 'concept'))
  await writeFile(join(dir, 'concept', 'clip.mp3'), 'fixture')
  const ready = deferred()
  const h = harness(t, { tts: { speakFile: async (_file, opts) => {
    await ready.promise
    opts.onPrepared({ utteranceId: opts.utteranceId })
    assert.equal(opts.beforePlay(), true)
    assert.equal(opts.onAudioStart(), true)
    return { ok: true }
  } } })
  h.manager.audioDir = dir
  const playing = h.manager.playActionSequence({ text: 'viewer', actions: [{ type: 'mp3', conceptName: 'concept' }] })
  await nextTurn()
  assert.equal(h.state.starts, 0)
  ready.resolve()
  await playing
  assert.equal(h.state.starts, 1)
  assert.equal(h.manager.mp3Count, 1)
  const starts = h.events.filter(e => e.type === 'SPEECH_START')
  assert.equal(starts.length, 1)
  assert.equal(starts[0].data.source, 'barrage')
  assert.equal(h.events.find(e => e.type === 'SPEECH_END').data.utteranceId, starts[0].data.utteranceId)
})

test('OCR remains latest-only while the finishing job loads cooldown settings', async t => {
  const h = harness(t), loading = deferred(), config = deferred()
  let requests = 0
  barrageProvider.getConfig = async () => {
    if (++requests === 2) { loading.resolve(); return config.promise }
    return { mode: 'llm-general', cooldown: 5 }
  }
  const playing = h.manager.playActionSequence(event('current'))
  await loading.promise
  assert.equal(h.manager.isPlaying, true)
  await h.manager.handleOcrText('latest while reading cooldown')
  assert.equal(h.state.starts, 1)
  assert.equal(h.manager.latestBarrageEvent.text, 'latest while reading cooldown')
  config.resolve({ cooldown: 5 })
  await playing
  assert.equal(h.manager.isSleeping, true)
  assert.equal(h.state.starts, 1)
})

test('failed barrage preparation is visible without a speech start or broadcast count', async t => {
  const h = harness(t, { tts: { speak: async () => ({ ok: false, error: new Error('preparation failed') }) } })
  await h.manager.playActionSequence(event('viewer'))
  assert.equal(h.state.starts, 0)
  assert.equal(h.manager.llmCount, 0)
  assert.equal(h.events.some(event => event.type === 'SPEECH_START'), false)
  assert.match(h.events.find(event => event.type === 'ERROR').data.message, /preparation failed/)
})
