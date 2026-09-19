import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { parse, compileScript, compileTemplate } = require('@vue/compiler-sfc')
const Vue = require('vue')
const source = readFileSync(new URL('../src/renderer/src/components/Controls.vue', import.meta.url), 'utf8')
const { descriptor, errors } = parse(source)
assert.deepEqual(errors, [])
const script = compileScript(descriptor, { id: 'controls-tour-state' }).content
const template = compileTemplate({ source: descriptor.template.content, filename: 'Controls.vue', id: 'controls-tour-state' })
assert.deepEqual(template.errors, [])
const createComponent = new Function('Vue', 'ElMessage', 'window', 'console', script
  .replace(/import \{ ref, computed, watch, onUnmounted, reactive \} from 'vue'/, 'const { ref, computed, watch, onUnmounted, reactive } = Vue')
  .replace(/import \{ ElMessage \} from 'element-plus'/, '')
  .replace(/import TransitAudioSettings from '.\/TransitAudioSettings.vue'/, 'const TransitAudioSettings = {}')
  .replace('export default', 'return'))

class FakeSocket {
  constructor(readyState = 1) { this.readyState = readyState; this.sent = []; this.listeners = new Map() }
  addEventListener(type, listener, options = {}) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Map())
    this.listeners.get(type).set(listener, options.once === true)
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener) }
  send(raw) { assert.equal(this.readyState, 1); this.sent.push(JSON.parse(raw)) }
  emit(type, data) {
    const listeners = this.listeners.get(type)
    for (const [handler, once] of [...(listeners || [])]) {
      if (once) listeners.delete(handler)
      handler({ data })
    }
  }
  reply(type, data = {}) { this.emit('message', JSON.stringify({ type, data })) }
  open() { this.readyState = 1; this.emit('open') }
  close() { this.readyState = 3; this.emit('close') }
  listenerCount() { return [...this.listeners.values()].reduce((sum, value) => sum + value.size, 0) }
}

function fixture(t, socket = new FakeSocket()) {
  const cleanups = [], messages = []
  const component = createComponent({ ...Vue, onUnmounted: fn => cleanups.push(fn) }, {
    info: message => messages.push(message), warning: message => messages.push(message),
    error: message => messages.push(message), success: message => messages.push(message),
  }, { api: {} }, { log() {}, error() {} })
  const props = Vue.shallowReactive({ wsRef: socket })
  const scope = Vue.effectScope()
  const state = scope.run(() => component.setup(props, { expose() {} }))
  const dispose = () => { for (const cleanup of cleanups.splice(0)) cleanup(); scope.stop() }
  t.after(dispose)
  return { state, messages, socket, dispose, async replaceSocket(next) { props.wsRef = next; await Vue.nextTick() } }
}

const tourState = (overrides = {}) => ({ running: false, paused: false, repeatCount: 1, currentIteration: 0, ...overrides })

test('page entry requests a tour snapshot and withholds manual testing until it arrives', t => {
  const h = fixture(t)
  assert.deepEqual(h.socket.sent.map(message => message.type), ['GET_TOUR_STATE', 'GET_BARRAGE_CONFIG'])
  h.state.testText.value = 'Test sentence.'
  assert.equal(h.state.canTestSpeech.value, false)
  h.state.sendTestSpeech()
  assert.equal(h.socket.sent.length, 2)
  h.socket.reply('TOUR_STATE', tourState())
  assert.equal(h.state.canTestSpeech.value, true)
  h.state.sendTestSpeech()
  assert.deepEqual(h.socket.sent.at(-1), { type: 'TEST_SPEECH', data: { text: 'Test sentence.' } })
  assert.equal(h.state.testText.value, 'Test sentence.')
  assert.match(h.state.testSpeechStatus.value, /等待后端确认/)
})

for (const paused of [false, true]) {
  test(`${paused ? 'paused' : 'running'} tour snapshot disables the manual test and preserves its draft`, t => {
    const h = fixture(t)
    h.state.testText.value = 'Keep this draft.'
    h.socket.reply('TOUR_STATE', tourState({ running: true, paused, repeatCount: 4, currentIteration: 2 }))
    assert.equal(h.state.tourStatus.value, paused ? 'paused' : 'running')
    assert.equal(h.state.repeatCount.value, 4)
    assert.equal(h.state.currentIteration.value, 2)
    assert.equal(h.state.canTestSpeech.value, false)
    h.state.sendTestSpeech()
    assert.equal(h.socket.sent.some(message => message.type === 'TEST_SPEECH'), false)
    assert.equal(h.state.testText.value, 'Keep this draft.')
    assert.equal(h.messages.at(-1), '请先停止巡游，再进行手动播报测试')
  })
}

test('existing live tour events still update controls and re-enable testing only after stop/finish', t => {
  const h = fixture(t)
  h.state.testText.value = 'Test.'
  h.socket.reply('TOUR_STATE', tourState())
  h.socket.reply('TOUR_STARTED', { repeatCount: 3 })
  assert.equal(h.state.canTestSpeech.value, false)
  assert.equal(h.state.currentIteration.value, 1)
  h.socket.reply('TOUR_ITERATION', { currentIteration: 2, repeatCount: 3 })
  assert.equal(h.state.currentIteration.value, 2)
  h.socket.reply('TOUR_PAUSED')
  assert.equal(h.state.canTestSpeech.value, false)
  h.socket.reply('TOUR_RESUMED')
  assert.equal(h.state.tourStatus.value, 'running')
  h.socket.reply('TOUR_STOPPED')
  assert.equal(h.state.canTestSpeech.value, true)
  h.socket.reply('TOUR_STARTED', { repeatCount: 1 })
  h.socket.reply('TOUR_FINISHED')
  assert.equal(h.state.canTestSpeech.value, true)
  assert.equal(h.state.currentIteration.value, 0)
})

test('reconnect clears stale eligibility, requests fresh state, and detaches the old socket', async t => {
  const h = fixture(t)
  h.state.testText.value = 'Test.'
  h.socket.reply('TOUR_STATE', tourState())
  assert.equal(h.state.canTestSpeech.value, true)
  h.socket.close()
  assert.equal(h.state.canTestSpeech.value, false)
  assert.equal(h.state.wsConnected.value, false)
  const replacement = new FakeSocket(0)
  await h.replaceSocket(replacement)
  assert.equal(h.socket.listenerCount(), 0)
  replacement.open()
  assert.equal(h.state.wsConnected.value, true)
  assert.equal(h.state.canTestSpeech.value, false)
  assert.deepEqual(replacement.sent.map(message => message.type), ['GET_TOUR_STATE', 'GET_BARRAGE_CONFIG'])
  h.socket.reply('TOUR_STATE', tourState())
  assert.equal(h.state.tourStateKnown.value, false)
  replacement.reply('TOUR_STATE', tourState({ running: true, paused: true }))
  assert.equal(h.state.canTestSpeech.value, false)
  assert.equal(h.state.tourStatus.value, 'paused')
  h.dispose()
  assert.equal(replacement.listenerCount(), 0)
})

test('an abandoned connecting socket cannot request state after page replacement', async t => {
  const old = new FakeSocket(0)
  const h = fixture(t, old)
  const replacement = new FakeSocket()
  await h.replaceSocket(replacement)
  old.open()
  assert.deepEqual(old.sent, [])
  assert.deepEqual(replacement.sent.map(message => message.type), ['GET_TOUR_STATE', 'GET_BARRAGE_CONFIG'])
})

test('manual-test button is bound to its safety predicate with the exact active-tour explanation', () => {
  assert.match(descriptor.template.content, /<el-button :disabled="!canTestSpeech" @click="sendTestSpeech">发送播报<\/el-button>/)
  assert.match(descriptor.template.content, /<p v-if="tourIsActive" class="hint">请先停止巡游，再进行手动播报测试<\/p>/)
})

test('cooldown editor rounds to nearest interval multiple and never saves zero cooldown', t => {
  const h = fixture(t)
  h.socket.reply('BARRAGE_CONFIG', { scan_interval: 3, cooldown: 9 })
  for (const [input, expected] of [[10, 9], [2, 3], [0, 3], [11, 12]]) {
    h.state.onCooldownChange(input)
    assert.equal(h.state.barrageCooldown.value, expected)
    assert.deepEqual(h.socket.sent.at(-1), { type: 'SET_BARRAGE_CONFIG', data: { cooldown: expected, scan_interval: 3 } })
  }
  const sent = h.socket.sent.length
  for (const invalid of [null, undefined, NaN, -1, 3001, 2.5]) h.state.onCooldownChange(invalid)
  assert.equal(h.socket.sent.length, sent)
})

test('changing interval saves both normalized settings atomically and reconnect reflects server values', t => {
  const h = fixture(t)
  h.socket.reply('BARRAGE_CONFIG', { scan_interval: 1, cooldown: 10 })
  h.state.onScanIntervalChange(3)
  assert.deepEqual(h.socket.sent.at(-1), { type: 'SET_BARRAGE_CONFIG', data: { cooldown: 9, scan_interval: 3 } })
  assert.equal(h.state.barrageCooldown.value, 9)
  h.socket.reply('BARRAGE_CONFIG_SAVED', { scan_interval: 6, cooldown: 12 })
  assert.equal(h.state.barrageCooldown.value, 12)
  assert.equal(h.state.barrageScanInterval.value, 6)
  assert.match(descriptor.template.content, /:step="barrageScanInterval"/)
  assert.doesNotMatch(descriptor.template.content, /step-strictly/)
})

test('lost initial state response is retried, then unlocks the populated test button', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = fixture(t)
  h.state.testText.value = '测试播报'
  assert.match(h.state.testSpeechDisabledReason.value, /同步巡游状态/)
  t.mock.timers.tick(2000)
  assert.equal(h.socket.sent.filter(m => m.type === 'GET_TOUR_STATE').length, 2)
  h.socket.reply('TOUR_STATE', tourState())
  assert.equal(h.state.canTestSpeech.value, true)
  t.mock.timers.tick(4000)
  assert.equal(h.socket.sent.filter(m => m.type === 'GET_TOUR_STATE').length, 2)
  h.socket.reply('TEST_SPEECH_STATUS', { state: 'failed', message: '测试播报失败: TTS 未配置' })
  assert.match(h.state.testSpeechStatus.value, /TTS 未配置/)
  assert.equal(h.state.testText.value, '测试播报')
})
