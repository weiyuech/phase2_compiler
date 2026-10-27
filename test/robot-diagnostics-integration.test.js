import assert from 'node:assert/strict'
import test from 'node:test'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import { RobotListener } from '../src/robot/listener.js'
import { RobotDiagnostics } from '../src/diagnostics/robot-diagnostics.js'
import { createDiagnosticsReport } from '../src/diagnostics/report.js'

// Exercise the production producer, privacy filter, persistent recorder and
// default exporter together. These endpoints only listen on local loopback.
const item = { map_name: 'PRIVATE_MAP_NAME', path_name: '1.1', goal_id: 4, goal_object: 'PRIVATE_OBJECT_NAME' }
const heartbeat = () => ({
  system: { status: 'ready' }, map: { name: item.map_name, status: 'ready' },
  task: { path_file: item.path_name, goal_id: item.goal_id, goal_status: 'done', object_status: 'going' },
})
const ack = extra => ({ robot_goal: {
  path_file: item.path_name, goal_id: item.goal_id, goal_object: item.goal_object, goal_check: true, ...extra,
} })

async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'robot-recorder-integration-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

function quiet(t) {
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', () => {})
}

async function connectedMachine(t, respond) {
  const directory = await temporary(t)
  const diagnostics = new RobotDiagnostics({ directory })
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  const robot = new RobotListener({ url: `ws://127.0.0.1:${server.address().port}`,
    diagnostics, ackTimeoutMs: 250, arrivalTimeoutMs: 500 })
  t.after(async () => {
    robot.stop()
    for (const socket of server.clients) socket.terminate()
    await new Promise(resolve => server.close(resolve))
    await diagnostics.destroy()
  })
  let peer
  const commands = []
  server.on('connection', socket => {
    peer = socket
    socket.on('message', raw => {
      const command = JSON.parse(raw.toString())
      commands.push(command)
      respond(socket, command)
    })
    socket.send(JSON.stringify(heartbeat()))
  })
  const ready = once(robot, 'heartbeat')
  robot.start()
  await ready
  return { directory, diagnostics, robot, peer, commands }
}

test('real failed connection reaches the default report as unopened, with no invented established-drop finding', { timeout: 5000 }, async t => {
  quiet(t)
  const directory = await temporary(t)
  const diagnostics = new RobotDiagnostics({ directory })
  const reservation = createServer()
  reservation.listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const { port } = reservation.address()
  await new Promise(resolve => reservation.close(resolve))
  const robot = new RobotListener({ url: `ws://127.0.0.1:${port}`, diagnostics })
  t.after(async () => { robot.stop(); await diagnostics.destroy() })
  const disconnected = once(robot, 'disconnected')
  robot.start()
  await disconnected
  robot.stop()
  await diagnostics.flush()
  const report = JSON.parse(await createDiagnosticsReport({ directory, metadata: { machineId: 1 } }))
  const error = report.robot.events.find(event => event.type === 'robot-connection-error')
  const closed = report.robot.events.find(event => event.type === 'robot-connection-close')
  assert.equal(error.errorCode, 'ECONNREFUSED')
  assert.equal(error.stage, 'connect')
  assert.equal(closed.opened, false)
  assert.equal(error.attemptId, closed.attemptId)
  assert.ok(report.robot.events.some(event => event.type === 'robot-connection-retry' && event.retryDelayMs === 5000))
  assert.equal(report.robot.incidents.length, 1)
  assert.equal(report.robot.incidents[0].trigger.type, 'robot-connection-close')
  assert.ok(report.robot.findings.some(finding => finding.code === 'CONNECTION_NOT_ESTABLISHED'))
  assert.equal(report.robot.findings.some(finding => finding.code === 'ESTABLISHED_CONNECTION_CLOSED'), false)
  assert.equal(JSON.stringify(report).includes('ws://'), false)
  assert.equal(report.backendHistory, undefined)
})

test('actual mismatched ACK plus continuing heartbeats survives recording/export and is isolated from a second machine', { timeout: 7000 }, async t => {
  quiet(t)
  const failed = await connectedMachine(t, socket => {
    socket.send(JSON.stringify(ack({ path_file: 1.1, goal_id: '4', goal_object: undefined })))
    for (let i = 0; i < 15; i++) socket.send(JSON.stringify(heartbeat()))
  })
  const healthy = await connectedMachine(t, socket => {
    socket.send(JSON.stringify(ack()))
    socket.send(JSON.stringify(heartbeat()))
  })
  await Promise.all([
    assert.rejects(failed.robot.sendSetGoal(item), { code: 'GOAL_ACK_TIMEOUT' }),
    assert.doesNotReject(healthy.robot.sendSetGoal(item)),
  ])
  const closed = once(failed.robot, 'disconnected')
  failed.peer.close(1000, 'PRIVATE_CLOSE_REASON')
  await closed
  failed.robot.stop()
  await Promise.all([failed.diagnostics.flush(), healthy.diagnostics.flush()])
  const first = JSON.parse(await createDiagnosticsReport({ directory: failed.directory, metadata: { machineId: 1 } }))
  const second = JSON.parse(await createDiagnosticsReport({ directory: healthy.directory, metadata: { machineId: 2 } }))
  const sent = first.robot.events.find(event => event.type === 'robot-goal-sent')
  const reply = first.robot.events.find(event => event.type === 'robot-goal-reply')
  const result = first.robot.events.find(event => event.type === 'robot-goal-result')
  assert.equal(reply.commandId, sent.commandId)
  assert.equal(result.commandId, sent.commandId)
  assert.equal(reply.expectedPathType, 'string')
  assert.equal(reply.receivedPathType, 'number')
  assert.equal(reply.receivedGoalIdType, 'string')
  assert.equal(reply.receivedGoalId, 4)
  assert.equal(reply.receivedObjectType, 'undefined')
  assert.equal(reply.reason, 'path-mismatch')
  assert.equal(reply.pathMatches, false)
  assert.equal(reply.goalIdMatches, true)
  assert.equal(reply.objectMatches, false)
  assert.equal(result.errorCode, 'GOAL_ACK_TIMEOUT')
  assert.equal(result.stage, 'ack')
  assert.equal(result.heartbeatCount, 15)
  assert.equal(result.replyCount, 1)
  assert.equal(result.mismatchCount, 1)
  assert.equal(result.goalStatus, 'done')
  assert.ok(result.lastHeartbeatAgeMs >= 0)
  assert.equal(result.expectedPathHash, result.receivedPathHash)
  const codes = first.robot.findings.map(finding => finding.code)
  assert.ok(codes.includes('ACK_TIMEOUT_WITH_HEARTBEATS'))
  assert.ok(codes.includes('GOAL_REPLY_MISMATCH'))
  assert.ok(codes.includes('ESTABLISHED_CONNECTION_CLOSED'))
  assert.equal(codes.includes('CONNECTION_NOT_ESTABLISHED'), false)
  assert.ok(first.robot.incidents.some(incident => incident.trigger.errorCode === 'GOAL_ACK_TIMEOUT'))
  assert.equal(second.robot.incidents.length, 0)
  assert.deepEqual(second.robot.findings, [])
  assert.equal(second.robot.events.find(event => event.type === 'robot-goal-result').reason, 'arrived')
  assert.equal(first.metadata.machineId, 1)
  assert.equal(second.metadata.machineId, 2)
  assert.ok(first.robot.events.every(event => event.runId === failed.diagnostics.runId))
  assert.ok(second.robot.events.every(event => event.runId === healthy.diagnostics.runId))
  const otherSent = second.robot.events.find(event => event.type === 'robot-goal-sent')
  assert.notEqual(sent.expectedMapHash, otherSent.expectedMapHash)
  for (const report of [first, second]) {
    assert.equal(report.backendLogsIncluded, false)
    assert.equal(report.backendHistory, undefined)
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE_MAP_NAME|PRIVATE_OBJECT_NAME|PRIVATE_CLOSE_REASON|ws:\/\//)
  }
  const expectedWireCommand = { set_goal: { path_name: item.path_name, goal_id: item.goal_id, goal_object: item.goal_object } }
  assert.deepEqual(failed.commands, [expectedWireCommand])
  assert.deepEqual(healthy.commands, [expectedWireCommand])
})
