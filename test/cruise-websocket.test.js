import assert from 'node:assert/strict'
import test from 'node:test'
import { once } from 'node:events'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { WebSocket, WebSocketServer } from 'ws'
import { RobotListener } from '../src/robot/listener.js'
import { TaskManager } from '../src/task/manager.js'
import { CruiseController } from '../src/task/cruise-controller.js'

// Real JSON/WebSocket exchange on loopback only. No hardware, audio, LLM or TTS.
test('loopback robot: stale point-1 reports cannot complete point 2; immediate done is accepted', { timeout: 5000 }, async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  t.after(async () => {
    for (const socket of server.clients) socket.terminate()
    await new Promise(resolve => server.close(resolve))
  })
  await once(server, 'listening')
  const robot = new RobotListener({ url: `ws://127.0.0.1:${server.address().port}`, ackTimeoutMs: 1000 })
  t.after(() => robot.stop())
  const tour = new TaskManager({ filePath: '/__missing_cruise_test__/tour.json' })
  tour._list = [1, 2].map(goal_id => ({ map_name: 'map1', path_name: 'path1', goal_id, goal_object: 'car' }))
  const spoken = []
  const messages = []
  const sent = []
  const cruise = new CruiseController({
    robot, tour, getSelectedMap: () => 'map1',
    playPoint: async item => { spoken.push(item.goal_id) },
    stopSpeech() {}, startTransit() {}, stopTransit() {},
    broadcast: (type, data) => messages.push({ type, data }),
  })
  t.after(() => cruise.stop())
  const reply = id => ({ robot_goal: { path_file: 'path1', goal_id: id, goal_object: 'car', goal_check: 'true' } })
  const report = id => ({
    system: { status: 'ready' }, map: { name: 'map1', status: 'ready' },
    task: { path_file: 'path1', goal_id: id, goal_status: 'done', object_status: 'going' },
  })
  let peer
  let secondRequested = false
  server.on('connection', socket => {
    peer = socket
    socket.on('message', raw => {
      const command = JSON.parse(raw.toString())
      sent.push(command)
      if (command.set_goal.goal_id === 1) {
        socket.send(JSON.stringify(reply(1)))
        socket.send(JSON.stringify(report(1)))
      } else {
        secondRequested = true
        // Old data arriving *after* point 2 was requested, just like the bug.
        socket.send(JSON.stringify(reply(1)))
        socket.send(JSON.stringify(report(1)))
      }
    })
    socket.send(JSON.stringify(report(0))) // initial fresh, ready map
  })
  const oldReportSeen = new Promise(resolve => {
    robot.on('heartbeat', msg => {
      if (secondRequested && msg.task.goal_id === 1) resolve()
    })
  })
  const ready = once(robot, 'heartbeat')
  robot.start()
  await ready
  cruise.start()
  await oldReportSeen
  await nextTurn()
  assert.deepEqual(spoken, [1])
  assert.equal(robot._goals.pending.accepted, false)
  peer.send(JSON.stringify(reply(2)))
  peer.send(JSON.stringify(report(2))) // no going report in between
  peer.send(JSON.stringify(report(2))) // repeated 1 Hz heartbeat must not replay
  await cruise.finished
  assert.deepEqual(spoken, [1, 2])
  assert.equal(tour.isRunning, false)
  assert.equal(messages.filter(msg => msg.type === 'POINT_ARRIVED').length, 2)
  assert.deepEqual(sent, [1, 2].map(goal_id => ({ set_goal: { path_name: 'path1', goal_id, goal_object: 'car' } })))
})

test('server mode: replaced socket cannot complete or disconnect the new session', { timeout: 5000 }, async t => {
  const robot = new RobotListener({ host: '127.0.0.1', port: 0, ackTimeoutMs: 1000 })
  t.after(async () => {
    robot.stop()
    for (const socket of robot.wss.clients) socket.terminate()
    await new Promise(resolve => robot.wss.close(resolve))
  })
  robot.start()
  await once(robot.wss, 'listening')
  const address = `ws://127.0.0.1:${robot.wss.address().port}`
  const item = { map_name: 'map1', path_name: 'path1', goal_id: 3, goal_object: 'car' }
  const report = {
    system: { status: 'ready' }, map: { name: 'map1', status: 'ready' },
    task: { path_file: 'path1', goal_id: 3, goal_status: 'done', object_status: 'going' },
  }
  const reply = { robot_goal: { path_file: 'path1', goal_id: 3, goal_object: 'car', goal_check: 'true' } }
  const oldPeer = new WebSocket(address)
  t.after(() => oldPeer.terminate())
  await once(oldPeer, 'open')
  const oldSocket = robot._socket
  const initialHeartbeat = once(robot, 'heartbeat')
  oldPeer.send(JSON.stringify(report))
  await initialHeartbeat
  const oldWait = assert.rejects(robot.sendSetGoal(item), { code: 'ROBOT_DISCONNECTED' })
  const newConnection = once(robot, 'connected')
  const newPeer = new WebSocket(address)
  t.after(() => newPeer.terminate())
  await Promise.all([once(newPeer, 'open'), newConnection, oldWait])
  assert.equal(robot.lastMapName, null)
  const freshHeartbeat = once(robot, 'heartbeat')
  newPeer.send(JSON.stringify(report))
  await freshHeartbeat
  const arrival = robot.sendSetGoal(item)
  // Exercise callbacks queued by an old socket after the replacement is active.
  oldSocket.emit('message', Buffer.from(JSON.stringify(reply)))
  oldSocket.emit('message', Buffer.from(JSON.stringify(report)))
  oldSocket.emit('close')
  assert.equal(robot.isConnected(), true)
  assert.equal(robot._goals.pending.accepted, false)
  newPeer.send(JSON.stringify(reply))
  newPeer.send(JSON.stringify(report))
  assert.equal((await arrival).goal_id, 3)
})
