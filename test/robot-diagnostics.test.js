import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { RobotDiagnostics, readRobotHistory, readRobotIncidents } from '../src/diagnostics/robot-diagnostics.js'
import { createDiagnosticsReport } from '../src/diagnostics/report.js'
import { HISTORY_BYTES, RollingLog, readRollingLog } from '../src/diagnostics/rolling-log.js'

async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'robot-diagnostics-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

test('robot records remove private text and retain per-run identity and type correlation', async t => {
  const directory = await temporary(t)
  const diagnostics = new RobotDiagnostics({ directory })
  t.after(() => diagnostics.destroy())
  const secret = 'PRIVATE_https://robot.example/path?token=credential_C:\\Private\\场馆'
  diagnostics.event('robot-goal-sent', {
    commandId: 1, attemptId: 1, expectedMap: secret, expectedPath: secret, expectedGoalId: 4,
    expectedObject: secret, url: secret, error: secret, message: secret, closeReason: secret,
  })
  diagnostics.event('robot-goal-reply', {
    commandId: 1, attemptId: 1, receivedMap: secret, receivedPath: secret, receivedGoalId: '04',
    receivedObject: secret, goalCheck: 'true', pathMatches: true, goalIdMatches: false,
    objectMatches: true, reason: 'goal-id-mismatch', errorCode: secret,
  })
  diagnostics.event('robot-goal-result', { commandId: 1, reason: 'failed', errorCode: 'GOAL_ACK_TIMEOUT', heartbeatCount: 5 })
  assert.equal(diagnostics.event(secret, { message: secret }), false)
  await diagnostics.flush()
  const events = await readRobotHistory({ directory })
  const sent = events.find(event => event.type === 'robot-goal-sent')
  const reply = events.find(event => event.type === 'robot-goal-reply')
  assert.equal(sent.expectedPathHash, reply.receivedPathHash)
  assert.equal(sent.expectedMapHash, reply.receivedMapHash)
  assert.equal(sent.expectedObjectHash, reply.receivedObjectHash)
  assert.equal(sent.expectedPathLength, secret.length)
  assert.equal(sent.expectedGoalIdType, 'number')
  assert.equal(reply.receivedGoalIdType, 'string')
  assert.equal(reply.receivedGoalId, 4)
  assert.notEqual(sent.expectedGoalIdHash, reply.receivedGoalIdHash)
  assert.equal(reply.goalCheck, 'true')
  assert.equal(reply.goalCheckType, 'string')
  assert.equal(reply.errorCode, 'OTHER')
  assert.equal(reply.goalIdMatches, false)
  const report = await createDiagnosticsReport({ directory, metadata: { machineId: 1, diagnosticsFlush: 'flushed' } })
  for (const text of [report, JSON.stringify(diagnostics.snapshot()),
    await readRollingLog({ directory, name: 'robot-diagnostics.log' }),
    await readRollingLog({ directory, name: 'robot-incidents.log' })]) {
    assert.equal(text.includes(secret), false)
    assert.equal(text.includes('robot.example'), false)
  }
  const secondDirectory = await temporary(t)
  const second = new RobotDiagnostics({ directory: secondDirectory })
  t.after(() => second.destroy())
  second.event('robot-goal-sent', { expectedPath: secret })
  assert.notEqual(second.snapshot().events.at(-1).expectedPathHash, sent.expectedPathHash)
})

test('default export includes failure facts and correlates connection error with close', async t => {
  const directory = await temporary(t)
  const diagnostics = new RobotDiagnostics({ directory })
  t.after(() => diagnostics.destroy())
  diagnostics.event('robot-connection-attempt', { attemptId: 1, opened: false, stage: 'connect' })
  diagnostics.event('robot-connection-error', { attemptId: 1, opened: false, stage: 'connect', errorCode: 'ECONNREFUSED' })
  diagnostics.event('robot-connection-close', { attemptId: 1, opened: false, stage: 'connect', closeCode: 1006 })
  diagnostics.event('robot-connection-open', { attemptId: 2, opened: true, stage: 'socket' })
  diagnostics.event('robot-goal-sent', { attemptId: 2, commandId: 1, expectedPath: 'private-route', expectedGoalId: 4 })
  diagnostics.event('robot-goal-reply', { attemptId: 2, commandId: 1, receivedPath: 'other-route',
    pathMatches: false, goalIdMatches: true, objectMatches: true, reason: 'path-mismatch' })
  diagnostics.event('robot-goal-result', { attemptId: 2, commandId: 1, reason: 'failed', stage: 'ack',
    errorCode: 'GOAL_ACK_TIMEOUT', heartbeatCount: 5, lastHeartbeatAgeMs: 55, replyCount: 1, mismatchCount: 1 })
  diagnostics.event('robot-connection-close', { attemptId: 2, opened: true, stage: 'socket', closeCode: 1006 })
  await diagnostics.flush()
  const report = JSON.parse(await createDiagnosticsReport({ directory, metadata: { machineId: 2, diagnosticsFlush: 'flushed' } }))
  assert.equal(report.robot.schemaVersion, 1)
  assert.equal(report.robot.available, true)
  assert.equal(report.backendLogsIncluded, false)
  assert.equal(report.backendHistory, undefined)
  assert.equal(report.metadata.machineId, 2)
  assert.equal(report.metadata.diagnosticsFlush, 'flushed')
  assert.equal(report.robot.incidents.filter(incident => incident.trigger.attemptId === 1).length, 1)
  assert.equal(report.robot.incidents[0].trigger.type, 'robot-connection-close')
  const codes = report.robot.findings.map(finding => finding.code)
  assert.ok(codes.includes('CONNECTION_NOT_ESTABLISHED'))
  assert.ok(codes.includes('ESTABLISHED_CONNECTION_CLOSED'))
  assert.ok(codes.includes('ACK_TIMEOUT_WITH_HEARTBEATS'))
  assert.ok(codes.includes('GOAL_REPLY_MISMATCH'))
  assert.equal(report.robot.findings.find(finding => finding.code === 'ACK_TIMEOUT_WITH_HEARTBEATS').count, 1)
  assert.equal(JSON.stringify(report).includes('private-route'), false)
  assert.equal(JSON.stringify(report).includes('other-route'), false)
})

test('successful results and operator cancellation do not create fault incidents', async t => {
  const directory = await temporary(t)
  const diagnostics = new RobotDiagnostics({ directory })
  t.after(() => diagnostics.destroy())
  diagnostics.event('robot-goal-result', { commandId: 1, reason: 'arrived', errorCode: undefined })
  diagnostics.event('robot-goal-result', { commandId: 2, reason: 'failed', errorCode: 'GOAL_CANCELLED' })
  diagnostics.event('robot-connection-stopped', { attemptId: 1, reason: 'stopped' })
  await diagnostics.flush()
  assert.equal((await readRobotIncidents({ directory })).length, 0)
  const result = (await readRobotHistory({ directory })).find(event => event.reason === 'arrived')
  assert.equal(result.errorCode, undefined)
  assert.deepEqual(JSON.parse(await createDiagnosticsReport({ directory })).robot.findings, [])
  diagnostics.event('robot-goal-result', { commandId: 3, reason: 'failed', errorCode: undefined })
  await diagnostics.flush()
  assert.equal((await readRobotIncidents({ directory })).length, 1)
})

test('heartbeat storms are bounded and the terminal failure always survives the throttle', async t => {
  const directory = await temporary(t)
  let now = 0
  const diagnostics = new RobotDiagnostics({ directory, monotonic: () => now })
  t.after(() => diagnostics.destroy())
  for (let i = 0; i < 100000; i++) {
    diagnostics.event('robot-heartbeat', { attemptId: 1, receivedGoalId: i, mapStatus: 'private-untrusted-state', goalStatus: 'going' })
  }
  const first = diagnostics.snapshot()
  assert.equal(first.events.filter(event => event.type === 'robot-heartbeat').length, 20)
  assert.equal(first.suppressedHeartbeats, 99980)
  assert.ok(first.storage.queuedBytes <= 64 * 1024)
  now = 10001
  diagnostics.event('robot-heartbeat', { attemptId: 1, receivedGoalId: 99999, goalStatus: 'going' })
  diagnostics.event('robot-goal-result', { commandId: 1, reason: 'failed', errorCode: 'GOAL_ACK_TIMEOUT', heartbeatCount: 100001 })
  await diagnostics.flush()
  const incidents = await readRobotIncidents({ directory })
  assert.equal(incidents.at(-1).trigger.heartbeatCount, 100001)
  assert.equal(incidents.at(-1).trigger.errorCode, 'GOAL_ACK_TIMEOUT')
  assert.ok(incidents.at(-1).events.length <= 80)
  const lines = (await readRollingLog({ directory, name: 'robot-incidents.log' })).trim().split('\n')
  assert.ok(lines.every(line => Buffer.byteLength(line) <= 12 * 1024))
  assert.ok(diagnostics.snapshot().storage.truncatedRecords === 0)
})

test('failure snapshots remain available after ordinary navigation and audio histories rotate', async t => {
  const directory = await temporary(t)
  const diagnostics = new RobotDiagnostics({ directory })
  const audio = new RollingLog({ directory, name: 'audio-diagnostics.log' })
  t.after(async () => { await diagnostics.destroy(); await audio.destroy() })
  diagnostics.event('robot-goal-sent', { commandId: 1, expectedPath: 'sensitive-route', expectedGoalId: 4 })
  diagnostics.event('robot-goal-result', { commandId: 1, reason: 'failed', errorCode: 'GOAL_ACK_TIMEOUT', heartbeatCount: 2 })
  await diagnostics.flush()
  for (let batch = 0; batch < 50; batch++) {
    for (let i = 0; i < 120; i++) diagnostics.event('robot-goal-sent', { commandId: 2 + batch * 120 + i, expectedGoalId: i })
    audio.append('audio-runtime-record\n'.repeat(500))
    await Promise.all([diagnostics.flush(), audio.flush()])
  }
  const events = await readRobotHistory({ directory })
  assert.equal(events.some(event => event.errorCode === 'GOAL_ACK_TIMEOUT'), false)
  const report = JSON.parse(await createDiagnosticsReport({ directory }))
  assert.equal(report.robot.incidents.length, 1)
  assert.equal(report.robot.incidents[0].trigger.errorCode, 'GOAL_ACK_TIMEOUT')
  assert.ok(report.robot.incidents[0].events.some(event => event.type === 'robot-goal-sent' && event.commandId === 1))
  assert.ok(report.robot.findings.some(finding => finding.code === 'ACK_TIMEOUT_WITH_HEARTBEATS'))
  assert.ok(diagnostics.snapshot().storage.storedBytes <= HISTORY_BYTES)
  assert.ok(diagnostics.snapshot().incidentStorage.storedBytes <= HISTORY_BYTES)
})

test('a long goal wait preserves sent and mismatched reply evidence when its recent ring is trimmed', async t => {
  const directory = await temporary(t)
  let now = 0
  const diagnostics = new RobotDiagnostics({ directory, monotonic: () => now })
  t.after(() => diagnostics.destroy())
  diagnostics.event('robot-goal-sent', { commandId: 1, attemptId: 1, expectedPath: 'route-one', expectedGoalId: 4 })
  diagnostics.event('robot-goal-reply', { commandId: 1, attemptId: 1, receivedPath: 'route-two',
    pathMatches: false, goalIdMatches: true, objectMatches: true, reason: 'path-mismatch' })
  for (let i = 0; i < 100; i++) {
    now += 10001
    diagnostics.event('robot-goal-heartbeat', { commandId: 1, attemptId: 1, heartbeatCount: i + 1,
      expectedMap: 'map', expectedPath: 'route-one', expectedGoalId: 4, expectedObject: 'car',
      receivedMap: 'map', receivedPath: 'route-one', receivedGoalId: '4', receivedObject: 'car',
      mapStatus: 'ready', goalStatus: 'done', objectStatus: 'going', reason: 'before-ack' })
  }
  assert.equal(diagnostics.snapshot().events.some(event => event.type === 'robot-goal-sent'), false)
  diagnostics.event('robot-goal-result', { commandId: 1, attemptId: 1, reason: 'failed', errorCode: 'GOAL_ACK_TIMEOUT', heartbeatCount: 100 })
  await diagnostics.flush()
  const [incident] = await readRobotIncidents({ directory })
  assert.ok(incident.events.some(event => event.type === 'robot-goal-sent' && event.commandId === 1))
  assert.ok(incident.events.some(event => event.type === 'robot-goal-reply' && event.reason === 'path-mismatch'))
  assert.equal(incident.trigger.errorCode, 'GOAL_ACK_TIMEOUT')
  assert.ok(Buffer.byteLength(JSON.stringify(incident)) <= 12 * 1024)
})

test('old missing logs are explicitly unavailable and hostile persisted fields are revalidated', async t => {
  const directory = await temporary(t)
  const empty = JSON.parse(await createDiagnosticsReport({ directory, metadata: {
    machineId: 99, diagnosticsFlush: 'private-secret', appVersion: '1.1.0-test.1',
  } }))
  assert.equal(empty.robot.available, false)
  assert.equal(empty.robot.readError, false)
  assert.equal(empty.metadata.machineId, undefined)
  assert.equal(empty.metadata.diagnosticsFlush, undefined)
  assert.match(empty.robot.note, /不代表/)
  const secret = 'DO_NOT_EXPORT_PRIVATE_URL_TOKEN'
  const runId = 'abcddcba-1234-1234-1234-abcdefabcdef'
  const poisoned = { schemaVersion: 1, runId, ts: Date.now(), seq: 1,
    type: 'robot-goal-result', commandId: 3, reason: 'failed', errorCode: 'GOAL_ACK_TIMEOUT',
    expectedMap: secret, expectedPathHash: secret, expectedPathType: secret,
    expectedObject: secret, receivedGoalId: secret, url: secret, message: secret,
    pathMatches: secret, goalCheck: secret, arbitrary: secret }
  await writeFile(join(directory, 'robot-diagnostics.log'), [JSON.stringify(poisoned),
    JSON.stringify({ ...poisoned, runId: secret }), '{partial'].join('\n'))
  await writeFile(join(directory, 'robot-incidents.log'), JSON.stringify({
    schemaVersion: 1, runId, ts: poisoned.ts, incidentId: `${runId}:1`, trigger: poisoned,
    message: secret, events: [poisoned, { ...poisoned, runId: secret }],
  }) + '\n{partial')
  const reportText = await createDiagnosticsReport({ directory })
  assert.equal(reportText.includes(secret), false)
  const report = JSON.parse(reportText)
  assert.equal(report.robot.events.length, 1)
  assert.equal(report.robot.incidents.length, 1)
  assert.equal(report.robot.incidents[0].events.length, 1)
  assert.equal(report.robot.events[0].expectedPathHash, undefined)
  assert.equal(report.robot.events[0].receivedGoalId, undefined)
})

test('storage failure cannot throw or prevent in-memory failure capture', async t => {
  const directory = await temporary(t)
  const throwing = { append() { throw new Error('private disk path') },
    flush() { throw new Error('private disk path') }, destroy() { throw new Error('private disk path') },
    snapshot() { throw new Error('private disk path') } }
  const diagnostics = new RobotDiagnostics({ directory, writerFactory: () => throwing })
  assert.doesNotThrow(() => diagnostics.event('robot-goal-result', { commandId: 1, reason: 'failed' }))
  assert.equal(diagnostics.snapshot().incidents.length, 1)
  assert.equal(diagnostics.snapshot().storage.errorCode, 'IO_ERROR')
  await assert.doesNotReject(diagnostics.flush())
  await assert.doesNotReject(diagnostics.destroy())
  const missing = new RobotDiagnostics({ directory, writerFactory: () => { throw new Error('private disk path') } })
  assert.equal(missing.snapshot().storage.status, 'error')
  await missing.destroy()
  const rejected = new RobotDiagnostics({ directory, writerFactory: () => ({
    append: () => Promise.reject(new Error('private disk path')),
    flush: () => Promise.reject(new Error('private disk path')),
    destroy: () => Promise.reject(new Error('private disk path')),
  }) })
  rejected.event('robot-connection-error', { attemptId: 2, errorCode: 'ECONNRESET' })
  await nextTurn()
  await rejected.destroy()
  assert.equal(JSON.stringify(diagnostics.snapshot()).includes('private disk path'), false)
})

test('real ENOSPC remains a safe storage status while control events continue', async t => {
  const directory = await temporary(t)
  const diagnostics = new RobotDiagnostics({ directory, writerFactory: options => new RollingLog({
    ...options, appendFile: async () => { throw Object.assign(new Error('private filesystem path'), { code: 'ENOSPC' }) },
  }) })
  t.after(() => diagnostics.destroy())
  await diagnostics.flush()
  assert.equal(diagnostics.snapshot().storage.errorCode, 'ENOSPC')
  assert.equal(diagnostics.event('robot-goal-result', { commandId: 1, reason: 'failed', errorCode: 'GOAL_ACK_TIMEOUT' }), true)
  await diagnostics.flush()
  assert.equal(diagnostics.snapshot().incidents.length, 1)
  assert.equal(diagnostics.snapshot().incidentStorage.errorCode, 'ENOSPC')
  assert.equal(JSON.stringify(diagnostics.snapshot()).includes('private filesystem'), false)
})
