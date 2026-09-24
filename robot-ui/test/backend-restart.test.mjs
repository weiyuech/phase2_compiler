import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { createBackendRestarter } from '../src/main/backend-restart.mjs'

function harness() {
  let closing = false, starts = 0, kills = 0, current
  const timers = new Map()
  const backend = new EventEmitter()
  backend.kill = () => { kills++; return true }
  current = backend
  backend.on('exit', () => { current = null })
  const restarter = createBackendRestarter({
    getBackend: () => current, startBackend: () => { starts++; current = backend },
    isClosing: () => closing,
    schedule: (callback, ms) => { const id = Symbol(); timers.set(id, { callback, ms }); return id },
    cancel: id => timers.delete(id),
  })
  return { restarter, backend, timers, counts: () => ({ starts, kills }),
    quit() { closing = true; restarter.dispose() },
    tick() { const tasks = [...timers.values()]; timers.clear(); for (const task of tasks) task.callback() },
  }
}

test('repeated saves before exit and during restart delay produce exactly one backend', () => {
  const h = harness()
  for (let i = 0; i < 20; i++) assert.deepEqual(h.restarter.request(), { ok: true })
  assert.deepEqual(h.counts(), { starts: 0, kills: 1 })
  assert.equal(h.timers.size, 0)
  h.backend.emit('exit')
  for (let i = 0; i < 20; i++) h.restarter.request()
  assert.equal(h.timers.size, 1)
  assert.equal([...h.timers.values()][0].ms, 2000)
  h.tick()
  assert.deepEqual(h.counts(), { starts: 1, kills: 1 })
  h.restarter.request()
  h.backend.emit('exit')
  h.tick()
  assert.deepEqual(h.counts(), { starts: 2, kills: 2 })
})

test('quitting before exit or while restart is delayed cannot resurrect a backend', () => {
  for (const exitFirst of [false, true]) {
    const h = harness()
    h.restarter.request()
    if (exitFirst) h.backend.emit('exit')
    h.quit()
    if (!exitFirst) h.backend.emit('exit')
    h.tick()
    assert.equal(h.counts().starts, 0)
    assert.equal(h.restarter.request().ok, false)
    assert.equal(h.timers.size, 0)
  }
})

test('a failed kill allows a later retry and never starts a second backend', () => {
  const h = harness()
  const kill = h.backend.kill
  h.backend.kill = () => false
  assert.throws(() => h.restarter.request(), /无法停止旧后台/)
  h.backend.kill = kill
  h.restarter.request()
  h.backend.emit('exit')
  h.tick()
  assert.deepEqual(h.counts(), { starts: 1, kills: 1 })
})

test('repeated restart requests with no backend still schedule only one start', () => {
  const h = harness()
  h.backend.emit('exit')
  for (let i = 0; i < 20; i++) h.restarter.request()
  h.tick()
  assert.deepEqual(h.counts(), { starts: 1, kills: 0 })
})
