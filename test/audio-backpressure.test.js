import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpeg from 'ffmpeg-static'
import { RobotListener } from '../src/robot/listener.js'
import { AudioOutputRouter } from '../src/tts/audio-output-router.js'
import { AUDIO_SEND_POLICY as policy } from '../src/robot/audio-send-policy.js'

// Controlled transport/clock regressions, not evidence of robot hardware
// compatibility. No remote provider, robot or physical navigation is contacted.
function clockFor(t) {
  let now = 1000, nextId = 0
  const tasks = new Map()
  const schedule = (callback, delay = 0) => {
    const token = { id: ++nextId, unref() { return this } }
    tasks.set(token, { at: now + Math.max(0, delay), callback })
    return token
  }
  const unschedule = token => tasks.delete(token)
  t.mock.method(globalThis, 'setTimeout', schedule)
  t.mock.method(globalThis, 'clearTimeout', unschedule)
  t.mock.method(performance, 'now', () => now)
  return {
    now: () => now, schedule, unschedule,
    advance(ms) {
      const end = now + ms
      for (let iterations = 0; ; iterations++) {
        assert.ok(iterations < 10000, 'timer loop must remain bounded')
        const due = [...tasks].filter(([, task]) => task.at <= end)
          .sort((a, b) => a[1].at - b[1].at || a[0].id - b[0].id)[0]
        if (!due) break
        tasks.delete(due[0]); now = Math.max(now, due[1].at); due[1].callback()
      }
      now = end
    },
  }
}

function transport(t) {
  const clock = clockFor(t), writes = [], events = []
  const socket = {
    readyState: 1, bufferedAmount: 0, terminations: 0,
    send(payload, _options, done) {
      writes.push(JSON.parse(payload))
      this.afterSend?.()
      done?.(null)
    },
    terminate() { this.terminations++; this.readyState = 3 },
  }
  const robot = new RobotListener()
  robot._socket = socket
  robot.connectionGeneration = 1
  robot.on('audio-flow', event => events.push(event))
  t.after(() => robot.stop())
  return { clock, socket, robot, writes, events }
}

async function playback(t, h, bytes = 1920, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'audio-pressure-regression-'))
  const router = new AudioOutputRouter({ robot: h.robot, ffmpegPath: ffmpeg,
    cacheDirectory: join(directory, 'pcm'), ...h.clock })
  let prepared
  t.after(async () => {
    prepared?.release()
    try { await router.destroy() } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
  router.setConfig({ destination: 'robot' })
  // Fixed PCM isolates sender consumption from decoder/provider scheduling.
  router._decode = async (_source, write) => write(Buffer.alloc(bytes, 17))
  prepared = await router.prepareBuffer(Buffer.from('prepared regression input'))
  const sequenceState = { nextSeq: 1 }
  const session = router.playPrepared({}, prepared, { sequenceState, ...options })
  session.promise.catch(() => {})
  await session.ready
  let reads = 0
  const take = session._reader.take.bind(session._reader)
  session._reader.take = size => { reads++; return take(size) }
  return { router, prepared, session, sequenceState, reads: () => reads }
}

test('waiting preserves unread PCM, sequence and start hook until low-water recovery', async t => {
  const h = transport(t)
  let starts = 0
  const p = await playback(t, h, 1920, { onAudioStart: () => { starts++ } })
  h.socket.bufferedAmount = policy.highWaterBytes
  h.clock.advance(100)
  assert.equal(p.reads(), 0)
  assert.equal(p.session._offset, 0)
  assert.equal(p.sequenceState.nextSeq, 1)
  assert.equal(starts, 0)
  assert.equal(h.writes.length, 0)
  h.socket.bufferedAmount = policy.lowWaterBytes + 1
  h.clock.advance(20)
  assert.equal(p.reads(), 0, 'recovery uses the low watermark, not merely below high watermark')
  h.socket.bufferedAmount = policy.lowWaterBytes
  h.clock.advance(20)
  assert.equal(p.reads(), 1)
  assert.equal(p.sequenceState.nextSeq, 2)
  assert.equal(starts, 1)
  h.socket.bufferedAmount = 0
  h.clock.advance(60)
  assert.deepEqual(await p.session.promise, { ok: true })
  assert.deepEqual(h.writes.map(frame => frame.audio.seq), [1, 2, 3])
  assert.deepEqual(Buffer.concat(h.writes.map(frame => Buffer.from(frame.audio.data, 'base64'))), Buffer.alloc(1920, 17))
  assert.deepEqual(h.events.map(event => event.state), ['waiting', 'recovered'])
})

test('connection watchdog survives paused/stopped playback and resets only after 15 seconds', async t => {
  const h = transport(t), p = await playback(t, h)
  let reconnects = 0, disconnected = 0
  h.robot.url = 'ws://127.0.0.1:1' // The reconnect method is intercepted; never connects.
  h.robot._connectAsClient = () => { reconnects++ }
  h.robot.on('disconnected', () => { disconnected++ })
  h.socket.afterSend = () => { h.socket.bufferedAmount = policy.highWaterBytes }
  h.clock.advance(0)
  assert.equal(h.writes.length, 1)
  assert.ok(h.robot._audioPressure)
  const startedAt = h.robot._audioPressure.startedAt
  p.session.pause()
  p.router.stopAll()
  assert.deepEqual(await p.session.promise, { ok: false, aborted: true })
  assert.equal(h.robot._audioPressure.startedAt, startedAt)
  h.clock.advance(policy.stallTimeoutMs - policy.pollMs)
  assert.equal(h.socket.terminations, 0)
  assert.equal(h.robot.isConnected(), true)
  h.clock.advance(policy.pollMs)
  assert.equal(h.socket.terminations, 1)
  assert.equal(disconnected, 1)
  assert.equal(h.robot.isConnected(), false)
  assert.equal(h.robot._audioPressure, null)
  assert.equal(h.events.at(-1).errorCode, 'AUDIO_SEND_TIMEOUT')
  assert.equal(h.events.at(-1).waitMs, policy.stallTimeoutMs)
  h.clock.advance(4999)
  assert.equal(reconnects, 0)
  h.clock.advance(1)
  assert.equal(reconnects, 1)
  assert.equal(h.writes.length, 1, 'reset/reconnect never restarts old PCM')
})

test('hard limit quarantines shared navigation immediately and cancels pending goal without replay', async t => {
  const h = transport(t)
  h.robot.lastMapName = 'map'; h.robot.lastMapStatus = 'ready'; h.robot.lastHeartbeatAt = h.clock.now()
  const goal = { map_name: 'map', path_name: 'path', goal_id: 1 }
  const pending = h.robot.sendSetGoal(goal)
  const rejected = assert.rejects(pending, { code: 'ROBOT_DISCONNECTED' })
  assert.equal(h.writes.length, 1)
  h.socket.bufferedAmount = policy.hardLimitBytes
  assert.throws(() => h.robot.sendAudioFrame(Buffer.alloc(640), 1), { code: 'AUDIO_BACKLOG' })
  assert.equal(h.robot.isConnected(), false, 'quarantine happens before deferred termination')
  assert.throws(() => h.robot.sendSetGoal({ ...goal, goal_id: 2 }), { code: 'ROBOT_DISCONNECTED' })
  h.robot.sendGetMapList()
  assert.equal(h.writes.length, 1, 'no control or audio may enter quarantined transport')
  h.clock.advance(0)
  await rejected
  assert.equal(h.socket.terminations, 1)
  assert.equal(h.robot._goals.pending, null)
  assert.equal(h.robot.lastMapName, null)
  assert.equal(h.writes.length, 1)
})

test('old prepared session fails on connection generation change without consuming queued PCM', async t => {
  const h = transport(t), p = await playback(t, h)
  h.socket.bufferedAmount = policy.highWaterBytes
  h.clock.advance(0)
  h.robot.connectionGeneration++
  h.socket.bufferedAmount = 0
  h.clock.advance(policy.pollMs)
  await assert.rejects(p.session.promise, /连接已更换/)
  assert.equal(p.reads(), 0)
  assert.equal(p.sequenceState.nextSeq, 1)
  assert.equal(h.writes.length, 0)
})

test('final packet completion requires zero local buffered bytes even below normal low watermark', async t => {
  const h = transport(t), p = await playback(t, h, 640)
  h.socket.afterSend = () => { h.socket.bufferedAmount = 1 }
  h.clock.advance(20)
  assert.equal(h.writes.length, 1)
  assert.equal(p.session.active, true)
  assert.equal(h.robot._audioPressure.resumeBytes, 0)
  h.clock.advance(300)
  assert.equal(p.session.active, true)
  assert.equal(h.events.at(-1).state, 'waiting')
  h.socket.bufferedAmount = 0
  h.clock.advance(policy.pollMs)
  assert.deepEqual(await p.session.promise, { ok: true })
  assert.equal(h.writes.length, 1)
  assert.equal(h.events.at(-1).state, 'recovered')
})

test('throwing status subscribers cannot disable watchdog, termination or reconnect scheduling', t => {
  const h = transport(t)
  let reconnects = 0
  h.robot.url = 'ws://127.0.0.1:1'
  h.robot._connectAsClient = () => { reconnects++ }
  h.robot.on('audio-flow', () => { throw new Error('status subscriber failed') })
  h.robot.on('disconnected', () => { throw new Error('disconnect subscriber failed') })
  h.socket.bufferedAmount = policy.highWaterBytes
  assert.equal(h.robot.getAudioSendState().writable, false)
  assert.doesNotThrow(() => h.clock.advance(policy.stallTimeoutMs))
  assert.equal(h.socket.terminations, 1)
  h.clock.advance(5000)
  assert.equal(reconnects, 1)
})

test('stopping listener during deferred reset drops old transport once and cancels reconnect', t => {
  const h = transport(t)
  let reconnects = 0
  h.robot.url = 'ws://127.0.0.1:1'
  h.robot._connectAsClient = () => { reconnects++ }
  h.socket.bufferedAmount = policy.hardLimitBytes + 1
  assert.throws(() => h.robot.getAudioSendState(), { code: 'AUDIO_BACKLOG' })
  h.robot.stop()
  h.clock.advance(policy.stallTimeoutMs + 5000)
  assert.equal(h.socket.terminations, 1)
  assert.equal(reconnects, 0)
  assert.equal(h.robot._audioResetTimer, null)
  assert.equal(h.robot._audioPressure, null)
})
