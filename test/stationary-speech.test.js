import test from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { StationarySpeech } from '../src/task/stationary-speech.js'

function fixture(t, loopGapMs = 10) {
  const states = [], calls = [], rewrites = []
  const llm = { async rewriteStationary(text, options) {
    rewrites.push({ text, options })
    return { text: `第${options.iteration}版：${text}` }
  } }
  const tts = { speak(text, options) {
    return new Promise(resolve => {
      const call = { text, options, resolve }
      options.signal.addEventListener('abort', () => resolve({ ok: false, aborted: true }), { once: true })
      calls.push(call)
    })
  } }
  const speech = new StationarySpeech({ tts, llm, onState: state => states.push(state), loopGapMs })
  t.after(async () => { speech.stop(); await speech.finished })
  return { speech, tts, llm, states, calls, rewrites }
}

test('one-shot rewrites entered text before TTS, reports audio start and completes once', async t => {
  const h = fixture(t)
  h.speech.start({ text: '  欢迎来到喵飞。第二句。  ' })
  assert.equal(h.calls.length, 0)
  await nextTurn()
  assert.equal(h.rewrites[0].text, '欢迎来到喵飞。第二句。')
  assert.equal(h.calls[0].text, '第1版：欢迎来到喵飞。第二句。')
  assert.equal(h.speech.snapshot().originalText, '欢迎来到喵飞。第二句。')
  assert.equal(h.speech.snapshot().rewrittenText, h.calls[0].text)
  assert.equal(h.speech.snapshot().rewrittenIteration, 1)
  assert.equal(h.calls[0].options.harvest, false)
  h.calls[0].options.onAudioStart()
  h.calls[0].resolve({ ok: true })
  await h.speech.finished
  assert.deepEqual(h.states.map(state => state.state), ['preparing', 'preparing', 'playing', 'completed'])
  assert.equal(h.speech.active, false)
  assert.equal(h.calls.length, 1)
  assert.equal(h.rewrites.length, 1, 'one-shot does not prefetch another round')
  assert.equal(h.speech.snapshot().rewrittenText, h.calls[0].text, 'keep the final rewrite visible after completion')
})

test('loop waits for the entire previous passage; stop aborts active round and allows clean new run', async t => {
  const h = fixture(t)
  h.speech.start({ text: '第一句。第二句。', loop: true })
  await delay(20)
  assert.equal(h.calls.length, 1)
  assert.equal(h.rewrites.length, 2, 'next rewrite starts before current audio completes')
  assert.equal(h.speech.snapshot().rewrittenIteration, 1, 'prefetch must not replace the displayed round')
  assert.equal(h.speech.snapshot().rewrittenText, h.calls[0].text)
  h.calls[0].resolve({ ok: true })
  await delay(30)
  assert.equal(h.calls.length, 2)
  assert.notEqual(h.calls[1].text, h.calls[0].text)
  assert.equal(h.speech.snapshot().rewrittenText, h.calls[1].text)
  assert.equal(h.speech.snapshot().rewrittenIteration, 2)
  assert.deepEqual(h.rewrites.map(call => call.text), ['第一句。第二句。', '第一句。第二句。', '第一句。第二句。'])
  assert.equal(h.rewrites[0].options.previousText, '')
  assert.equal(h.rewrites[1].options.previousText, h.calls[0].text)
  h.speech.stop()
  assert.equal(h.speech.snapshot().state, 'stopping')
  assert.throws(() => h.speech.start({ text: 'too early' }), /正在进行/)
  h.calls[1].options.onAudioStart()
  await h.speech.finished
  assert.equal(h.speech.snapshot().state, 'cancelled')
  assert.equal(h.calls[1].options.signal.aborted, true)
  await delay(20)
  assert.equal(h.calls.length, 2)
  h.speech.start({ text: 'new run' })
  await nextTurn()
  assert.equal(h.rewrites.at(-1).options.previousText, '')
  h.calls[2].resolve({ ok: true })
  await h.speech.finished
  assert.equal(h.speech.snapshot().iteration, 1)
})

test('stop in the loop gap prevents any later synthesis', async t => {
  const h = fixture(t, 30)
  h.speech.start({ text: 'loop', loop: true })
  await nextTurn()
  h.calls[0].resolve({ ok: true })
  await nextTurn()
  assert.equal(h.speech.snapshot().state, 'waiting')
  h.speech.stop('音频输出已更改，原地播报已停止')
  await h.speech.finished
  await delay(45)
  assert.equal(h.calls.length, 1)
  assert.match(h.speech.snapshot().message, /音频输出已更改/)
})

test('provider/decode/output failure or external cancellation ends a loop without retries', async t => {
  for (const result of [{ ok: false, error: new Error('decode failed') }, { ok: false }, { ok: false, aborted: true }]) {
    const h = fixture(t)
    h.speech.start({ text: 'loop', loop: true })
    await nextTurn()
    h.calls[0].resolve(result)
    await h.speech.finished
    assert.equal(h.speech.snapshot().state, result.aborted ? 'cancelled' : 'failed')
    assert.equal(h.speech.active, false)
    assert.equal(h.calls.length, 1)
  }
  const h = fixture(t)
  h.tts.speak = () => { throw new Error('provider failed') }
  h.speech.start({ text: 'loop', loop: true })
  await h.speech.finished
  assert.match(h.speech.snapshot().message, /provider failed/)
})

test('three independent stationary runs survive stopping one; new backend starts idle', async t => {
  const machines = [fixture(t), fixture(t), fixture(t)]
  machines.forEach((h, i) => h.speech.start({ text: `machine ${i + 1}`, loop: true }))
  await nextTurn()
  machines[1].speech.stop()
  await machines[1].speech.finished
  for (const h of [machines[0], machines[2]]) {
    assert.equal(h.speech.active, true)
    assert.equal(h.calls[0].options.signal.aborted, false)
  }
  const restarted = fixture(t)
  assert.equal(restarted.speech.snapshot().state, 'idle')
  assert.equal(restarted.speech.snapshot().loop, false)
  assert.deepEqual(restarted.calls, [])
})

test('stop during rewriting cancels the request and ignores a late result', async t => {
  const h = fixture(t)
  let finish, signal
  h.llm.rewriteStationary = (_text, options) => {
    signal = options.signal
    return new Promise(resolve => { finish = resolve })
  }
  h.speech.start({ text: 'original', loop: true })
  h.speech.stop()
  assert.equal(signal.aborted, true)
  finish({ text: 'late result' })
  await h.speech.finished
  assert.equal(h.speech.snapshot().state, 'cancelled')
  assert.deepEqual(h.calls, [])
})

test('failed or empty rewrite ends the loop without reading the original', async t => {
  for (const rewrite of [async () => { throw new Error('rewrite failed') }, async () => ({ text: '' })]) {
    const h = fixture(t)
    h.llm.rewriteStationary = rewrite
    h.speech.start({ text: 'unchecked original', loop: true })
    await h.speech.finished
    assert.equal(h.speech.snapshot().state, 'failed')
    assert.deepEqual(h.calls, [])
  }
})

test('application prevents stale tour stop/start from stealing stationary playback', () => {
  const source = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  const begin = source.indexOf("uiBridge.on('onStartTour',")
  const end = source.indexOf("uiBridge.on('onSetTourList',", begin)
  const handlers = {}, calls = []
  let eligible = false
  const tour = { isRunning: false, isPaused: false }
  vm.runInNewContext(source.slice(begin, end), {
    uiBridge: { on: (name, handler) => { handlers[name] = handler } }, tour,
    tourControls: { canStartTour: () => eligible },
    cruise: { start: () => calls.push('start'), stop: () => calls.push('stop') },
    audioDiagnostics: { event() {} },
  })
  handlers.onStartTour({ repeatCount: 2 }); handlers.onStopTour()
  assert.deepEqual(calls, [])
  eligible = true
  handlers.onStartTour({ repeatCount: 2 })
  tour.isRunning = true
  handlers.onStopTour()
  assert.deepEqual(calls, ['start', 'stop'])
})

test('lookahead is bounded, keeps the current preview, and waits for audio before using the next rewrite', async t => {
  const h = fixture(t)
  let finishNext
  const rewrite = h.llm.rewriteStationary
  h.llm.rewriteStationary = (text, options) => options.iteration === 2
    ? new Promise(resolve => { finishNext = resolve }) : rewrite(text, options)
  h.speech.start({ text: 'fixed original', loop: true })
  await nextTurn()
  assert.equal(typeof finishNext, 'function', 'round 2 starts while round 1 is still playing')
  finishNext({ text: 'prefetched second version' })
  await nextTurn()
  assert.equal(h.calls.length, 1)
  assert.equal(h.speech.snapshot().rewrittenText, h.calls[0].text)
  assert.equal(h.speech.snapshot().iteration, 1)
  h.calls[0].resolve({ ok: true })
  await delay(25)
  assert.equal(h.calls[1].text, 'prefetched second version')
  assert.equal(h.rewrites.at(-1).options.iteration, 3)
  assert.equal(h.rewrites.at(-1).options.previousText, 'prefetched second version')
  await delay(25)
  assert.equal(h.rewrites.at(-1).options.iteration, 3, 'no unbounded future requests')
})

test('stop cancels audio and lookahead and does not publish late prefetched text', async t => {
  const h = fixture(t)
  const rewrite = h.llm.rewriteStationary
  let finishNext, nextSignal
  h.llm.rewriteStationary = (text, options) => {
    if (options.iteration === 1) return rewrite(text, options)
    nextSignal = options.signal
    return new Promise(resolve => { finishNext = resolve })
  }
  h.speech.start({ text: 'original', loop: true })
  await nextTurn()
  h.speech.stop()
  await nextTurn()
  assert.equal(nextSignal.aborted, true)
  assert.equal(h.calls[0].options.signal.aborted, true)
  assert.equal(h.speech.active, true, 'restart waits for cancellation to settle')
  finishNext({ text: 'discard this late result' })
  await h.speech.finished
  assert.equal(h.speech.snapshot().state, 'cancelled')
  assert.equal(h.speech.snapshot().rewrittenText, h.calls[0].text)
  assert.equal(h.calls.length, 1)
})

test('lookahead failure finishes the current passage then fails without speaking the original', async t => {
  const h = fixture(t)
  const rewrite = h.llm.rewriteStationary
  h.llm.rewriteStationary = (text, options) => options.iteration === 1
    ? rewrite(text, options) : Promise.reject(new Error('next rewrite unavailable'))
  h.speech.start({ text: 'original', loop: true })
  await delay(20)
  assert.equal(h.speech.active, true)
  assert.equal(h.calls[0].options.signal.aborted, false)
  h.calls[0].resolve({ ok: true })
  await h.speech.finished
  assert.equal(h.speech.snapshot().state, 'failed')
  assert.match(h.speech.snapshot().message, /next rewrite unavailable/)
  assert.equal(h.calls.length, 1)
})
