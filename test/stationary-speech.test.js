import test from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { StationarySpeech } from '../src/task/stationary-speech.js'

function fixture(t, loopGapMs = 10) {
  const states = [], calls = []
  const tts = { speak(text, options) {
    return new Promise(resolve => {
      const call = { text, options, resolve }
      options.signal.addEventListener('abort', () => resolve({ ok: false, aborted: true }), { once: true })
      calls.push(call)
    })
  } }
  const speech = new StationarySpeech({ tts, onState: state => states.push(state), loopGapMs })
  t.after(async () => { speech.stop(); await speech.finished })
  return { speech, tts, states, calls }
}

test('one-shot reads exactly the entered text, reports audio start and completes once', async t => {
  const h = fixture(t)
  h.speech.start({ text: '  欢迎来到喵飞。第二句。  ' })
  assert.equal(h.calls[0].text, '欢迎来到喵飞。第二句。')
  assert.equal(h.calls[0].options.harvest, false)
  h.calls[0].options.onAudioStart()
  h.calls[0].resolve({ ok: true })
  await h.speech.finished
  assert.deepEqual(h.states.map(state => state.state), ['preparing', 'playing', 'completed'])
  assert.equal(h.speech.active, false)
  assert.equal(h.calls.length, 1)
})

test('loop waits for the entire previous passage; stop aborts active round and allows clean new run', async t => {
  const h = fixture(t)
  h.speech.start({ text: '第一句。第二句。', loop: true })
  await delay(20)
  assert.equal(h.calls.length, 1)
  h.calls[0].resolve({ ok: true })
  await delay(30)
  assert.equal(h.calls.length, 2)
  assert.equal(h.calls[1].text, h.calls[0].text)
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
  h.calls[2].resolve({ ok: true })
  await h.speech.finished
  assert.equal(h.speech.snapshot().iteration, 1)
})

test('stop in the loop gap prevents any later synthesis', async t => {
  const h = fixture(t, 30)
  h.speech.start({ text: 'loop', loop: true })
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
