import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { hashAudioBuffer } from '../src/tts/audio-buffer-hash.js'

test('cooperative audio hashing preserves SHA256 for small, exact and partial chunks', async () => {
  for (const bytes of [0, 31, 1024 * 1024, 3 * 1024 * 1024 + 17]) {
    const input = Buffer.alloc(bytes, 0x93)
    const expected = createHash('sha256').update(input).digest('hex')
    assert.equal(await hashAudioBuffer(input), expected)
    assert.equal(input.every(byte => byte === 0x93), true)
  }
})

test('large audio hashing yields to other event-loop work before completing', async () => {
  const input = Buffer.alloc(8 * 1024 * 1024 + 1, 0x57)
  let complete = false
  const pending = hashAudioBuffer(input).then(value => { complete = true; return value })
  let turns = 0
  while (!complete) { await nextTurn(); turns++ }
  assert.ok(turns >= 7, `expected cooperative turns, got ${turns}`)
  assert.equal(await pending, createHash('sha256').update(input).digest('hex'))
})

test('audio hashing honors cancellation before work and between chunks', async () => {
  const controller = new AbortController()
  const input = Buffer.alloc(8 * 1024 * 1024, 0x29)
  const pending = hashAudioBuffer(input, controller.signal)
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError', code: 'AUDIO_CANCELLED' })
  await assert.rejects(hashAudioBuffer(input, controller.signal), { code: 'AUDIO_CANCELLED' })
})
