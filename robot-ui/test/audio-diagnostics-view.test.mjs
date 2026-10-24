import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const Vue = require('vue')
const { parse, compileScript, compileTemplate } = require('@vue/compiler-sfc')
const filename = 'AudioDiagnostics.vue'
const source = readFileSync(new URL('../src/renderer/src/components/AudioDiagnostics.vue', import.meta.url), 'utf8')
const { descriptor, errors } = parse(source)
assert.deepEqual(errors, [])
assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename, id: 'audio-diagnostics' }).errors, [])
const script = compileScript(descriptor, { id: 'audio-diagnostics' }).content
const createComponent = new Function('Vue', 'ElMessage', 'WebSocket', 'setInterval', 'clearInterval', script
  .replace(/import \{ computed, onBeforeUnmount, ref, watch \} from 'vue'/, 'const { computed, onBeforeUnmount, ref, watch } = Vue')
  .replace(/import \{ ElMessage \} from 'element-plus'/, '')
  .replace('export default', 'return'))

function fixture(t) {
  const cleanups = []
  const component = createComponent({ ...Vue, onBeforeUnmount: fn => cleanups.push(fn) }, {}, { OPEN: 1 }, () => 1, () => {})
  const scope = Vue.effectScope()
  const state = scope.run(() => component.setup({ wsRef: null }, { expose() {} }))
  state.connected.value = true
  t.after(() => { for (const cleanup of cleanups) cleanup(); scope.stop() })
  return state
}

const summary = { capturedAt: 10000, cadenceSamples: 40, activeSendMs: 1000, sendRateRatio: 0.8 }
const snapshot = overrides => ({ capturedAt: 11000, lastSummary: { ...summary }, totals: { maxGapMs: 9000 }, ...overrides })

test('cadence warning uses recent continuous send evidence, never historical maximum or a tiny sample', t => {
  const state = fixture(t)
  state.snapshot.value = snapshot()
  assert.equal(state.cadenceSlow.value, true)
  assert.match(state.cadenceText.value, /电脑端发送偏慢/)
  assert.match(state.cadenceText.value, /机器人缓冲可能吸收/)
  assert.match(state.cadenceText.value, /不能据此判定实际声音卡顿/)
  for (const values of [
    { sendRateRatio: 1 }, { cadenceSamples: 9 }, { activeSendMs: 199 }, { sendRateRatio: undefined },
  ]) {
    state.snapshot.value = snapshot({ lastSummary: { ...summary, ...values } })
    assert.equal(state.cadenceSlow.value, false)
  }
  assert.match(state.cadenceText.value, /不能据此确认机器人实际播放效果/)
})

test('old or disconnected samples stay readable without a current cadence warning', t => {
  const state = fixture(t)
  state.snapshot.value = snapshot({ capturedAt: 20000 })
  assert.equal(state.cadenceSlow.value, false)
  assert.match(state.cadenceText.value, /距今 10 秒/)
  assert.equal(state.sendRate(state.snapshot.value.lastSummary.sendRateRatio), '0.80×')
  state.snapshot.value = snapshot()
  state.connected.value = false
  assert.equal(state.cadenceSlow.value, false)
  assert.match(state.cadenceText.value, /后台已断开/)
})

test('older backends without a sampling timestamp cannot produce a current warning', t => {
  const state = fixture(t)
  state.snapshot.value = snapshot({ lastSummary: { ...summary, capturedAt: undefined } })
  assert.equal(state.cadenceSlow.value, false)
  assert.match(state.cadenceText.value, /未提供采样时间/)
  state.snapshot.value = snapshot({ lastSummary: null })
  assert.equal(state.cadenceSlow.value, false)
  assert.match(state.cadenceText.value, /尚无发送统计/)
})

test('open-but-stalled backend snapshots age out without claiming playback stopped', t => {
  const state = fixture(t)
  state.onMessage({ data: JSON.stringify({ type: 'AUDIO_DIAGNOSTICS', data: { snapshot: snapshot() } }) })
  assert.equal(state.cadenceSlow.value, true)
  state.observedAt.value = state.snapshotReceivedAt.value + 4000
  assert.equal(state.connected.value, true)
  assert.equal(state.cadenceSlow.value, false)
  assert.match(state.cadenceText.value, /距今 5 秒/)
  assert.match(state.cadenceText.value, /尚未收到更新/)

  state.snapshot.value = snapshot({ capturedAt: 9999 })
  assert.equal(state.summaryAgeMs.value, null, 'clock reversal cannot make an old sample appear fresh')
  assert.equal(state.cadenceSlow.value, false)
})
