import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { createBackendRestarter } from '../src/main/backend-restart.mjs'
import { backendEnvironment } from '../../src/packaging/machine-profile.js'
import * as speechProfiles from '../../src/config/speech-profiles.js'
import * as ocrPrompt from '../../src/phase2/ocr/judge-prompt.js'

function fakeClock() {
  let now = 0, nextId = 0
  const timers = new Map()
  return {
    schedule(callback, delay) {
      const id = ++nextId
      timers.set(id, { at: now + delay, callback })
      return id
    },
    cancel(id) { timers.delete(id) },
    callbacks() { return [...timers.values()].map(timer => timer.callback) },
    count() { return timers.size },
    tick(ms) {
      const end = now + ms
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        const [id, timer] = next
        timers.delete(id)
        now = timer.at
        timer.callback()
      }
      now = end
    },
  }
}

class FakeBackend extends EventEmitter {
  kills = 0
  killBehavior = () => true
  kill() { this.kills++; return this.killBehavior() }
}

function fixture({ backend = new FakeBackend(), startBackend } = {}) {
  const clock = fakeClock()
  let starts = 0, closing = false, current = backend
  const restarter = createBackendRestarter({
    getBackend: () => current,
    startBackend: () => { starts++; return startBackend?.() },
    isClosing: () => closing,
    schedule: clock.schedule, cancel: clock.cancel,
  })
  return { restarter, backend, clock, starts: () => starts,
    setBackend: value => { current = value }, close: () => { closing = true } }
}

test('rapid saves share one restart and retain the 250 ms delay after confirmed exit', async () => {
  const h = fixture()
  const first = h.restarter.request()
  assert.equal(h.restarter.request(), first)
  assert.equal(h.backend.kills, 1)
  h.clock.tick(9000)
  assert.equal(h.starts(), 0, 'termination request alone cannot start another backend')
  h.backend.emit('exit', 0)
  assert.equal(h.backend.listenerCount('exit'), 0)
  assert.equal(h.restarter.request(), first)
  h.clock.tick(249)
  assert.equal(h.starts(), 0)
  h.clock.tick(1)
  assert.deepEqual(await first, { ok: true })
  assert.equal(h.starts(), 1)
  assert.equal(h.clock.count(), 0)
})

for (const failure of ['false', 'throw']) {
  test(`kill ${failure} clears listeners and timers and allows a subsequent request`, async () => {
    const h = fixture()
    h.backend.killBehavior = () => {
      if (failure === 'throw') throw new Error('termination failed')
      return false
    }
    const failed = await h.restarter.request()
    assert.equal(failed.ok, false)
    assert.match(failed.error, failure === 'throw' ? /termination failed/ : /无法停止旧后台/)
    assert.equal(h.backend.listenerCount('exit'), 0)
    assert.equal(h.clock.count(), 0)
    h.clock.tick(20_000)
    assert.equal(h.starts(), 0)
    h.backend.killBehavior = () => true
    const retry = h.restarter.request()
    h.backend.emit('exit', 0)
    h.clock.tick(250)
    assert.deepEqual(await retry, { ok: true })
    assert.equal(h.backend.kills, 2)
    assert.equal(h.starts(), 1)
  })
}

test('a process that never exits fails within 10 seconds and late exit cannot revive a timed out restart', async () => {
  const h = fixture()
  const first = h.restarter.request()
  const oldExit = h.backend.listeners('exit')[0]
  h.clock.tick(9999)
  assert.equal(h.backend.listenerCount('exit'), 1)
  assert.equal(h.starts(), 0)
  h.clock.tick(1)
  assert.match((await first).error, /退出超时/)
  assert.equal(h.backend.listenerCount('exit'), 0)
  assert.equal(h.clock.count(), 0)
  const retry = h.restarter.request()
  oldExit()
  h.clock.tick(250)
  assert.equal(h.starts(), 0, 'stale exit callbacks cannot complete a newer request')
  h.backend.emit('exit', 0)
  h.clock.tick(250)
  assert.deepEqual(await retry, { ok: true })
  assert.equal(h.starts(), 1)
})

for (const stage of ['waiting-for-exit', 'waiting-for-launch']) {
  test(`dispose cancels ${stage}, resolves callers and ignores already queued callbacks`, async () => {
    const h = fixture()
    const result = h.restarter.request()
    const oldExit = h.backend.listeners('exit')[0]
    if (stage === 'waiting-for-launch') h.backend.emit('exit', 0)
    const callbacks = h.clock.callbacks()
    h.restarter.dispose()
    assert.deepEqual(await result, { ok: false, error: '工作区已关闭' })
    assert.equal(h.backend.listenerCount('exit'), 0)
    assert.equal(h.clock.count(), 0)
    oldExit()
    callbacks.forEach(callback => callback())
    h.backend.emit('exit', 0)
    h.clock.tick(20_000)
    assert.equal(h.starts(), 0)
    assert.equal((await h.restarter.request()).ok, false)
    assert.equal(h.backend.kills, 1)
  })
}

test('closing observed immediately before launch cancels the restart', async () => {
  const h = fixture({ backend: null })
  const result = h.restarter.request()
  h.close()
  h.clock.tick(250)
  assert.equal((await result).ok, false)
  assert.equal(h.starts(), 0)
  assert.equal(h.clock.count(), 0)
})

for (const outcome of ['success', 'false', 'throw']) {
  test(`synchronous exit during kill handles its ${outcome} outcome without duplicate launches`, async () => {
    const h = fixture()
    h.backend.killBehavior = () => {
      h.backend.emit('exit', 0)
      h.backend.emit('exit', 0)
      if (outcome === 'throw') throw new Error('kill failed after exit')
      return outcome !== 'false'
    }
    const result = h.restarter.request()
    h.clock.tick(20_000)
    assert.equal((await result).ok, outcome === 'success')
    assert.equal(h.starts(), outcome === 'success' ? 1 : 0)
    assert.equal(h.backend.listenerCount('exit'), 0)
    assert.equal(h.clock.count(), 0)
  })
}

test('an exit before the deadline wins even if the canceled timeout callback is already queued', async () => {
  const h = fixture()
  const result = h.restarter.request()
  const [timeout] = h.clock.callbacks()
  h.clock.tick(9999)
  h.backend.emit('exit', 0)
  timeout()
  h.clock.tick(250)
  assert.deepEqual(await result, { ok: true })
  assert.equal(h.starts(), 1)
})

test('no backend still coalesces requests and synchronous launch failure can be retried', async () => {
  let failure = true
  const h = fixture({ backend: null, startBackend: () => {
    if (failure) throw new Error('fork unavailable')
  } })
  const first = h.restarter.request()
  assert.equal(h.restarter.request(), first)
  h.clock.tick(250)
  assert.match((await first).error, /fork unavailable/)
  assert.equal(h.clock.count(), 0)
  failure = false
  const retry = h.restarter.request()
  h.clock.tick(250)
  assert.deepEqual(await retry, { ok: true })
  assert.equal(h.starts(), 2)
})

// Execute the actual runtime with only Electron/process boundaries replaced.
// This verifies the IPC wiring, latest on-disk settings and machine isolation.
function runtimeFixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'backend-restart-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const clock = fakeClock(), children = [], runtimes = [], messages = []
  const dependencies = {
    ...fs, ...crypto, ...speechProfiles, ...ocrPrompt, join, backendEnvironment,
    require: createRequire(import.meta.url),
    app: { isPackaged: false }, BrowserWindow: {}, dialog: {}, systemPreferences: {}, desktopCapturer: {}, shell: {},
    RollingLog: class { append() {} async flush() {} },
    createDiagnosticsReport() {}, seedMachineProfile: () => ({ environmentCreated: false }),
    createBackendRestarter: options => createBackendRestarter({ ...options, schedule: clock.schedule, cancel: clock.cancel }),
    utilityProcess: { fork(_entry, _args, { env }) {
      const backend = new FakeBackend()
      children.push({ backend, env, settingsAtLaunch: fs.readFileSync(env.DOTENV_CONFIG_PATH, 'utf8') })
      return backend
    } },
  }
  const source = fs.readFileSync(new URL('../src/main/machine-runtime.js', import.meta.url), 'utf8')
  const bindings = Object.entries(dependencies).filter(([key]) => key !== 'default')
  const createRuntime = new Function(...bindings.map(([key]) => key), source
    .replace(/^import .*$/gm, '')
    .replace('export function createMachineRuntime', 'return function createMachineRuntime'))(...bindings.map(([, value]) => value))
  for (const id of [1, 2, 3]) {
    const machineRoot = join(root, `machine-${id}`)
    fs.mkdirSync(machineRoot)
    fs.writeFileSync(join(machineRoot, '.env'), `TTS_VOICE_TYPE=voice-${id}\n`)
    const runtime = createRuntime({ profile: { id, root: machineRoot, diagnosticsDir: machineRoot }, projectRoot: root,
      view: { webContents: { isDestroyed: () => false, send: (channel, payload) => messages.push({ id, channel, payload }) } } })
    runtime.start()
    runtimes.push(runtime)
  }
  t.after(() => runtimes.forEach(runtime => runtime.dispose()))
  return { root, clock, children, runtimes, messages }
}

test('runtime restarts only the selected machine, reads final saved settings at launch, and retains other ports', async t => {
  const h = runtimeFixture(t)
  const [first, second, third] = h.children
  h.children.forEach(({ backend }, index) => backend.emit('message', { type: 'UI_PORT', port: 3001 + index }))
  const runtime = h.runtimes[1]
  const save = changes => runtime.handlers.get('write-public-env')(null, changes)
  assert.equal(save({ TTS_VOICE_TYPE: 'first-save' }).ok, true)
  const restart = runtime.handlers.get('restart-backend')()
  assert.equal(save({ TTS_VOICE_TYPE: 'final-save' }).ok, true)
  assert.equal(runtime.handlers.get('restart-backend')(), restart)
  h.clock.tick(9000)
  assert.equal(h.children.length, 3)
  second.backend.emit('exit', 0)
  assert.equal(save({ TTS_VOICE_TYPE: 'last-save-before-launch' }).ok, true)
  h.clock.tick(250)
  assert.deepEqual(await restart, { ok: true })
  assert.equal(h.children.length, 4)
  assert.match(h.children[3].settingsAtLaunch, /^TTS_VOICE_TYPE=last-save-before-launch$/m)
  assert.equal(h.children[3].env.MACHINE_ID, '2')
  assert.equal(h.children[3].env.DOTENV_CONFIG_PATH, join(h.root, 'machine-2', '.env'))
  assert.equal(first.backend.kills, 0)
  assert.equal(third.backend.kills, 0)
  assert.equal(second.backend.kills, 1)
  assert.deepEqual(h.runtimes[0].handlers.get('get-backend-status')(), { running: true, port: 3001 })
  assert.deepEqual(h.runtimes[2].handlers.get('get-backend-status')(), { running: true, port: 3003 })
})

test('runtime IPC reports termination failure and timeout; shutdown cancels pending restart despite kill throwing', async t => {
  const h = runtimeFixture(t)
  const [first, second, third] = h.children
  first.backend.killBehavior = () => false
  assert.equal((await h.runtimes[0].handlers.get('restart-backend')()).ok, false)
  assert.equal(first.backend.listenerCount('exit'), 1, 'only the regular lifecycle listener remains')
  const timeout = h.runtimes[1].handlers.get('restart-backend')()
  h.clock.tick(10_000)
  assert.match((await timeout).error, /退出超时/)
  assert.equal(second.backend.listenerCount('exit'), 1)
  const canceled = h.runtimes[2].handlers.get('restart-backend')()
  third.backend.killBehavior = () => { throw new Error('shutdown kill failed') }
  assert.doesNotThrow(() => h.runtimes[2].dispose())
  assert.equal((await canceled).ok, false)
  third.backend.emit('exit', 0)
  h.clock.tick(20_000)
  assert.equal(h.children.length, 3)
  assert.equal(h.clock.count(), 0)
})

test('runtime startup failure returns through the restart IPC and existing backend-exit event', async t => {
  const h = runtimeFixture(t)
  const runtime = h.runtimes[0]
  h.children[0].backend.emit('exit', 0)
  fs.rmSync(join(h.root, 'machine-1', '.env'))
  const result = runtime.handlers.get('restart-backend')()
  h.clock.tick(250)
  assert.match((await result).error, /启动后端进程失败/)
  const report = h.messages.findLast(message => message.id === 1 && message.channel === 'backend-exit')
  assert.match(report.payload.stderr, /启动后端进程失败/)
  assert.equal(runtime.handlers.get('get-backend-status')().running, false)
})

test('settings UI awaits completion and displays a returned restart failure without a false success timer', async () => {
  const source = fs.readFileSync(new URL('../src/renderer/src/components/SystemSettings.vue', import.meta.url), 'utf8')
  const triggerSource = source.match(/async function triggerRestart\(\) \{[\s\S]*?\n\}/)[0]
  const messages = [], restartMsg = { value: '' }
  let resolve
  const completion = new Promise(done => { resolve = done })
  const trigger = new Function('window', 'restartMsg', 'ElMessage', 'setTimeout', `${triggerSource}; return triggerRestart`)(
    { api: { restartBackend: () => completion } }, restartMsg, { error: message => messages.push(message) },
    () => assert.fail('completion must come from the backend, not a fixed timer'))
  const result = trigger()
  assert.equal(restartMsg.value, '已保存，后端重启中…')
  resolve({ ok: false, error: '等待旧后台退出超时' })
  await result
  assert.match(restartMsg.value, /重启失败：等待旧后台退出超时/)
  assert.deepEqual(messages, [restartMsg.value])
})
