import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { RobotListener } from '../src/robot/listener.js'
import { TaskManager } from '../src/task/manager.js'
import { CruiseController } from '../src/task/cruise-controller.js'
import { TransitAudioManager } from '../src/transit/manager.js'

const goal = (id = 3, extra = {}) => ({ map_name: 'map1', path_name: 'path1', goal_id: id, goal_object: 'car', ...extra })
const ack = (item, extra = {}) => ({ robot_goal: {
  path_file: item.path_name, goal_id: item.goal_id, goal_object: item.goal_object, goal_check: 'true', ...extra,
} })
const heartbeat = (item, status = 'done', object = 'going', extra = {}) => ({
  system: { status: 'ready' }, map: { name: item.map_name, status: 'ready' },
  task: { path_file: item.path_name, goal_id: item.goal_id, goal_status: status, object_status: object }, ...extra,
})

function makeRobot(t, options = {}) {
  // Keep intentionally noisy/malformed simulated heartbeats out of TAP output.
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', () => {})
  const robot = new RobotListener(options)
  const sent = []
  robot._socket = { readyState: 1, send: raw => sent.push(JSON.parse(raw)), close() {} }
  robot._handleMessage(heartbeat(goal(), 'going'))
  t.after(() => robot.stop())
  return { robot, sent }
}

for (const alignment of ['going', 'done', 'failed', 'faild', undefined]) {
  test(`immediate navigation done narrates regardless of alignment=${alignment}`, async t => {
    const { robot, sent } = makeRobot(t)
    const events = []
    robot.on('goal-reached', event => events.push(event))
    const arrival = robot.sendSetGoal(goal())
    robot._handleMessage(ack(goal()))
    const report = heartbeat(goal(), 'done', alignment)
    if (alignment === undefined) delete report.task.object_status
    robot._handleMessage(report)
    robot._handleMessage(report)
    assert.deepEqual(await arrival, { map_name: 'map1', path_file: 'path1', goal_id: 3 })
    assert.equal(events.length, 1)
    assert.deepEqual(sent, [{ set_goal: { path_name: 'path1', goal_id: 3, goal_object: 'car' } }])
  })
}

test('old goal acknowledgments and heartbeats cannot complete a new goal', async t => {
  const { robot } = makeRobot(t)
  const events = []
  robot.on('goal-reached', event => events.push(event))
  const arrival = robot.sendSetGoal(goal(3))
  robot._handleMessage(ack(goal(2)))
  robot._handleMessage(heartbeat(goal(3))) // same target, but no matching ack yet
  robot._handleMessage(heartbeat(goal(2), 'going'))
  robot._handleMessage(heartbeat(goal(2)))
  assert.equal(robot._goals.pending.accepted, false)
  assert.equal(events.length, 0)
  robot._handleMessage(ack(goal(3)))
  robot._handleMessage(heartbeat(goal(2)))
  robot._handleMessage(heartbeat(goal(3, { path_name: 'old-path' })))
  assert.equal(events.length, 0)
  robot._handleMessage(heartbeat(goal(3)))
  assert.equal((await arrival).goal_id, 3)
})

test('pre-ack done is not cached as arrival; matching post-ack done is accepted', async t => {
  const { robot } = makeRobot(t)
  const arrival = robot.sendSetGoal(goal())
  robot._handleMessage(heartbeat(goal()))
  robot._handleMessage(ack(goal()))
  assert.ok(robot._goals.pending)
  robot._handleMessage(heartbeat(goal('3')))
  assert.equal((await arrival).goal_id, 3)
})

for (const failure of ['failed', 'faild']) {
  test(`navigation ${failure} is not arrival`, async t => {
    const { robot } = makeRobot(t)
    const rejected = assert.rejects(robot.sendSetGoal(goal()), { code: 'NAVIGATION_FAILED' })
    robot._handleMessage(ack(goal()))
    robot._handleMessage(heartbeat(goal(), failure))
    await rejected
  })
}

for (const rejectedCheck of ['false', false, undefined]) {
  test(`goal refusal/malformed acceptance (${rejectedCheck}) cannot start narration`, async t => {
    const { robot } = makeRobot(t)
    const rejected = assert.rejects(robot.sendSetGoal(goal()), { code: 'GOAL_REJECTED' })
    robot._handleMessage(ack(goal(), { goal_check: rejectedCheck }))
    robot._handleMessage(heartbeat(goal()))
    await rejected
  })
}

test('wrong-map, stale-map and unready-map commands are refused before sending', t => {
  const { robot, sent } = makeRobot(t)
  assert.throws(() => robot.sendSetGoal(goal(3, { map_name: 'map2' })), { code: 'MAP_NOT_READY' })
  robot.lastHeartbeatAt = performance.now() - 11000
  assert.throws(() => robot.sendSetGoal(goal()), { code: 'MAP_NOT_READY' })
  robot.lastHeartbeatAt = performance.now()
  robot.lastMapStatus = 'preparing'
  assert.throws(() => robot.sendSetGoal(goal()), { code: 'MAP_NOT_READY' })
  assert.equal(sent.length, 0)
})

test('map changes during navigation cancel the wait rather than relabel arrival', async t => {
  const { robot } = makeRobot(t)
  const rejected = assert.rejects(robot.sendSetGoal(goal()), { code: 'MAP_NOT_READY' })
  robot._handleMessage(ack(goal()))
  robot._handleMessage(heartbeat(goal(3, { map_name: 'map2' })))
  await rejected
})

test('ack and arrival waits have bounded timeouts and release the transaction', async t => {
  const { robot } = makeRobot(t, { ackTimeoutMs: 15, arrivalTimeoutMs: 15 })
  await assert.rejects(robot.sendSetGoal(goal()), { code: 'GOAL_ACK_TIMEOUT' })
  assert.equal(robot._goals.pending, null)
  const arrival = robot.sendSetGoal(goal())
  robot._handleMessage(ack(goal()))
  await assert.rejects(arrival, { code: 'GOAL_ARRIVAL_TIMEOUT' })
  assert.equal(robot._goals.pending, null)
})

test('abort, replacement and disconnect release the old transaction', async t => {
  const { robot } = makeRobot(t)
  const signal = new AbortController()
  const first = assert.rejects(robot.sendSetGoal(goal(1), { signal: signal.signal }), { code: 'GOAL_CANCELLED' })
  signal.abort()
  await first
  const second = assert.rejects(robot.sendSetGoal(goal(2)), { code: 'GOAL_CANCELLED' })
  const third = assert.rejects(robot.sendSetGoal(goal(3)), { code: 'ROBOT_DISCONNECTED' })
  robot._resetRobotState()
  await Promise.all([second, third])
  assert.equal(robot.lastMapName, null)
  assert.equal(robot._goals.pending, null)
})

test('synchronous acknowledgment during send is not missed', async t => {
  const { robot } = makeRobot(t)
  robot._socket.send = () => {
    robot._handleMessage(ack(goal()))
    robot._handleMessage(heartbeat(goal()))
  }
  assert.equal((await robot.sendSetGoal(goal())).goal_id, 3)
})

test('disconnected robot and invalid IDs cannot dispatch a goal', t => {
  const { robot, sent } = makeRobot(t)
  for (const id of [0, -1, 1.5, '3', null]) {
    assert.throws(() => robot.sendSetGoal(goal(id)), { code: 'INVALID_GOAL' })
  }
  robot._socket.readyState = 3
  assert.throws(() => robot.sendSetGoal(goal()), { code: 'ROBOT_DISCONNECTED' })
  assert.equal(sent.length, 0)
})

test('acknowledgment must echo the requested object; incomplete reports cannot complete a goal', async t => {
  const { robot } = makeRobot(t)
  const arrival = robot.sendSetGoal(goal())
  robot._handleMessage(ack(goal(), { goal_object: 'chair' }))
  assert.equal(robot._goals.pending.accepted, false)
  robot._handleMessage(ack(goal(), { goal_check: true }))
  for (const missing of ['path_file', 'goal_id', 'goal_status']) {
    const report = heartbeat(goal())
    delete report.task[missing]
    robot._handleMessage(report)
    assert.ok(robot._goals.pending)
  }
  robot._handleMessage(heartbeat(goal()))
  await arrival
})

function makeCruise(t, items = [goal(1), goal(2)], playPoint, robotOptions = {}) {
  const { robot, sent } = makeRobot(t, robotOptions)
  const tour = new TaskManager({ filePath: '/__missing_cruise_test__/tour.json' })
  tour._list = items
  tour._save = () => {} // Mutations in these tests must never touch runtime data.
  const messages = []
  const spoken = []
  const audio = { events: [], transitRunning: false, paused: false }
  let selectedMap = 'map1'
  const cruise = new CruiseController({
    robot, tour, getSelectedMap: () => selectedMap,
    playPoint: playPoint || (async item => { spoken.push(item.goal_id) }),
    stopSpeech() { audio.events.push('stop-speech') },
    startTransit() { audio.events.push('start-transit'); audio.transitRunning = true },
    stopTransit() { audio.events.push('stop-transit'); audio.transitRunning = false },
    isTransitRunning: () => audio.transitRunning,
    syncAudioPause() {
      audio.paused = tour.isPaused
      audio.events.push(tour.isPaused ? 'pause-audio' : 'resume-audio')
    },
    broadcast: (type, data) => messages.push({ type, data }),
  })
  tour.on('current-removed', ({ nextIndex }) => cruise.currentRemoved(nextIndex))
  t.after(() => cruise.stop())
  const arrive = (item, status = 'done') => {
    robot._handleMessage(ack(item))
    robot._handleMessage(heartbeat(item, status))
  }
  return { robot, sent, tour, cruise, messages, spoken, audio, arrive, select: name => { selectedMap = name } }
}

test('cruise cannot lose immediate arrivals at the handoff between points', async t => {
  const h = makeCruise(t)
  h.robot._socket.send = raw => {
    const item = goal(JSON.parse(raw).set_goal.goal_id)
    h.sent.push(JSON.parse(raw))
    h.arrive(item)
  }
  h.cruise.start()
  await h.cruise.finished
  assert.deepEqual(h.spoken, [1, 2])
  assert.equal(h.sent.length, 2)
  assert.equal(h.tour.isRunning, false)
})

test('narration must finish before the next goal is dispatched', async t => {
  let finishSpeech
  const h = makeCruise(t, [goal(1), goal(2)], async () => new Promise(resolve => { finishSpeech = resolve }))
  h.cruise.start()
  h.arrive(goal(1))
  await nextTurn()
  assert.equal(h.sent.length, 1)
  finishSpeech()
  await nextTurn()
  assert.equal(h.sent[1].set_goal.goal_id, 2)
  h.cruise.stop()
  await h.cruise.finished
})

test('mixed-map tour is refused before any robot command', t => {
  const h = makeCruise(t, [goal(1), goal(2, { map_name: 'map2' })])
  h.cruise.start()
  assert.equal(h.sent.length, 0)
  assert.equal(h.tour.isRunning, false)
  assert.match(h.messages[0].data.message, /map2/)
})

test('map mismatch between selected map and robot pauses before dispatch', async t => {
  const h = makeCruise(t)
  h.robot._handleMessage(heartbeat(goal(3, { map_name: 'map2' })))
  h.cruise.start()
  await h.cruise.finished
  assert.equal(h.sent.length, 0)
  assert.equal(h.tour.isPaused, true)
})

test('a map change between points blocks the next goal', async t => {
  const h = makeCruise(t, [goal(1), goal(2)], async () => h.select('map2'))
  h.cruise.start()
  h.arrive(goal(1))
  await h.cruise.finished
  assert.equal(h.sent.length, 1)
  assert.equal(h.tour.isPaused, true)
})

test('navigation failure skips narration and proceeds to the next point', async t => {
  const h = makeCruise(t)
  h.cruise.start()
  h.arrive(goal(1), 'failed')
  await nextTurn()
  assert.deepEqual(h.spoken, [])
  assert.equal(h.sent[1].set_goal.goal_id, 2)
  h.arrive(goal(2))
  await h.cruise.finished
  assert.deepEqual(h.spoken, [2])
})

test('skip cancels the previous wait; late old replies cannot narrate or advance', async t => {
  const h = makeCruise(t)
  h.cruise.start()
  const oldRun = h.cruise.finished
  h.cruise.skip()
  h.arrive(goal(1))
  await nextTurn()
  assert.deepEqual(h.spoken, [])
  assert.equal(h.tour.currentIndex, 1)
  h.arrive(goal(2))
  await Promise.all([oldRun, h.cruise.finished])
  assert.deepEqual(h.spoken, [2])
})

test('stop after arrival invalidates in-flight narration before it can resume', async t => {
  let release
  let narrated = false
  const h = makeCruise(t, [goal(1), goal(2)], async (_item, _point, { isCurrent }) => {
    await new Promise(resolve => { release = resolve })
    if (isCurrent()) narrated = true
  })
  h.cruise.start()
  h.arrive(goal(1))
  await nextTurn()
  h.cruise.stop()
  release()
  await h.cruise.finished
  assert.equal(narrated, false)
  assert.equal(h.sent.length, 1)
  assert.equal(h.messages.filter(msg => msg.type === 'SPEECH_END').length, 1)
})

test('pause retains the goal and its arrival; resume narrates without resending or restarting', async t => {
  const h = makeCruise(t, [goal(1)])
  h.cruise.start()
  const activeRun = h.cruise.finished
  const pending = h.robot._goals.pending
  h.cruise.pause()
  assert.equal(h.robot._goals.pending, pending)
  assert.equal(h.audio.paused, true)
  h.arrive(goal(1))
  await nextTurn()
  assert.deepEqual(h.spoken, [])
  assert.equal(h.tour.currentItem.goal_id, 1)
  h.cruise.resume()
  assert.equal(h.audio.paused, false)
  assert.equal(h.cruise.finished, activeRun)
  assert.equal(h.sent.length, 1)
  await h.cruise.finished
  assert.deepEqual(h.spoken, [1])
})

test('repeat iterations permit the same point again without duplicate heartbeat playback', async t => {
  const h = makeCruise(t, [goal(1)])
  h.cruise.start(2)
  h.arrive(goal(1))
  h.robot._handleMessage(heartbeat(goal(1)))
  await nextTurn()
  h.arrive(goal(1))
  await h.cruise.finished
  assert.deepEqual(h.spoken, [1, 1])
  assert.equal(h.sent.length, 2)
})

test('timeout pauses the tour and stops waiting rather than dispatching another point', async t => {
  const h = makeCruise(t, [goal(1), goal(2)], null, { ackTimeoutMs: 15 })
  h.cruise.start()
  await h.cruise.finished
  assert.equal(h.tour.isPaused, true)
  assert.equal(h.sent.length, 1)
  assert.ok(h.messages.some(msg => msg.type === 'ERROR' && /超时/.test(msg.data.message)))
  assert.equal(h.robot._goals.pending, null)
})

test('deleting the current point cancels its wait and dispatches the surviving point', async t => {
  const h = makeCruise(t)
  h.cruise.start()
  const firstRun = h.cruise.finished
  h.tour.removeItem(0)
  h.arrive(goal(1))
  await nextTurn()
  assert.deepEqual(h.spoken, [])
  assert.equal(h.sent.at(-1).set_goal.goal_id, 2)
  h.arrive(goal(2))
  await Promise.all([firstRun, h.cruise.finished])
  assert.deepEqual(h.spoken, [2])
})

test('old narration finishing after a skip cannot unlock or advance the new narration', async t => {
  const releases = new Map()
  const h = makeCruise(t, [goal(1), goal(2), goal(3)], async item => {
    await new Promise(resolve => releases.set(item.goal_id, resolve))
  })
  h.cruise.start()
  const firstRun = h.cruise.finished
  h.arrive(goal(1))
  await nextTurn()
  h.cruise.skip()
  h.arrive(goal(2))
  await nextTurn()
  releases.get(1)()
  await firstRun
  assert.equal(h.cruise.isHandlingGoal, true)
  assert.equal(h.tour.currentItem.goal_id, 2)
  assert.equal(h.sent.length, 2)
  releases.get(2)()
  await nextTurn()
  assert.equal(h.sent.at(-1).set_goal.goal_id, 3)
  h.cruise.stop()
  await h.cruise.finished
})

for (const action of ['skip', 'delete']) {
  test(`${action} while travelling to point 2 redirects to 3 without restarting transition audio`, async t => {
    const h = makeCruise(t, [1, 2, 3, 4].map(id => goal(id)))
    h.cruise.start()
    h.arrive(goal(1))
    await nextTurn()
    assert.equal(h.sent.at(-1).set_goal.goal_id, 2)
    assert.equal(h.audio.transitRunning, true)
    const audioBefore = [...h.audio.events]
    const oldRun = h.cruise.finished
    if (action === 'skip') h.cruise.skip()
    else h.tour.setList(h.tour.getList().filter(item => item.goal_id !== 2)) // actual UI command path
    assert.equal(h.sent.at(-1).set_goal.goal_id, 3)
    assert.deepEqual(h.audio.events, audioBefore, 'redirect must not stop shared TTS synthesis or restart transit')
    h.arrive(goal(2)) // late acknowledgment / arrival from the discarded destination
    await nextTurn()
    assert.deepEqual(h.spoken, [1])
    assert.equal(h.tour.currentItem.goal_id, 3)
    h.arrive(goal(3))
    await nextTurn()
    assert.equal(h.sent.at(-1).set_goal.goal_id, 4)
    h.arrive(goal(4))
    await Promise.all([oldRun, h.cruise.finished])
    assert.deepEqual(h.spoken, [1, 3, 4])
    assert.deepEqual(h.sent.map(msg => msg.set_goal.goal_id), [1, 2, 3, 4])
    assert.deepEqual(h.tour.getList().map(item => item.goal_id), action === 'skip' ? [1, 2, 3, 4] : [1, 3, 4])
  })

  test(`${action} during point-2 narration stops only that introduction and continues through 3 and 4`, async t => {
    const narrated = []
    let releasePoint2
    const h = makeCruise(t, [1, 2, 3, 4].map(id => goal(id)), async (item, _point, { isCurrent }) => {
      if (item.goal_id === 2) await new Promise(resolve => { releasePoint2 = resolve })
      if (isCurrent()) narrated.push(item.goal_id)
    })
    h.cruise.start()
    h.arrive(goal(1))
    await nextTurn()
    h.arrive(goal(2))
    await nextTurn()
    const audioBefore = h.audio.events.length
    const oldRun = h.cruise.finished
    if (action === 'skip') h.cruise.skip()
    else h.tour.setList(h.tour.getList().filter(item => item.goal_id !== 2))
    assert.equal(h.sent.at(-1).set_goal.goal_id, 3)
    assert.deepEqual(h.audio.events.slice(audioBefore), ['stop-speech', 'start-transit'])
    releasePoint2()
    await oldRun
    assert.equal(h.tour.currentItem.goal_id, 3)
    assert.equal(h.audio.transitRunning, true)
    h.arrive(goal(3))
    await nextTurn()
    h.arrive(goal(4))
    await h.cruise.finished
    assert.deepEqual(narrated, [1, 3, 4])
  })
}

for (const phase of ['travelling', 'narrating']) {
  test(`deleting skipped point 2 while ${phase} at point 3 leaves point 3 untouched`, async t => {
    let releasePoint3
    const h = makeCruise(t, [1, 2, 3, 4].map(id => goal(id)), async item => {
      if (item.goal_id === 3) await new Promise(resolve => { releasePoint3 = resolve })
    })
    h.cruise.start()
    h.arrive(goal(1))
    await nextTurn()
    h.cruise.skip()
    if (phase === 'narrating') {
      h.arrive(goal(3))
      await nextTurn()
    }
    const activeRun = h.cruise.finished
    const audioBefore = [...h.audio.events]
    const commandsBefore = h.sent.length
    h.tour.setList(h.tour.getList().filter(item => item.goal_id !== 2))
    h.arrive(goal(2))
    await nextTurn()
    assert.equal(h.cruise.finished, activeRun)
    assert.equal(h.tour.currentItem.goal_id, 3)
    assert.deepEqual(h.audio.events, audioBefore)
    assert.equal(h.sent.length, commandsBefore)
    if (phase === 'travelling') {
      h.arrive(goal(3))
      await nextTurn()
    }
    releasePoint3()
    await nextTurn()
    assert.equal(h.sent.at(-1).set_goal.goal_id, 4)
    h.arrive(goal(4))
    await h.cruise.finished
  })
}

test('UI deletion selects the next surviving successor, not an already visited point', async t => {
  const h = makeCruise(t, [1, 2, 3, 4, 5].map(id => goal(id)))
  h.cruise.start()
  h.arrive(goal(1))
  await nextTurn()
  h.tour.setList([1, 4, 5].map(id => goal(id)))
  assert.equal(h.sent.at(-1).set_goal.goal_id, 4)
  h.arrive(goal(4))
  await nextTurn()
  h.arrive(goal(5))
  await h.cruise.finished
  assert.deepEqual(h.spoken, [1, 4, 5])
})

test('deleting a future point does not interrupt the current point or erase other successors', async t => {
  const h = makeCruise(t, [1, 2, 3, 4].map(id => goal(id)))
  h.cruise.start()
  h.arrive(goal(1))
  await nextTurn()
  const pending = h.robot._goals.pending
  const audioBefore = [...h.audio.events]
  h.tour.setList([goal(1), goal(2), goal(4)])
  assert.equal(h.robot._goals.pending, pending)
  assert.deepEqual(h.audio.events, audioBefore)
  h.arrive(goal(2))
  await nextTurn()
  assert.equal(h.sent.at(-1).set_goal.goal_id, 4)
  h.arrive(goal(4))
  await h.cruise.finished
  assert.deepEqual(h.spoken, [1, 2, 4])
})

test('deleting the final active point does not restart already visited points', async t => {
  const h = makeCruise(t, [goal(1), goal(2)])
  h.cruise.start()
  h.arrive(goal(1))
  await nextTurn()
  const oldRun = h.cruise.finished
  h.tour.setList([goal(1)])
  await oldRun
  assert.equal(h.tour.isRunning, false)
  assert.equal(h.sent.length, 2)
  assert.deepEqual(h.tour.getList(), [goal(1)])
})

test('pause/resume preserves active narration and playback instead of starting it again', async t => {
  let finishSpeech
  let speechStarts = 0
  const h = makeCruise(t, [goal(2), goal(3)], async item => {
    if (item.goal_id === 2) {
      speechStarts++
      await new Promise(resolve => { finishSpeech = resolve })
    }
  })
  h.cruise.start()
  h.arrive(goal(2))
  await nextTurn()
  const activeRun = h.cruise.finished
  const audioBefore = h.audio.events.length
  h.cruise.pause()
  assert.equal(h.audio.paused, true)
  assert.equal(h.cruise.isHandlingGoal, true)
  h.cruise.resume()
  assert.deepEqual(h.audio.events.slice(audioBefore), ['pause-audio', 'resume-audio'])
  assert.equal(h.cruise.finished, activeRun)
  assert.equal(h.sent.length, 1)
  assert.equal(speechStarts, 1)
  finishSpeech()
  await nextTurn()
  assert.equal(h.sent.at(-1).set_goal.goal_id, 3)
  h.arrive(goal(3))
  await h.cruise.finished
})

test('speech finishing during pause cannot send the next goal until resume', async t => {
  let finishSpeech
  const spoken = []
  const h = makeCruise(t, [goal(2), goal(3)], async item => {
    spoken.push(item.goal_id)
    if (item.goal_id === 2) await new Promise(resolve => { finishSpeech = resolve })
  })
  h.cruise.start()
  h.arrive(goal(2))
  await nextTurn()
  h.cruise.pause()
  finishSpeech()
  await nextTurn()
  assert.equal(h.sent.length, 1)
  assert.equal(h.tour.currentItem.goal_id, 2)
  h.cruise.resume()
  await nextTurn()
  assert.equal(h.sent.at(-1).set_goal.goal_id, 3)
  h.arrive(goal(3))
  await h.cruise.finished
  assert.deepEqual(spoken, [2, 3])
})

test('pause/resume during travel retains the same goal and transition session', async t => {
  const h = makeCruise(t, [goal(1), goal(2)])
  h.cruise.start()
  h.arrive(goal(1))
  await nextTurn()
  const pending = h.robot._goals.pending
  const audioBefore = h.audio.events.length
  for (let i = 0; i < 3; i++) {
    h.cruise.pause()
    h.cruise.resume()
  }
  assert.equal(h.robot._goals.pending, pending)
  assert.equal(h.audio.transitRunning, true)
  assert.equal(h.sent.length, 2)
  assert.deepEqual(h.audio.events.slice(audioBefore), Array(3).fill(['pause-audio', 'resume-audio']).flat())
  h.arrive(goal(2))
  await h.cruise.finished
})

test('deleting the current point while paused retains the next point and transition until resume', async t => {
  const h = makeCruise(t, [goal(1), goal(2), goal(3)])
  h.cruise.start()
  h.arrive(goal(1))
  await nextTurn()
  h.cruise.pause()
  const audioBefore = h.audio.events.length
  const oldRun = h.cruise.finished
  h.tour.setList([goal(1), goal(3)])
  assert.equal(h.tour.isPaused, true)
  assert.equal(h.tour.currentItem.goal_id, 3)
  assert.equal(h.sent.length, 2)
  assert.deepEqual(h.audio.events.slice(audioBefore), [])
  h.cruise.resume()
  assert.deepEqual(h.audio.events.slice(audioBefore), ['resume-audio'])
  assert.equal(h.sent.at(-1).set_goal.goal_id, 3)
  h.arrive(goal(3))
  await Promise.all([oldRun, h.cruise.finished])
})

test('skip from a paused point resumes the transition and redirects without restarting it', async t => {
  const h = makeCruise(t, [goal(1), goal(2), goal(3)])
  h.cruise.start()
  h.arrive(goal(1))
  await nextTurn()
  h.cruise.pause()
  const audioBefore = h.audio.events.length
  h.cruise.skip()
  assert.equal(h.tour.isPaused, false)
  assert.equal(h.audio.paused, false)
  assert.deepEqual(h.audio.events.slice(audioBefore), ['resume-audio'])
  assert.equal(h.messages.filter(msg => msg.type === 'TOUR_RESUMED').length, 1)
  assert.equal(h.sent.at(-1).set_goal.goal_id, 3)
  h.arrive(goal(3))
  await h.cruise.finished
})

test('stop while holding a paused arrival releases the wait without playing it on resume', async t => {
  const h = makeCruise(t, [goal(2)])
  h.cruise.start()
  h.cruise.pause()
  h.arrive(goal(2))
  await nextTurn()
  h.cruise.stop()
  await h.cruise.finished
  h.cruise.resume()
  assert.deepEqual(h.spoken, [])
  assert.equal(h.sent.length, 1)
  assert.equal(h.tour.isRunning, false)
  assert.equal(h.audio.paused, false)
})

test('resume after a goal error can retry, unlike a normal pause which preserves the same goal', async t => {
  const h = makeCruise(t, [goal(2)], null, { ackTimeoutMs: 15 })
  h.cruise.start()
  await h.cruise.finished
  assert.equal(h.tour.isPaused, true)
  h.cruise.resume()
  assert.equal(h.sent.length, 2)
  h.arrive(goal(2))
  await h.cruise.finished
  assert.deepEqual(h.spoken, [2])
})

test('redirect preserves the real transition manager while its shared TTS synthesis is pending', async t => {
  const h = makeCruise(t, [goal(1), goal(2), goal(3)])
  const transit = new TransitAudioManager({ filePath: '/__missing_cruise_test__/transit.json' })
  transit._config = { enabled: true, type: 'tts', text: '过渡介绍' }
  let finishSynthesis, rejectSynthesis, finishPlayback
  let syntheses = 0
  let stops = 0
  const played = []
  const tts = {
    enabled: true,
    synthesizeBuffer: () => {
      syntheses++
      return new Promise((resolve, reject) => { finishSynthesis = resolve; rejectSynthesis = reject })
    },
    stop: () => { stops++; rejectSynthesis?.(new Error('unexpected TTS stop')) },
  }
  transit._player.play = async buffer => {
    played.push(buffer.toString())
    await new Promise(resolve => { finishPlayback = resolve })
  }
  h.cruise.startTransit = () => transit.start(tts, { rewrite: async ({ body }) => ({ text: body }) })
  h.cruise.stopTransit = () => transit.stop()
  h.cruise.isTransitRunning = () => transit.isRunning()
  h.cruise.stopSpeech = () => tts.stop()
  t.after(() => { transit.stop(); finishPlayback?.() })
  h.cruise.start()
  h.arrive(goal(1))
  await nextTurn()
  assert.equal(syntheses, 1)
  const transitionRun = transit._runId
  const stopsBefore = stops
  h.cruise.skip()
  assert.equal(stops, stopsBefore)
  assert.equal(transit._runId, transitionRun)
  finishSynthesis(Buffer.from('same transition audio'))
  await nextTurn()
  assert.equal(syntheses, 1)
  assert.deepEqual(played, ['same transition audio'])
  h.arrive(goal(3))
  await h.cruise.finished
})
