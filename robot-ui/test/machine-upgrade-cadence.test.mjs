import test from 'node:test'
import assert from 'node:assert/strict'
import { assertReceivedPcmCadence, summarizeReceivedPcmCadence } from '../scripts/machine-upgrade-cadence.mjs'

const capture = (intervalMs = 20, count = 500) => Array.from({ length: count }, (_, index) => ({
  bytes: Buffer.alloc(640), at: 100 + index * intervalMs, connection: 1,
}))

test('complete backend capture compares first-to-last receipt with preceding PCM duration', () => {
  const frames = capture()
  frames.at(-1).bytes = Buffer.alloc(128)
  const result = assertReceivedPcmCadence(summarizeReceivedPcmCadence(frames))
  assert.equal(result.audioDurationMs, 9984)
  assert.equal(result.comparedAudioMs, 9980)
  assert.equal(result.elapsedMs, 9980)
  assert.equal(result.sendRateRatio, 1)
  assert.equal(result.driftRatio, 0)
})

test('complete backend capture rejects sustained 31ms receipt of 20ms audio', () => {
  const result = summarizeReceivedPcmCadence(capture(31))
  assert.ok(result.sendRateRatio < 0.65)
  assert.equal(result.driftRatio, 0.55)
  assert.throws(() => assertReceivedPcmCadence(result), /too slow/)
})

test('backend aggregate gate accepts coalesced callbacks and enforces its 10 percent slowdown boundary', () => {
  const frames = capture()
  for (let index = 0; index < frames.length; index++) frames[index].at = 100 + Math.floor(index / 2) * 40
  assert.ok(assertReceivedPcmCadence(summarizeReceivedPcmCadence(frames)).sendRateRatio > 1)
  assert.equal(assertReceivedPcmCadence(summarizeReceivedPcmCadence(capture(22))).driftRatio, 0.1)
  assert.throws(() => assertReceivedPcmCadence(summarizeReceivedPcmCadence(capture(22.01))), /too slow/)
})

test('backend cadence refuses short captures, connection changes and invalid timestamps or PCM samples', () => {
  assert.throws(() => assertReceivedPcmCadence(summarizeReceivedPcmCadence(capture(20, 20))), /at least one second/)
  const changedConnection = capture()
  changedConnection[200].connection = 2
  assert.throws(() => summarizeReceivedPcmCadence(changedConnection), /connection replacement/)
  const reversed = capture()
  reversed[200].at = reversed[199].at - 1
  assert.throws(() => summarizeReceivedPcmCadence(reversed), /nondecreasing/)
  const invalid = capture()
  invalid[200].at = NaN
  assert.throws(() => summarizeReceivedPcmCadence(invalid), /finite/)
  const incomplete = capture()
  incomplete[200].bytes = Buffer.alloc(639)
  assert.throws(() => summarizeReceivedPcmCadence(incomplete), /complete signed-16-bit samples/)
})
