import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { parse, compileScript, compileTemplate } = require('@vue/compiler-sfc')
const Vue = require('vue')
function compileComponent(name) {
  const filename = name + '.vue'
  const source = readFileSync(new URL('../src/renderer/src/components/' + filename, import.meta.url), 'utf8')
  const { descriptor, errors } = parse(source, { filename })
  assert.deepEqual(errors, [])
  const script = compileScript(descriptor, { id: name }).content
  const template = compileTemplate({ source: descriptor.template.content, filename, id: name })
  assert.deepEqual(template.errors, [])
  const create = new Function('Vue', 'ElMessage', 'window', 'console', 'StationaryPlayback', script
    .replace(/import (\{[^}]+\}) from 'vue'/, 'const $1 = Vue')
    .replace(/import \{ ElMessage \} from 'element-plus'/, '')
    .replace(/import StationaryPlayback from '.\/StationaryPlayback.vue'/, '')
    .replace(/import TransitAudioSettings from '.\/TransitAudioSettings.vue'/, 'const TransitAudioSettings = {}')
    .replace('export default', 'return'))
  return { create, template: descriptor.template.content }
}
const controls = compileComponent('Controls')
const stationary = compileComponent('StationaryPlayback')

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
  const dependencies = [{ ...Vue, onUnmounted: fn => cleanups.push(fn) }, {
    info: message => messages.push(message), warning: message => messages.push(message),
    error: message => messages.push(message), success: message => messages.push(message),
  }, { api: {} }, { log() {}, error() {} }]
  const panelComponent = stationary.create(...dependencies)
  const component = controls.create(...dependencies, panelComponent)
  const props = Vue.shallowReactive({ wsRef: socket })
  const scope = Vue.effectScope()
  const state = scope.run(() => component.setup(props, { expose() {} }))
  const panel = scope.run(() => panelComponent.setup({
    get groups() { return state.stationaryGroups.value },
    get active() { return state.stationaryActive.value },
    get pending() { return state.stationaryCommandPending.value },
    get connected() { return state.wsConnected.value },
    get blocked() { return state.stationaryDisabledReason.value },
    get stateGroupId() { return state.stationaryGroupId.value },
    get rewrittenText() { return state.stationaryRewrittenText.value },
    get message() { return state.stationaryMessage.value },
    send: state.send,
  }, {
    emit(event, payload) {
      if (event === 'start') state.startStationary(payload)
      else if (event === 'stop') state.stopStationary()
      else assert.fail('Unexpected panel event ' + event)
    },
    expose(api) { state.stationaryPanel.value = api },
  }))
  const dispose = () => { for (const cleanup of cleanups.splice(0)) cleanup(); scope.stop() }
  t.after(dispose)
  return { state, panel, messages, socket, dispose, async replaceSocket(next) { props.wsRef = next; await Vue.nextTick() } }
}

const tourState = (overrides = {}) => ({ running: false, paused: false, repeatCount: 1, currentIteration: 0, ...overrides })
const stationaryState = (overrides = {}) => ({ state: 'idle', active: false, loop: false, iteration: 0, message: '', manualActive: false, ...overrides })
const initialQueries = ['GET_TOUR_STATE', 'GET_STATIONARY_SPEECH_STATE', 'GET_STATIONARY_LIBRARY', 'GET_BARRAGE_CONFIG']
function syncIdle(socket) {
  socket.reply('TOUR_STATE', tourState())
  socket.reply('STATIONARY_SPEECH_STATE', stationaryState())
}

const group = (overrides = {}) => ({
  id: 'first', name: '定点1', mode: 'tts', text: '', loop: true, shuffle: false,
  recordings: [], recordingIds: [], ...overrides,
})
async function loadGroups(socket, ...groups) {
  socket.reply('STATIONARY_LIBRARY', { groups })
  await Vue.nextTick()
}

test('rewrite view follows rounds for the active group and preserves its original after restart', async t => {
  const h = fixture(t)
  syncIdle(h.socket)
  await loadGroups(h.socket, group({ text: '固定原文' }), group({ id: 'other', text: '另一份原文' }))
  h.panel.selectedId.value = 'other'
  await Vue.nextTick()
  h.socket.reply('STATIONARY_SPEECH_STATE', stationaryState({ active: true, state: 'playing', loop: true, iteration: 2,
    groupId: 'first', rewrittenText: '第二轮的改写稿' }))
  await Vue.nextTick()
  assert.equal(h.panel.selectedId.value, 'first')
  assert.equal(h.panel.values.value.text, '固定原文')
  assert.equal(h.state.stationaryRewrittenText.value, '第二轮的改写稿')
  const sent = h.socket.sent.length
  h.panel.view.value = 'rewritten'
  await Vue.nextTick()
  h.panel.view.value = 'original'
  await Vue.nextTick()
  assert.equal(h.socket.sent.length, sent)
  h.socket.reply('STATIONARY_SPEECH_STATE', stationaryState({ active: true, state: 'preparing', loop: true, iteration: 3,
    groupId: 'first', rewrittenText: '第二轮的改写稿' }))
  assert.equal(h.state.stationaryRewrittenText.value, '第二轮的改写稿')
  h.socket.reply('STATIONARY_SPEECH_STATE', stationaryState({ state: 'completed', iteration: 3,
    groupId: 'first', rewrittenText: '第三轮的改写稿' }))
  assert.equal(h.state.stationaryRewrittenText.value, '第三轮的改写稿')
  h.socket.reply('STATIONARY_SPEECH_STATE', stationaryState())
  assert.equal(h.state.stationaryRewrittenText.value, '')
  assert.equal(h.panel.values.value.text, '固定原文', 'backend restart must preserve the group draft')
})

test('page entry requests a tour snapshot and withholds manual testing until it arrives', t => {
  const h = fixture(t)
  assert.deepEqual(h.socket.sent.map(message => message.type), initialQueries)
  h.state.testText.value = 'Test sentence.'
  assert.equal(h.state.canTestSpeech.value, false)
  h.state.sendTestSpeech()
  assert.equal(h.socket.sent.length, initialQueries.length)
  h.socket.reply('TOUR_STATE', tourState())
  assert.equal(h.state.canTestSpeech.value, false, 'stationary/manual snapshot is also required')
  h.socket.reply('STATIONARY_SPEECH_STATE', stationaryState())
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
  syncIdle(h.socket)
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
  syncIdle(h.socket)
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
  assert.deepEqual(replacement.sent.map(message => message.type), initialQueries)
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
  assert.deepEqual(replacement.sent.map(message => message.type), initialQueries)
})

test('manual-test button is bound to its safety predicate with the exact active-tour explanation', () => {
  assert.match(controls.template, /<el-button :disabled="!canTestSpeech" @click="sendTestSpeech">发送播报<\/el-button>/)
  assert.match(controls.template, /<p v-if="tourIsActive" class="hint">请先停止巡游，再进行手动播报测试<\/p>/)
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
  assert.match(controls.template, /:step="barrageScanInterval"/)
  assert.doesNotMatch(controls.template, /step-strictly/)
})

test('lost initial state response is retried, then unlocks the populated test button', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = fixture(t)
  h.state.testText.value = '测试播报'
  assert.match(h.state.testSpeechDisabledReason.value, /同步巡游状态/)
  t.mock.timers.tick(2000)
  assert.equal(h.socket.sent.filter(m => m.type === 'GET_TOUR_STATE').length, 2)
  h.socket.reply('TOUR_STATE', tourState())
  h.socket.reply('STATIONARY_SPEECH_STATE', stationaryState())
  assert.equal(h.state.canTestSpeech.value, true)
  t.mock.timers.tick(4000)
  assert.equal(h.socket.sent.filter(m => m.type === 'GET_TOUR_STATE').length, 2)
  h.socket.reply('TEST_SPEECH_STATUS', { state: 'failed', message: '测试播报失败: TTS 未配置' })
  assert.match(h.state.testSpeechStatus.value, /TTS 未配置/)
  assert.equal(h.state.testText.value, '测试播报')
})

test('stationary panel binds group drafts, playback guards, status, and group-specific rewritten text', () => {
  assert.match(stationary.template, /aria-label="定点播放"/)
  assert.match(stationary.template, /@update:model-value="text => edit\(\{ text \}, true\)"/)
  assert.match(stationary.template, /@change="loop => edit\(\{ loop \}\)"/)
  assert.match(stationary.template, /:disabled="!!startReason \|\| active \|\| !!nameAction" @click="start"/)
  assert.match(stationary.template, /:disabled="!canStop" @click="\$emit\('stop'\)"/)
  assert.match(stationary.template, /stateGroupId === selectedId \? rewrittenText : ''/)
  assert.match(stationary.template, /role="status">\{\{ status \}\}/)
  assert.match(controls.template, /@start="startStationary" @stop="stopStationary"/)
  assert.match(controls.template, /:disabled="!canStartTour" @click="startTour"/)
})

for (const loop of [false, true]) {
  test(`stationary start sends the selected group's original text with loop=${loop} only on explicit click`, async t => {
    const h = fixture(t)
    const text = '  第一行。\n第二行，保留原文！  '
    await loadGroups(h.socket, group())
    assert.equal(h.panel.values.value.loop, true)
    h.panel.edit({ text, loop })
    assert.equal(h.state.canStartStationary.value, false)
    h.panel.start()
    assert.equal(h.socket.sent.some(message => message.type === 'START_STATIONARY_SPEECH'), false)
    syncIdle(h.socket)
    assert.equal(h.panel.startReason.value, '')
    assert.equal(h.state.canStartStationary.value, true)
    assert.equal(h.state.stationaryActive.value, false)
    h.panel.start()
    assert.deepEqual(h.socket.sent.at(-1), { type: 'START_STATIONARY_SPEECH',
      data: { groupId: 'first', text, mode: 'tts', loop, shuffle: false, recordingIds: [] } })
    assert.equal(h.state.stationaryCommandPending.value, true)
    assert.equal(h.state.stationaryActive.value, false, 'sent command does not invent a running state')
    assert.equal(h.state.stationaryState.value, 'idle')
    assert.equal(h.state.canStartStationary.value, false)
    assert.equal(h.state.canStartTour.value, false)
    h.state.testText.value = '手动测试'
    assert.equal(h.state.canTestSpeech.value, false)
    h.panel.start()
    assert.equal(h.socket.sent.filter(message => message.type === 'START_STATIONARY_SPEECH').length, 1)
    h.socket.reply('STATIONARY_SPEECH_STATE', stationaryState({ state: 'preparing', active: true, loop, iteration: 1, message: '正在准备' }))
    assert.equal(h.state.stationaryCommandPending.value, false)
    assert.equal(h.state.stationaryActive.value, true)
    assert.equal(h.state.stationaryStatusLabel.value, '准备中')
    assert.equal(h.state.stationaryMessage.value, '正在准备')
    assert.equal(h.state.canStopStationary.value, true)
  })
}

test('per-group drafts and MP3 selections gate start and survive switching groups', async t => {
  const h = fixture(t)
  syncIdle(h.socket)
  assert.match(h.panel.startReason.value, /读取定点资料/)
  const first = group()
  const second = group({ id: 'second', mode: 'mp3', loop: false, recordings: [{ id: 'r1' }, { id: 'r2' }] })
  await loadGroups(h.socket, first, second)
  assert.match(h.panel.startReason.value, /输入定点原文/)
  h.panel.edit({ text: '第一组草稿' }, true)
  h.panel.selectedId.value = second.id
  await Vue.nextTick()
  const textUpdate = h.socket.sent.at(-1)
  assert.equal(textUpdate.type, 'UPDATE_STATIONARY_GROUP')
  assert.equal(textUpdate.data.groupId, first.id)
  assert.equal(textUpdate.data.text, '第一组草稿')
  assert.match(h.panel.startReason.value, /勾选要播放的录音/)
  h.panel.toggleRecording('r2', true)
  const selectionUpdate = h.socket.sent.at(-1)
  assert.equal(selectionUpdate.type, 'UPDATE_STATIONARY_GROUP')
  assert.equal(selectionUpdate.data.groupId, second.id)
  assert.deepEqual(selectionUpdate.data.recordingIds, ['r2'])
  await loadGroups(h.socket, first, { ...second, recordingIds: ['r2'] })
  h.socket.reply('STATIONARY_GROUP_SAVED', { requestId: selectionUpdate.data.requestId, groupId: second.id })
  h.panel.selectedId.value = first.id
  await Vue.nextTick()
  assert.equal(h.panel.values.value.text, '第一组草稿')
  assert.deepEqual(h.panel.selectedRecordings.value, [])
  h.panel.selectedId.value = second.id
  await Vue.nextTick()
  assert.equal(h.panel.startReason.value, '')
  assert.equal(h.socket.sent.some(message => message.type === 'START_STATIONARY_SPEECH'), false)
  h.panel.start()
  assert.deepEqual(h.socket.sent.at(-1), { type: 'START_STATIONARY_SPEECH', data: {
    groupId: second.id, mode: 'mp3', text: '', loop: false, shuffle: false, recordingIds: ['r2'],
  } })
})

test('stationary lifecycle remains backend-owned through stop and preserves the text draft', async t => {
  const h = fixture(t)
  await loadGroups(h.socket, group())
  h.panel.edit({ text: '下一轮仍保留的原文' }, true)
  h.state.testText.value = '手动测试'
  syncIdle(h.socket)
  for (const [state, label] of [['preparing', '准备中'], ['playing', '播报中'], ['waiting', '等待下一轮']]) {
    h.socket.reply('STATIONARY_SPEECH_STATE', stationaryState({ state, active: true, loop: true, iteration: 3 }))
    assert.equal(h.state.stationaryStatusLabel.value, label)
    assert.equal(h.panel.values.value.loop, true)
    assert.equal(h.state.stationaryIteration.value, 3)
    assert.equal(h.state.canStartStationary.value, false)
    assert.equal(h.state.canTestSpeech.value, false)
    assert.equal(h.state.canStartTour.value, false)
    const before = h.socket.sent.length
    h.state.startTour()
    h.state.sendTestSpeech()
    assert.equal(h.socket.sent.length, before)
  }
  h.state.stopStationary()
  assert.deepEqual(h.socket.sent.at(-1), { type: 'STOP_STATIONARY_SPEECH', data: {} })
  assert.equal(h.state.stationaryState.value, 'waiting', 'stop request alone never reports stopped')
  assert.equal(h.state.stationaryActive.value, true)
  assert.equal(h.state.canStopStationary.value, false)
  h.state.stopStationary()
  assert.equal(h.socket.sent.filter(message => message.type === 'STOP_STATIONARY_SPEECH').length, 1)
  h.socket.reply('STATIONARY_SPEECH_STATE', stationaryState({ state: 'stopping', active: true, loop: true, iteration: 3 }))
  assert.equal(h.state.stationaryStatusLabel.value, '停止中')
  assert.equal(h.state.canStopStationary.value, false)
  assert.equal(h.state.canStartStationary.value, false)
  for (const [state, label] of [['cancelled', '已停止'], ['completed', '已完成'], ['failed', '播报失败']]) {
    h.socket.reply('STATIONARY_SPEECH_STATE', stationaryState({ state, message: `后端 ${state}` }))
    assert.equal(h.state.stationaryStatusLabel.value, label)
    assert.equal(h.state.stationaryMessage.value, `后端 ${state}`)
    assert.equal(h.state.canStartStationary.value, true)
    assert.equal(h.state.canTestSpeech.value, true)
    assert.equal(h.state.canStartTour.value, true)
    assert.equal(h.state.canStopStationary.value, false)
  }
  assert.equal(h.panel.values.value.text, '下一轮仍保留的原文')
})

test('running and paused tours block stationary starts until a backend stop or finish', t => {
  const h = fixture(t)
  h.socket.reply('STATIONARY_SPEECH_STATE', stationaryState())
  for (const paused of [false, true]) {
    h.socket.reply('TOUR_STATE', tourState({ running: true, paused }))
    assert.equal(h.state.canStartStationary.value, false)
    assert.match(h.state.stationaryDisabledReason.value, /请先停止巡游/)
    h.panel.start()
  }
  assert.equal(h.socket.sent.some(message => message.type === 'START_STATIONARY_SPEECH'), false)
  h.socket.reply('TOUR_STOPPED')
  assert.equal(h.state.canStartStationary.value, true)
  h.socket.reply('TOUR_STARTED')
  assert.equal(h.state.canStartStationary.value, false)
  h.socket.reply('TOUR_FINISHED')
  assert.equal(h.state.canStartStationary.value, true)
})

test('manual command pending and backend playback block stationary/tour starts and duplicate tests', t => {
  const h = fixture(t)
  h.state.testText.value = '手动播报'
  syncIdle(h.socket)
  h.state.sendTestSpeech()
  assert.equal(h.state.manualPending.value, true)
  assert.equal(h.state.canStartStationary.value, false)
  assert.equal(h.state.canStartTour.value, false)
  assert.equal(h.state.canTestSpeech.value, false)
  h.state.sendTestSpeech()
  assert.equal(h.socket.sent.filter(message => message.type === 'TEST_SPEECH').length, 1)
  for (const state of ['preparing', 'playing']) {
    h.socket.reply('TEST_SPEECH_STATUS', { state, message: state })
    assert.equal(h.state.manualPending.value, false)
    assert.equal(h.state.manualActive.value, true)
    assert.equal(h.state.canStartStationary.value, false)
    assert.equal(h.state.canStartTour.value, false)
    assert.equal(h.state.canTestSpeech.value, false)
  }
  for (const state of ['completed', 'cancelled', 'failed']) {
    h.socket.reply('TEST_SPEECH_STATUS', { state, message: state })
    assert.equal(h.state.manualActive.value, false)
    assert.equal(h.state.canStartStationary.value, true)
    assert.equal(h.state.canStartTour.value, true)
    assert.equal(h.state.canTestSpeech.value, true)
  }
})

test('unknown stationary states revoke eligibility and retry, including malformed snapshots', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = fixture(t)
  h.state.testText.value = '手动播报'
  syncIdle(h.socket)
  for (const invalid of [{ state: 'new-unknown-state' }, { active: 'false' }, { loop: null }, { manualActive: undefined }]) {
    h.socket.reply('STATIONARY_SPEECH_STATE', stationaryState(invalid))
    assert.equal(h.state.stationaryStateKnown.value, false)
    assert.equal(h.state.canStartStationary.value, false)
    assert.equal(h.state.canStartTour.value, false)
    assert.equal(h.state.canTestSpeech.value, false)
    const before = h.socket.sent.length
    t.mock.timers.tick(2000)
    assert.equal(h.socket.sent.length, before + 1)
    assert.equal(h.socket.sent.at(-1).type, 'GET_STATIONARY_SPEECH_STATE')
    h.socket.reply('STATIONARY_SPEECH_STATE', stationaryState())
    assert.equal(h.state.canStartStationary.value, true)
  }
})

test('lost snapshots and command confirmations are queried again without replaying the command', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = fixture(t)
  await loadGroups(h.socket, group({ text: '原地播报' }))
  h.socket.reply('TOUR_STATE', tourState())
  t.mock.timers.tick(2000)
  t.mock.timers.tick(2000)
  assert.equal(h.socket.sent.filter(message => message.type === 'GET_STATIONARY_SPEECH_STATE').length, 3)
  assert.equal(h.state.canStartStationary.value, false)
  h.socket.reply('STATIONARY_SPEECH_STATE', stationaryState())
  h.panel.start()
  t.mock.timers.tick(2000)
  t.mock.timers.tick(2000)
  assert.equal(h.socket.sent.filter(message => message.type === 'START_STATIONARY_SPEECH').length, 1)
  assert.equal(h.socket.sent.filter(message => message.type === 'GET_STATIONARY_SPEECH_STATE').length, 5)
  assert.equal(h.state.stationaryCommandPending.value, true)
  h.socket.reply('STATIONARY_SPEECH_STATE', stationaryState({ state: 'playing', active: true, iteration: 1 }))
  const count = h.socket.sent.length
  t.mock.timers.tick(6000)
  assert.equal(h.socket.sent.length, count)
})

test('reconnect and remount restore ongoing stationary or manual playback without starting/stopping it', async t => {
  const old = new FakeSocket()
  const h = fixture(t, old)
  await loadGroups(old, group())
  h.panel.edit({ text: '保留草稿' }, true)
  h.state.testText.value = '手动测试'
  syncIdle(old)
  old.reply('STATIONARY_SPEECH_STATE', stationaryState({ state: 'playing', active: true, loop: true, iteration: 4 }))
  old.close()
  assert.equal(h.state.canStartStationary.value, false)
  assert.equal(h.state.canStopStationary.value, false)
  const replacement = new FakeSocket()
  await h.replaceSocket(replacement)
  assert.deepEqual(replacement.sent.map(message => message.type), initialQueries)
  old.reply('STATIONARY_SPEECH_STATE', stationaryState())
  assert.equal(h.state.stationaryStateKnown.value, false)
  replacement.reply('TOUR_STATE', tourState())
  replacement.reply('STATIONARY_SPEECH_STATE', stationaryState({ state: 'playing', active: true, loop: true, iteration: 5 }))
  assert.equal(h.state.canStopStationary.value, true)
  assert.equal(h.state.stationaryIteration.value, 5)
  assert.equal(h.panel.values.value.text, '保留草稿')
  h.dispose()
  assert.equal(replacement.listenerCount(), 0)
  assert.deepEqual(replacement.sent.map(message => message.type), initialQueries, 'unmount never stops live playback')
  const remounted = fixture(t, replacement)
  assert.equal(remounted.panel.current.value, undefined)
  await loadGroups(replacement, group({ loop: false, text: '新草稿' }))
  assert.equal(remounted.panel.values.value.loop, false, 'remount uses the saved group preference')
  assert.equal(remounted.panel.values.value.text, '新草稿')
  remounted.state.testText.value = '新测试'
  replacement.reply('TOUR_STATE', tourState())
  replacement.reply('STATIONARY_SPEECH_STATE', stationaryState({ manualActive: true }))
  assert.equal(remounted.state.manualActive.value, true)
  assert.equal(remounted.state.canStartStationary.value, false)
  assert.equal(remounted.state.canStartTour.value, false)
  assert.equal(remounted.state.canTestSpeech.value, false)
  assert.deepEqual(replacement.sent.map(message => message.type), [...initialQueries, ...initialQueries])
})
