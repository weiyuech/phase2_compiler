import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { WebSocketServer } from 'ws'
import { RobotListener } from '../src/robot/listener.js'
import { GoalTracker } from '../src/robot/goal-tracker.js'

const item = { map_name: 'test-map', path_name: '1.1', goal_id: 4, goal_object: 'car' }
const heartbeat = (extra = {}) => ({
  system: { status: 'ready' }, map: { name: item.map_name, status: 'ready' },
  task: { path_file: item.path_name, goal_id: item.goal_id, goal_status: 'done', object_status: 'done', ...extra },
})
const ack = (extra = {}) => ({ path_file: item.path_name, goal_id: item.goal_id,
  goal_object: item.goal_object, goal_check: true, ...extra })
const recorder = () => {
  const events = []
  return { events, diagnostics: { event: (type, fields) => events.push({ type, ...fields }) } }
}

function silence(t) {
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', () => {})
}

test('failed loopback connection records an unopened attempt and fixed retry separately from a dropped session', { timeout: 3000 }, async t => {
  silence(t)
  const reservation = createServer()
  reservation.listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const { port } = reservation.address()
  await new Promise(resolve => reservation.close(resolve))
  const r = recorder()
  const robot = new RobotListener({ url: `ws://127.0.0.1:${port}`, diagnostics: r.diagnostics })
  t.after(() => robot.stop())
  const disconnected = once(robot, 'disconnected')
  robot.start()
  await disconnected
  const attempt = r.events.find(x => x.type === 'robot-connection-attempt')
  const error = r.events.find(x => x.type === 'robot-connection-error')
  const closed = r.events.find(x => x.type === 'robot-connection-close')
  const retry = r.events.find(x => x.type === 'robot-connection-retry')
  assert.equal(attempt.attemptId, 1)
  assert.equal(error.errorCode, 'ECONNREFUSED')
  assert.equal(error.stage, 'connect')
  assert.equal(closed.opened, false)
  assert.equal(closed.uptimeMs, null)
  assert.equal(closed.heartbeatAgeMs, null)
  assert.ok(closed.elapsedMs >= 0)
  assert.equal(retry.attemptId, attempt.attemptId)
  assert.equal(retry.retryDelayMs, 5000)
  assert.equal(r.events.some(x => x.type === 'robot-connection-open'), false)
  assert.equal(JSON.stringify(r.events).includes('ws://'), false)
  robot.stop()
  assert.equal(r.events.at(-1).type, 'robot-connection-stopped')
})

test('loopback goal timeout preserves heartbeat/mismatched ACK evidence, then exact ACK and arrival succeed', { timeout: 5000 }, async t => {
  silence(t)
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  const r = recorder()
  const robot = new RobotListener({ url: `ws://127.0.0.1:${server.address().port}`,
    ackTimeoutMs: 100, arrivalTimeoutMs: 200, diagnostics: r.diagnostics })
  t.after(async () => {
    robot.stop()
    for (const socket of server.clients) socket.terminate()
    await new Promise(resolve => server.close(resolve))
  })
  const connected = once(robot, 'connected')
  const accepted = once(server, 'connection')
  robot.start()
  const [socket] = await accepted
  await connected
  const firstHeartbeat = once(robot, 'heartbeat')
  socket.send(JSON.stringify(heartbeat()))
  await firstHeartbeat
  const commands = []
  socket.on('message', raw => {
    commands.push(JSON.parse(raw))
    if (commands.length === 1) {
      socket.send(JSON.stringify({ robot_goal: ack({ goal_object: undefined }) }))
      for (let i = 0; i < 15; i++) socket.send(JSON.stringify(heartbeat()))
    } else {
      socket.send(JSON.stringify({ robot_goal: ack() }))
      socket.send(JSON.stringify(heartbeat()))
    }
  })
  await assert.rejects(robot.sendSetGoal(item), { code: 'GOAL_ACK_TIMEOUT' })
  const mismatch = r.events.find(x => x.type === 'robot-goal-reply')
  assert.equal(mismatch.reason, 'object-mismatch')
  assert.equal(mismatch.pathMatches, true)
  assert.equal(mismatch.goalIdMatches, true)
  assert.equal(mismatch.objectMatches, false)
  assert.equal(mismatch.receivedObjectType, 'undefined')
  const timeout = r.events.find(x => x.type === 'robot-goal-result')
  assert.equal(timeout.stage, 'ack')
  assert.equal(timeout.errorCode, 'GOAL_ACK_TIMEOUT')
  assert.equal(timeout.replyCount, 1)
  assert.equal(timeout.mismatchCount, 1)
  assert.equal(timeout.heartbeatCount, 15)
  assert.equal(timeout.goalStatus, 'done')
  assert.equal(timeout.receivedGoalId, 4)
  assert.ok(timeout.lastHeartbeatAgeMs >= 0)
  assert.equal(r.events.filter(x => x.type === 'robot-goal-heartbeat').length, 1)
  assert.equal(r.events.filter(x => x.type === 'robot-heartbeat').length, 1)

  assert.deepEqual(await robot.sendSetGoal(item), { map_name: item.map_name, path_file: '1.1', goal_id: 4 })
  assert.deepEqual(commands, Array(2).fill({ set_goal: { path_name: '1.1', goal_id: 4, goal_object: 'car' } }))
  const results = r.events.filter(x => x.type === 'robot-goal-result')
  assert.equal(results[1].commandId, results[0].commandId + 1)
  assert.equal(results[1].stage, 'arrival')
  assert.equal(results[1].reason, 'arrived')
  assert.equal(results[1].errorCode, undefined)

  const disconnected = once(robot, 'disconnected')
  socket.close(1000, 'sensitive-close-reason-must-not-be-recorded')
  await disconnected
  const closed = r.events.find(x => x.type === 'robot-connection-close')
  assert.equal(closed.opened, true)
  assert.equal(closed.closeCode, 1000)
  assert.ok(closed.uptimeMs >= 0)
  assert.ok(closed.heartbeatAgeMs >= 0)
  assert.equal(closed.generation, 2)
  assert.doesNotMatch(JSON.stringify(r.events), /sensitive-close-reason|ws:\/\//)
})

test('goal evidence distinguishes wrong path type and absent ACK without accepting a done heartbeat', async () => {
  const r = recorder()
  const tracker = new GoalTracker({ send: () => true, emit() {}, diagnostics: r.diagnostics,
    getMapState: () => ({ name: item.map_name, status: 'ready', ageMs: 0 }), ackTimeoutMs: 15 })
  const first = assert.rejects(tracker.start(item), { code: 'GOAL_ACK_TIMEOUT' })
  tracker.handleReply(ack({ path_file: 1.1 }))
  tracker.handleHeartbeat(heartbeat())
  await first
  const reply = r.events.find(x => x.type === 'robot-goal-reply')
  assert.equal(reply.reason, 'path-mismatch')
  assert.equal(reply.expectedPathType, 'string')
  assert.equal(reply.receivedPathType, 'number')
  assert.equal(reply.goalIdMatches, true)
  assert.equal(reply.objectMatches, true)
  const second = assert.rejects(tracker.start(item), { code: 'GOAL_ACK_TIMEOUT' })
  tracker.handleHeartbeat(heartbeat())
  await second
  const results = r.events.filter(x => x.type === 'robot-goal-result')
  assert.equal(results[1].replyCount, 0)
  assert.equal(results[1].mismatchCount, 0)
  assert.equal(results[1].heartbeatCount, 1)
})

test('diagnostic failures cannot affect synchronous goal acknowledgment, arrival, cancellation or emitted events', async () => {
  let tracker
  const events = [], sent = []
  tracker = new GoalTracker({ diagnostics: { event() { throw new Error('observer unavailable') } },
    getMapState: () => ({ name: item.map_name, status: 'ready', ageMs: 0 }),
    emit: (type, fields) => events.push({ type, fields }),
    send: payload => { sent.push(payload); tracker.handleReply(ack()); tracker.handleHeartbeat(heartbeat()); return true },
  })
  assert.equal((await tracker.start(item)).goal_id, 4)
  assert.deepEqual(events.map(x => x.type), ['goal-accepted', 'goal-reached'])
  assert.deepEqual(sent, [{ set_goal: { path_name: '1.1', goal_id: 4, goal_object: 'car' } }])
  tracker.send = () => true
  const rejected = assert.rejects(tracker.start(item), { code: 'GOAL_CANCELLED' })
  tracker.cancel()
  await rejected
  assert.equal(tracker.pending, null)
})

test('listener observers cannot throw into robot I/O and never receive raw socket errors', t => {
  silence(t)
  const robot = new RobotListener({ diagnostics: { event() { throw new Error('observer unavailable') } } })
  let received = false
  robot.on('heartbeat', () => { received = true })
  assert.doesNotThrow(() => robot._handleMessage(heartbeat()))
  assert.equal(received, true)
  assert.doesNotThrow(() => robot.stop())
  const r = recorder()
  const recorded = new RobotListener({ diagnostics: r.diagnostics })
  recorded._diagnostic('robot-connection-error', { errorCode: 'ECONNRESET', reason: 'socket-error' })
  assert.equal(r.events[0].errorCode, 'ECONNRESET')
  assert.equal('message' in r.events[0], false)
})

test('invalid, mismatched, stale and unready preflight targets record failures without sending', () => {
  const r = recorder(), sent = []
  let map = { name: item.map_name, status: 'ready', ageMs: 1 }
  const tracker = new GoalTracker({ send: payload => { sent.push(payload); return true },
    emit() {}, diagnostics: r.diagnostics, getMapState: () => map })
  const cases = [
    { target: { ...item, goal_id: 0 }, map, code: 'INVALID_GOAL' },
    { target: item, map: { ...map, name: 'other-map' }, code: 'MAP_NOT_READY' },
    { target: item, map: { ...map, ageMs: 10001 }, code: 'MAP_NOT_READY' },
    { target: item, map: { ...map, status: 'preparing' }, code: 'MAP_NOT_READY' },
  ]
  for (const [index, scenario] of cases.entries()) {
    map = scenario.map
    assert.throws(() => tracker.start(scenario.target), { code: scenario.code })
    const result = r.events.at(-1)
    assert.equal(result.type, 'robot-goal-result')
    assert.equal(result.commandId, index + 1)
    assert.equal(result.stage, 'preflight')
    assert.equal(result.reason, 'failed')
    assert.equal(result.errorCode, scenario.code)
    assert.equal(result.expectedMap, scenario.target.map_name)
    assert.equal(result.expectedGoalId, scenario.target.goal_id)
    assert.equal(result.receivedMap, map.name)
    assert.equal(result.mapStatus, map.status)
    assert.equal(result.heartbeatAgeMs, map.ageMs)
    assert.equal(result.replyCount, 0)
    assert.equal(tracker.pending, null)
  }
  assert.equal(r.events.length, cases.length)
  assert.deepEqual(sent, [])
})

test('disconnected preflight failure does not send or cancel the existing pending goal', async t => {
  silence(t)
  const r = recorder(), sent = []
  const robot = new RobotListener({ diagnostics: r.diagnostics })
  robot._socket = { readyState: 1, send: raw => sent.push(JSON.parse(raw)), close() {} }
  robot._handleMessage(heartbeat())
  t.after(() => robot.stop())
  const cancelled = assert.rejects(robot.sendSetGoal(item), { code: 'GOAL_CANCELLED' })
  const pending = robot._goals.pending
  robot._socket.readyState = 0
  assert.throws(() => robot.sendSetGoal({ ...item, goal_id: 5 }), {
    code: 'ROBOT_DISCONNECTED', message: '机器人未连接，未发送目标点',
  })
  assert.equal(robot._goals.pending, pending)
  const result = r.events.at(-1)
  assert.equal(result.type, 'robot-goal-result')
  assert.equal(result.stage, 'preflight')
  assert.equal(result.errorCode, 'ROBOT_DISCONNECTED')
  assert.equal(result.commandId, pending.commandId + 1)
  assert.equal(result.expectedGoalId, 5)
  assert.equal(result.receivedMap, item.map_name)
  assert.ok(result.heartbeatAgeMs >= 0)
  assert.equal(sent.length, 1)
  assert.equal(r.events.filter(x => x.type === 'robot-goal-sent').length, 1)
  robot.cancelPendingGoal()
  await cancelled
})

test('preflight diagnostic failures preserve cancellation and disconnected error behavior', t => {
  silence(t)
  const diagnostics = { event() { throw new Error('observer unavailable') } }
  const robot = new RobotListener({ diagnostics })
  assert.throws(() => robot.sendSetGoal(item), { code: 'ROBOT_DISCONNECTED' })
  const controller = new AbortController()
  controller.abort()
  const tracker = new GoalTracker({ diagnostics, send() { assert.fail('must not send') }, emit() {},
    getMapState() { throw new Error('observation cannot replace original rejection') } })
  assert.throws(() => tracker.start(item, { signal: controller.signal }), { code: 'GOAL_CANCELLED' })
  assert.throws(() => tracker.start({ ...item, goal_id: 0 }), { code: 'INVALID_GOAL' })
})
