import test from 'node:test'
import assert from 'node:assert/strict'
import { AUDIO_SEND_POLICY, nextAudioFrameDeadline, audioFrameWireDeadline, scheduleAudioFrame } from '../src/robot/audio-send-policy.js'
import { splitSentences } from '../src/tts/sentence-preparation.js'

// Pure calculations/text only: no robot, socket, provider or fake transport.
test('audio thresholds leave room for recovery before the emergency bound', () => {
  const p = AUDIO_SEND_POLICY
  assert.ok(0 < p.lowWaterBytes && p.lowWaterBytes < p.highWaterBytes)
  assert.ok(p.highWaterBytes < p.hardLimitBytes)
  assert.equal(p.hardLimitBytes, 1024 * 1024)
  assert.ok(p.pollMs < p.stallTimeoutMs)
})

test('lateness through 200ms preserves nominal phase independently of bounded wire spacing', () => {
  const due = 1000
  assert.equal(AUDIO_SEND_POLICY.maxRecoverableLatenessMs, 200)
  for (const lateness of [0, 0.2, 0.8, 1, 2, 5, 10, 19.9, 20, 21, 40, 85, 199.9, 200]) {
    const sentAt = due + lateness
    const next = nextAudioFrameDeadline(due, sentAt, 20)
    assert.equal(next, due + 20)
    const wire = audioFrameWireDeadline(sentAt, 20)
    assert.ok(Math.abs(wire - sentAt - 10) < 1e-9)
    assert.ok(Math.max(next, wire) - sentAt >= 10 - 1e-9)
  }
  assert.equal(nextAudioFrameDeadline(due, due + 0.8, 20), due + 20)
})

test('coarse timer rounding does not accumulate permanent sender slowdown', () => {
  // Deadline arithmetic only: these are clock rounding models, not a robot.
  // The regression used to turn a 15.625 ms tick into a 31.25 ms send cadence.
  for (const quantum of [1, 4, 10, 15.625, 16]) {
    for (const rounding of ['relative', 'global']) {
      let sentAt = 0, nominal = 20
      const count = 5000
      for (let i = 0; i < count; i++) {
        const previous = sentAt
        const wire = audioFrameWireDeadline(previous, 20)
        const delay = scheduleAudioFrame(() => {}, {
          deadline: nominal, wireDeadline: wire, now: previous,
          schedule: (_callback, wait) => wait,
        })
        sentAt = rounding === 'relative'
          ? previous + Math.ceil(delay / quantum) * quantum
          : Math.ceil((previous + delay) / quantum) * quantum
        assert.ok(sentAt - previous >= 10, `${quantum} ${rounding}: compressed spacing`)
        nominal = nextAudioFrameDeadline(nominal, sentAt, 20)
      }
      assert.ok(sentAt >= count * 20, 'must not run faster than the nominal audio clock')
      assert.ok(sentAt - count * 20 <= quantum * 2, `${quantum} ${rounding}: accumulated drift ${sentAt - count * 20}ms`)
    }
  }
})

test('four hours of deadline arithmetic retain phase after isolated recoverable delays', () => {
  // Pure deadline arithmetic, not a wall-clock endurance run or a model of a
  // robot. Selected callbacks are 20–190ms late relative to their deadlines;
  // surrounding callbacks only receive the specified timer rounding.
  const frameMs = 20
  const frameCount = 4 * 60 * 60 * 1000 / frameMs
  const delays = [20, 35, 65, 100, 150, 190]
  const nextWithFormerCutoff = (deadline, sentAt, durationMs) =>
    (sentAt - deadline >= durationMs ? sentAt : deadline) + durationMs

  function calculate(nextDeadline, quantum, rounding) {
    let sentAt = 0, nominal = frameMs, delayedCallbacks = 0
    let minSpacing = Infinity, minPhase = Infinity, maxPhase = 0
    let maxNominalDrift = 0, recoveredAfterDelay = 0
    for (let frame = 1; frame < frameCount; frame++) {
      const previous = sentAt
      const delay = scheduleAudioFrame(() => {}, {
        deadline: nominal, wireDeadline: audioFrameWireDeadline(previous, frameMs), now: previous,
        schedule: (_callback, wait) => wait,
      })
      sentAt = rounding === 'relative'
        ? previous + Math.ceil(delay / quantum) * quantum
        : Math.ceil((previous + delay) / quantum) * quantum
      // Events are separated by nearly 30 seconds, leaving ample time for
      // bounded correction. They are callback lateness, not extra wire data.
      if (frame % 1499 === 100) {
        sentAt = Math.max(sentAt, nominal + delays[delayedCallbacks % delays.length])
        delayedCallbacks++
      }
      minSpacing = Math.min(minSpacing, sentAt - previous)
      const phase = sentAt - frame * frameMs
      minPhase = Math.min(minPhase, phase)
      maxPhase = Math.max(maxPhase, phase)
      nominal = nextDeadline(nominal, sentAt, frameMs)
      maxNominalDrift = Math.max(maxNominalDrift, nominal - (frame + 1) * frameMs)
      if (frame % 1499 === 200 && phase <= quantum * 2) recoveredAfterDelay++
    }
    return { minSpacing, minPhase, maxPhase, maxNominalDrift, delayedCallbacks,
      recoveredAfterDelay, finalPhase: sentAt - (frameCount - 1) * frameMs }
  }

  for (const quantum of [1, 15.625]) {
    for (const rounding of ['relative', 'global']) {
      const label = `${quantum}ms ${rounding}`
      const current = calculate(nextAudioFrameDeadline, quantum, rounding)
      assert.ok(current.delayedCallbacks > 400, `${label}: delayed callbacks must be exercised`)
      assert.ok(current.minSpacing >= 10, `${label}: full frames must remain at least 10ms apart`)
      assert.ok(current.minPhase >= 0, `${label}: sends must never precede the PCM sample clock`)
      assert.equal(current.maxNominalDrift, 0, `${label}: recoverable delays must not accumulate phase loss`)
      assert.ok(current.maxPhase <= 200, `${label}: correction must remain within the recovery window`)
      assert.ok(current.finalPhase <= quantum * 2, `${label}: final phase must return to ordinary rounding`)
      assert.equal(current.recoveredAfterDelay, current.delayedCallbacks,
        `${label}: every isolated delay must recover before the next delay`)

      const former = calculate(nextWithFormerCutoff, quantum, rounding)
      assert.ok(former.finalPhase > 30000, `${label}: the former 20ms cutoff must expose cumulative slowdown`)
      assert.ok(former.maxNominalDrift > current.maxNominalDrift,
        `${label}: the comparison must distinguish recoverable debt from discarded phase`)
    }
  }
})

test('handoff and final-tail guards preserve every sample duration', () => {
  for (const duration of [1, 4, 10, 20]) {
    assert.equal(audioFrameWireDeadline(1000, duration, true), 1000 + duration)
  }
  assert.equal(scheduleAudioFrame(() => {}, {
    deadline: 1000, wireDeadline: 1010.25, now: 1000,
    schedule: (_callback, wait) => wait,
  }), 11)
})

test('stalls beyond the recovery window retain a fresh full frame interval', () => {
  for (const lateness of [200.01, 201, 500, 15000]) {
    assert.equal(nextAudioFrameDeadline(1000, 1000 + lateness, 20), 1020 + lateness)
  }
})

test('explicit lifecycle resets discard debt even inside the recovery window', () => {
  for (const duration of [1, 5, 20]) {
    for (const lateness of [0, 1, 20, 85, 200]) {
      const sentAt = 1000 + lateness
      assert.equal(nextAudioFrameDeadline(1000, sentAt, duration, true), sentAt + duration)
      assert.equal(audioFrameWireDeadline(sentAt, duration, true), sentAt + duration)
    }
  }
})

test('long synthesis units retain content and Unicode within the preparation bound', () => {
  const inputs = [
    '这是连续的长文介绍'.repeat(800),
    ('甲'.repeat(490) + '，价格123,456.78元，\n继续介绍😀𠮷。').repeat(20),
    '甲'.repeat(490) + ' '.repeat(1300) + '乙',
    '1'.repeat(1200),
  ]
  for (const input of inputs) {
    const units = splitSentences(input)
    assert.ok(units.every(unit => Array.from(unit).length > 0 && Array.from(unit).length <= 500))
    assert.equal(units.join('').replace(/\s/gu, ''), input.replace(/\s/gu, ''))
    assert.ok(units.every(unit => unit.isWellFormed()))
  }
  assert.deepEqual(splitSentences('欢迎，先看这里。价格3.14元。'), ['欢迎，先看这里。', '价格3.14元。'])
})
