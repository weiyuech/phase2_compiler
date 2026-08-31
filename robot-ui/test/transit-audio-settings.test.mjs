import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { parse, compileScript } = require('@vue/compiler-sfc')
const Vue = require('vue')
const source = readFileSync(new URL('../src/renderer/src/components/TransitAudioSettings.vue', import.meta.url), 'utf8')
const parsed = parse(source)
assert.deepEqual(parsed.errors, [])
const script = compileScript(parsed.descriptor, { id: 'transit-audio-test' }).content

// Exercise the actual script setup with Vue's watcher lifecycle, without a DOM,
// Electron, sockets, playback, filesystem writes, or real five-second timers.
assert.match(script, /import \{ ref, reactive, watch \} from 'vue'/)
assert.match(script, /import \{ ElMessage \} from 'element-plus'/)
const createComponent = new Function('Vue', 'ElMessage', 'window', 'WebSocket', 'setTimeout', 'clearTimeout',
  script
    .replace(/import \{ ref, reactive, watch \} from 'vue'/, 'const { ref, reactive, watch } = Vue')
    .replace(/import \{ ElMessage \} from 'element-plus'/, '')
    .replace('export default', 'return'))

class FakeSocket {
  constructor(readyState = 1) {
    this.readyState = readyState
    this.sent = []
    this.listeners = new Map()
  }
  addEventListener(type, listener, options = {}) {
    const entries = this.listeners.get(type) || new Map()
    entries.set(listener, options.once === true)
    this.listeners.set(type, entries)
  }
  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener)
  }
  send(raw) {
    if (this.readyState !== 1) throw new Error('Socket is not open')
    this.sent.push(JSON.parse(raw))
  }
  emit(type, data) {
    const entries = this.listeners.get(type)
    for (const [listener, once] of [...(entries || [])]) {
      if (!entries.has(listener)) continue
      if (once) entries.delete(listener)
      listener({ type, data })
    }
  }
  reply(config) {
    this.emit('message', JSON.stringify({ type: 'TRANSIT_CONFIG', data: config }))
  }
  open() {
    this.readyState = 1
    this.emit('open')
  }
  close() {
    this.readyState = 3
    this.emit('close')
  }
  listenerCount(type) {
    if (type) return this.listeners.get(type)?.size || 0
    return [...this.listeners.values()].reduce((total, entries) => total + entries.size, 0)
  }
}

const config = (overrides = {}) => ({
  enabled: false, type: 'tts', text: '', mp3_file: '', mp3_files: [], mp3_mode: 'repeat',
  ...overrides,
})

function harness(t, socket = null, selectedFiles = []) {
  const messages = []
  const timers = new Map()
  let nextTimer = 1
  const component = createComponent(
    Vue,
    {
      error: message => messages.push({ type: 'error', message }),
      warning: message => messages.push({ type: 'warning', message }),
    },
    { api: { selectMultipleMp3Files: async () => selectedFiles } },
    { OPEN: 1 },
    (callback, delay) => {
      const id = nextTimer++
      timers.set(id, { callback, delay })
      return id
    },
    id => timers.delete(id),
  )
  const props = Vue.shallowReactive({ wsRef: socket })
  const scope = Vue.effectScope()
  const state = scope.run(() => component.setup(props, { expose() {} }))
  t.after(() => scope.stop())
  return {
    state, scope, messages, timers,
    async replaceSocket(next) {
      props.wsRef = next
      await Vue.nextTick()
    },
  }
}

test('loads configuration when the socket arrives after component setup', async t => {
  const h = harness(t)
  const ws = new FakeSocket()
  await h.replaceSocket(ws)
  assert.deepEqual(ws.sent, [{ type: 'GET_TRANSIT_CONFIG' }])
  assert.equal(ws.listenerCount('message'), 1)
  ws.reply({ enabled: true, type: 'mp3', mp3_file: '/audio/legacy.mp3' })
  assert.deepEqual({ ...h.state.transitConfig }, config({
    enabled: true, type: 'mp3', mp3_file: '/audio/legacy.mp3', mp3_files: ['/audio/legacy.mp3'],
  }))
  assert.equal(ws.listenerCount('message'), 0)
  assert.equal(h.state.loadedSocket, ws)
})

test('connecting sockets load once on open and late responses preserve dirty drafts', t => {
  const ws = new FakeSocket(0)
  const h = harness(t, ws)
  assert.equal(ws.sent.length, 0)
  assert.equal(ws.listenerCount('open'), 1)
  h.state.transitConfig.text = 'Unsaved operator draft'
  ws.open()
  ws.open()
  assert.deepEqual(ws.sent, [{ type: 'GET_TRANSIT_CONFIG' }])
  ws.reply(config({ text: 'Previously saved text' }))
  assert.equal(h.state.transitConfig.text, 'Unsaved operator draft')
  assert.equal(h.state.loadedSocket, ws)
  assert.equal(h.state.draftDirty, true)
})

test('saving is rejected until the initial configuration response is received', async t => {
  const ws = new FakeSocket()
  const h = harness(t, ws)
  h.state.transitConfig.text = 'Pending draft'
  await h.state.saveTransitConfig()
  assert.deepEqual(ws.sent, [{ type: 'GET_TRANSIT_CONFIG' }])
  assert.match(h.messages.at(-1).message, /尚未加载/)
  assert.equal(h.state.savingTransit.value, false)
  assert.equal(h.timers.size, 0)
  ws.reply(config())
  await h.state.saveTransitConfig()
  assert.equal(ws.sent.at(-1).type, 'SET_TRANSIT_CONFIG')
  assert.equal(ws.sent.at(-1).data.text, 'Pending draft')
  assert.equal(h.state.savingTransit.value, true)
  assert.equal(h.timers.size, 1)
})

test('successful saves accept backend canonicalization of equivalent audio paths', async t => {
  const ws = new FakeSocket()
  const h = harness(t, ws)
  ws.reply(config())
  Object.assign(h.state.transitConfig, config({
    enabled: true, type: 'mp3', mp3_mode: 'shuffle',
    mp3_file: './tone.mp3', mp3_files: ['./tone.mp3', '/app/tone.mp3'],
  }))
  await h.state.saveTransitConfig()
  assert.deepEqual(ws.sent.at(-1), { type: 'SET_TRANSIT_CONFIG', data: config({
    enabled: true, type: 'mp3', mp3_mode: 'shuffle',
    mp3_file: './tone.mp3', mp3_files: ['./tone.mp3', '/app/tone.mp3'],
  }) })
  ws.reply(config({
    enabled: true, type: 'mp3', mp3_mode: 'shuffle',
    mp3_file: './tone.mp3', mp3_files: ['./tone.mp3'],
  }))
  assert.deepEqual([...h.state.transitConfig.mp3_files], ['./tone.mp3'])
  assert.equal(h.state.savingTransit.value, false)
  assert.equal(h.state.transitSavedOk.value, true)
  assert.equal(h.state.draftDirty, false)
  assert.equal(h.timers.size, 0)
  assert.equal(ws.listenerCount('message'), 0)
})

test('edits made during a pending save are not replaced by its acknowledgment', async t => {
  const ws = new FakeSocket()
  const h = harness(t, ws)
  ws.reply(config())
  h.state.transitConfig.text = 'Submitted text'
  await h.state.saveTransitConfig()
  const submitted = ws.sent.at(-1).data
  h.state.transitConfig.text = 'Newer unsaved text'
  ws.reply(submitted)
  assert.equal(h.state.transitConfig.text, 'Newer unsaved text')
  assert.equal(h.state.savingTransit.value, false)
  assert.equal(h.state.transitSavedOk.value, false)
  assert.equal(h.state.draftDirty, true)
  assert.equal(h.timers.size, 0)
})

test('socket replacement cancels old load/open/save listeners and preserves drafts', async t => {
  const connecting = new FakeSocket(0)
  const h = harness(t, connecting)
  const first = new FakeSocket()
  await h.replaceSocket(first)
  assert.equal(connecting.listenerCount(), 0)
  connecting.open()
  assert.equal(connecting.sent.length, 0)
  first.reply(config())
  h.state.transitConfig.text = 'Draft across reconnect'
  await h.state.saveTransitConfig()
  assert.equal(h.timers.size, 1)

  const replacement = new FakeSocket()
  await h.replaceSocket(replacement)
  assert.equal(first.listenerCount(), 0)
  assert.equal(h.timers.size, 0)
  assert.equal(h.state.savingTransit.value, false)
  assert.equal(h.state.loadedSocket, null)
  first.reply(config({ text: 'Late obsolete acknowledgment' }))
  replacement.reply(config({ text: 'Stored server text' }))
  assert.equal(h.state.transitConfig.text, 'Draft across reconnect')
  assert.equal(h.state.loadedSocket, replacement)
  assert.deepEqual(replacement.sent, [{ type: 'GET_TRANSIT_CONFIG' }])
})

test('socket close and component disposal remove pending listeners and timers', async t => {
  const loading = new FakeSocket()
  const first = harness(t, loading)
  assert.equal(loading.listenerCount('message'), 1)
  first.scope.stop()
  assert.equal(loading.listenerCount(), 0)

  const saving = new FakeSocket()
  const second = harness(t, saving)
  saving.reply(config())
  await second.state.saveTransitConfig()
  assert.equal(second.timers.size, 1)
  saving.close()
  assert.equal(second.timers.size, 0)
  assert.equal(saving.listenerCount('message'), 0)
  assert.equal(second.state.loadedSocket, null)
  assert.equal(second.state.savingTransit.value, false)
  second.scope.stop()
  assert.equal(saving.listenerCount(), 0)

  const pending = new FakeSocket()
  const third = harness(t, pending)
  pending.reply(config())
  await third.state.saveTransitConfig()
  third.scope.stop()
  assert.equal(third.timers.size, 0)
  assert.equal(pending.listenerCount(), 0)
})

test('audio picker keeps supported files, deduplicates and selects the next retained track', async t => {
  const h = harness(t, null, ['/audio/first.mp3', '/audio/second.WAV', '/audio/first.mp3', '/audio/no.txt'])
  await h.state.pickTransitMp3()
  assert.deepEqual([...h.state.transitConfig.mp3_files], ['/audio/first.mp3', '/audio/second.WAV'])
  assert.equal(h.state.transitConfig.mp3_file, '/audio/first.mp3')
  assert.equal(h.messages.at(-1).type, 'warning')
  h.state.removeTransitMp3('/audio/first.mp3')
  assert.equal(h.state.transitConfig.mp3_file, '/audio/second.WAV')
  assert.deepEqual([...h.state.transitConfig.mp3_files], ['/audio/second.WAV'])
})
