import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { flushBackendDiagnostics } from '../src/main/diagnostics-flush.mjs'
import { registerDiagnosticsFlush } from '../../src/diagnostics/flush.js'
import { RobotDiagnostics } from '../../src/diagnostics/robot-diagnostics.js'
import { createDiagnosticsReport } from '../../src/diagnostics/report.js'

function channel(collectors) {
  const backend = new EventEmitter(), port = new EventEmitter()
  backend.postMessage = data => port.emit('message', { data })
  port.postMessage = message => backend.emit('message', message)
  const dispose = registerDiagnosticsFlush(port, collectors)
  return { backend, port, dispose }
}

test('immediate export drains a queued failure from the selected backend', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'export-flush-'))
  const recorder = new RobotDiagnostics({ directory })
  const h = channel([recorder])
  t.after(async () => { h.dispose(); await recorder.destroy(); await rm(directory, { recursive: true, force: true }) })
  recorder.event('robot-goal-result', { commandId: 1, reason: 'failed', errorCode: 'GOAL_ACK_TIMEOUT', heartbeatCount: 5 })
  const status = await flushBackendDiagnostics(h.backend)
  assert.equal(status, 'flushed')
  const report = JSON.parse(await createDiagnosticsReport({ directory, metadata: { diagnosticsFlush: status } }))
  assert.equal(report.robot.incidents.at(-1).trigger.errorCode, 'GOAL_ACK_TIMEOUT')
  assert.ok(report.robot.findings.some(item => item.code === 'ACK_TIMEOUT_WITH_HEARTBEATS'))
  assert.equal(h.backend.listenerCount('message'), 0)
  assert.equal(h.backend.listenerCount('exit'), 0)
})

test('flush replies correlate requests and wait for all writers without crossing machines', async () => {
  let finishFirst, finishSecond
  const first = channel([{ flush: () => new Promise(resolve => { finishFirst = resolve }) }])
  const second = channel([{ flush: () => new Promise(resolve => { finishSecond = resolve }) }])
  let completed = false
  const a = flushBackendDiagnostics(first.backend).then(value => { completed = true; return value })
  const b = flushBackendDiagnostics(second.backend)
  first.backend.emit('message', { type: 'DIAGNOSTICS_FLUSHED', requestId: '0'.repeat(32), ok: true })
  first.backend.emit('message', { type: 'UI_PORT', port: 3001 })
  finishSecond()
  assert.equal(await b, 'flushed')
  assert.equal(completed, false)
  finishFirst()
  assert.equal(await a, 'flushed')
  first.dispose(); second.dispose()
})

test('dead, old, stalled and failed backends cannot prevent persisted export', async () => {
  assert.equal(await flushBackendDiagnostics(null), 'unavailable')
  const backend = new EventEmitter()
  backend.postMessage = () => {}
  const stalled = flushBackendDiagnostics(backend, { timeoutMs: 10 })
  assert.equal(await stalled, 'timeout')
  const exited = flushBackendDiagnostics(backend)
  backend.emit('exit', 1)
  assert.equal(await exited, 'unavailable')
  backend.postMessage = () => { throw new Error('private path') }
  assert.equal(await flushBackendDiagnostics(backend), 'failed')
  assert.equal(backend.listenerCount('message'), 0)
  assert.equal(backend.listenerCount('exit'), 0)
})

test('disk failures and rejecting collectors return only a safe failed status', async () => {
  for (const collector of [
    { flush() { throw new Error('private disk path') } },
    { flush() {}, snapshot: () => ({ storage: { status: 'error', errorCode: 'ENOSPC' } }) },
    { flush() {}, snapshot: () => ({ incidentStorage: { status: 'error', errorCode: 'EACCES' } }) },
    { flush() {}, snapshot: () => ({ status: 'error', errorCode: 'EIO' }) },
  ]) {
    const h = channel([collector])
    assert.equal(await flushBackendDiagnostics(h.backend), 'failed')
    h.dispose()
  }
})

test('backend ignores malformed requests and tolerates the desktop closing during flush', async () => {
  let called = 0, finish
  const h = channel([{ flush() { called++; return new Promise(resolve => { finish = resolve }) } }])
  h.port.emit('message', { data: { type: 'FLUSH_DIAGNOSTICS', requestId: 'private-invalid' } })
  h.port.emit('message', { data: { type: 'UNRELATED' } })
  assert.equal(called, 0)
  const pending = flushBackendDiagnostics(h.backend)
  h.backend.emit('exit', 1)
  assert.equal(await pending, 'unavailable')
  h.port.postMessage = () => { throw new Error('closed port') }
  finish()
  await new Promise(resolve => setImmediate(resolve))
  h.dispose()
  assert.equal(h.port.listenerCount('message'), 0)
})
