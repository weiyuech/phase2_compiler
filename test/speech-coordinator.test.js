import test from 'node:test'
import assert from 'node:assert/strict'
import { SpeechCoordinator } from '../src/tts/speech-coordinator.js'

for (const [lowerRole, upperRole] of [['transit', 'cruise'], ['transit', 'barrage'], ['cruise', 'barrage']]) {
  for (const kind of ['tts', 'mp3']) {
    test(`${kind} handoff matrix: ready ${upperRole} over ${lowerRole}`, async () => {
      const coordinator = new SpeechCoordinator(), controls = []
      const lower = coordinator.createJob({ role: lowerRole, kind,
        pause: () => controls.push('pause'), resume: () => controls.push('resume') })
      await lower.acquire()
      const upper = coordinator.createJob({ role: upperRole, kind: 'tts' })
      const incoming = upper.acquire()
      if (kind === 'tts') {
        assert.equal(coordinator.active, lower)
        assert.deepEqual(controls, [])
        lower.boundary(true, { hold: true })
      } else assert.deepEqual(controls, ['pause'])
      assert.equal(await incoming, true)
      assert.equal(coordinator.active, upper)
      upper.finish()
      assert.equal(coordinator.active, lower)
      if (kind === 'mp3') assert.deepEqual(controls, ['pause', 'resume'])
      lower.cancel()
      assert.equal(coordinator.jobs.size, 0)
    })
  }
}

function harness() {
  const coordinator = new SpeechCoordinator()
  const events = []
  const create = (role, kind = 'tts') => coordinator.createJob({ role, kind,
    pause: () => events.push(`pause:${role}`), resume: () => events.push(`resume:${role}`),
  })
  return { coordinator, events, create }
}

test('ready barrage waits for current TTS boundary; cruise resumes its next sentence', async () => {
  const h = harness(), cruise = h.create('cruise'), barrage = h.create('barrage')
  assert.equal(await cruise.acquire(), true)
  let started = false
  const pending = barrage.acquire().then(() => { started = true })
  await Promise.resolve()
  assert.equal(started, false)
  assert.deepEqual(h.events, [])
  cruise.boundary(true)
  await pending
  assert.equal(barrage.active, true)
  const continuation = cruise.acquire()
  barrage.finish()
  assert.equal(await continuation, true)
  assert.equal(cruise.active, true)
})

test('MP3 preempts immediately only when incoming audio requests a ready lease', async () => {
  const h = harness(), transit = h.create('transit', 'mp3'), point = h.create('cruise')
  await transit.acquire()
  assert.deepEqual(h.events, [])
  await point.acquire()
  assert.deepEqual(h.events, ['pause:transit'])
  point.finish()
  assert.deepEqual(h.events, ['pause:transit', 'resume:transit'])
})

test('host pause is immediate, tour pause remains independent, barrage can speak while tour paused', async () => {
  const h = harness(), cruise = h.create('cruise'), barrage = h.create('barrage')
  await cruise.acquire()
  h.coordinator.setPauseReason('host', ['cruise', 'transit', 'barrage'], true)
  assert.deepEqual(h.events, ['pause:cruise'])
  h.coordinator.setPauseReason('tour', ['cruise', 'transit'], true)
  let started = false
  const pending = barrage.acquire().then(() => { started = true })
  h.coordinator.setPauseReason('host', [], false)
  await pending
  assert.equal(started, true)
  barrage.finish()
  assert.equal(cruise.active, false)
  h.coordinator.setPauseReason('tour', [], false)
  assert.equal(cruise.active, true)
  assert.deepEqual(h.events, ['pause:cruise', 'resume:cruise'])
})

test('at one boundary highest eligible source wins; no lower continuation leaks', async () => {
  const h = harness(), transit = h.create('transit'), point = h.create('cruise'), barrage = h.create('barrage')
  await transit.acquire()
  const pointReady = point.acquire(), barrageReady = barrage.acquire()
  transit.boundary(true)
  await barrageReady
  assert.equal(h.coordinator.active, barrage)
  barrage.finish()
  await pointReady
  assert.equal(h.coordinator.active, point)
  transit.cancel()
  point.finish()
  assert.equal(h.coordinator.active, null)
  assert.deepEqual(h.events, [])
})

test('cancel pending boundary request and bulk output cancellation never revive prior sources', async () => {
  const h = harness(), cruise = h.create('cruise', 'mp3')
  await cruise.acquire()
  const abort = new AbortController()
  const barrage = h.coordinator.createJob({ role: 'barrage', signal: abort.signal })
  await barrage.acquire()
  h.coordinator.cancelAll()
  assert.equal(h.coordinator.active, null)
  assert.deepEqual(h.events, ['pause:cruise'])
  assert.equal(await barrage.acquire(), false)
  const live = h.create('cruise')
  await live.acquire()
  const pending = h.coordinator.createJob({ role: 'barrage', signal: abort.signal })
  const ready = pending.acquire()
  abort.abort()
  assert.equal(await ready, false)
  assert.equal(live.active, true)
})

test('a ready same-priority continuation stays atomic, while a not-ready one releases the speaker', async () => {
  const h = harness(), transit = h.create('transit', 'mp3'), cruise = h.create('cruise')
  await transit.acquire()
  await cruise.acquire()
  cruise.boundary(true)
  assert.equal(h.coordinator.active, cruise)
  assert.deepEqual(h.events, ['pause:transit'])
  cruise.boundary(false)
  assert.equal(h.coordinator.active, transit)
  assert.deepEqual(h.events, ['pause:transit', 'resume:transit'])
})

test('a not-ready continuation can hold silence without inserting transit, but allows ready barrage', async () => {
  const h = harness(), transit = h.create('transit', 'mp3'), cruise = h.create('cruise')
  await transit.acquire()
  await cruise.acquire()
  cruise.boundary(false, { hold: true })
  assert.equal(h.coordinator.active, cruise)
  assert.deepEqual(h.events, ['pause:transit'])
  const barrage = h.create('barrage')
  await barrage.acquire()
  assert.equal(h.coordinator.active, barrage)
  barrage.finish()
  assert.equal(h.coordinator.active, cruise)
  assert.deepEqual(h.events, ['pause:transit'])
})
