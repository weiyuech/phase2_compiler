import assert from 'node:assert/strict'
import test from 'node:test'
import { applyAudioOutputConfig } from '../src/tts/audio-output-config.js'

function fixture(initial = { destination: 'robot', robotVolumePercent: 100 }) {
  let current = { ...initial }
  const calls = []
  return {
    calls,
    audioOutput: {
      getConfig: () => ({ ...current }),
      validateConfig: config => {
        if (!['local', 'robot'].includes(config.destination ?? current.destination)) throw new Error('invalid')
        return { ...current, ...config }
      },
      setConfig: config => {
        calls.push({ type: 'set', config })
        current = { ...config }
        return { ...config }
      },
    },
  }
}

test('volume-only backend setting remains in-flight without destination cleanup', () => {
  const h = fixture()
  const changes = []
  const saved = applyAudioOutputConfig({
    audioOutput: h.audioOutput,
    config: { destination: 'robot', robotVolumePercent: 65 },
    onDestinationChange: (...args) => changes.push(args),
  })
  assert.deepEqual(saved, { destination: 'robot', robotVolumePercent: 65 })
  assert.deepEqual(changes, [])
})

test('backend setting retains destination cleanup and validates before cleanup', () => {
  const h = fixture()
  const changes = []
  const saved = applyAudioOutputConfig({
    audioOutput: h.audioOutput,
    config: { destination: 'local', robotVolumePercent: 65 },
    onDestinationChange: (...args) => changes.push(args),
  })
  assert.deepEqual(saved, { destination: 'local', robotVolumePercent: 65 })
  assert.equal(changes.length, 1)
  assert.deepEqual(changes[0], [saved, { destination: 'robot', robotVolumePercent: 100 }])
  assert.throws(() => applyAudioOutputConfig({
    audioOutput: h.audioOutput,
    config: { destination: 'invalid' },
    onDestinationChange: () => changes.push('unexpected'),
  }), /invalid/)
  assert.equal(changes.length, 1)
})
