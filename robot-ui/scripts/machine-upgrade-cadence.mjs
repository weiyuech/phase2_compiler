import assert from 'node:assert/strict'

// Summarize timestamps already captured from the real packaged backend by the
// existing loopback upgrade test. This is transport observation, not playout.
export function summarizeReceivedPcmCadence(frames) {
  assert.ok(Array.isArray(frames) && frames.length >= 2, 'PCM cadence needs adjacent received frames')
  const connection = frames[0].connection
  let audioDurationMs = 0
  for (let index = 0; index < frames.length; index++) {
    const frame = frames[index]
    assert.ok(Number.isFinite(frame.at) && (!index || frame.at >= frames[index - 1].at),
      'PCM receive timestamps must be finite and nondecreasing')
    assert.equal(frame.connection, connection, 'PCM cadence cannot cross a connection replacement')
    assert.ok(Number.isInteger(frame.bytes?.length) && frame.bytes.length > 0 && frame.bytes.length % 2 === 0,
      'PCM cadence requires complete signed-16-bit samples')
    audioDurationMs += frame.bytes.length / 32
  }
  // First-to-last receipt covers the preceding frames only. The last frame's
  // acoustic duration and the backend's final drain are not observed here.
  const comparedAudioMs = audioDurationMs - frames.at(-1).bytes.length / 32
  const elapsedMs = frames.at(-1).at - frames[0].at
  assert.ok(elapsedMs > 0, 'PCM cadence needs a positive capture interval')
  return {
    measurement: 'actual-backend-loopback-receipt-not-robot-playout',
    frames: frames.length, audioDurationMs, comparedAudioMs, elapsedMs,
    driftMs: elapsedMs - comparedAudioMs,
    driftRatio: (elapsedMs - comparedAudioMs) / comparedAudioMs,
    sendRateRatio: comparedAudioMs / elapsedMs,
  }
}

export function assertReceivedPcmCadence(summary) {
  assert.ok(summary.comparedAudioMs >= 1000, 'Complete-clip cadence requires at least one second of comparable PCM')
  // Engineering regression bound for sustained slowdown, not a jitter limit or
  // a criterion for whether a physical robot underruns. Loopback callbacks may
  // arrive together, so their individual minimum spacing is not constrained.
  assert.ok(Number.isFinite(summary.driftRatio) && summary.driftRatio <= 0.1,
    `Packaged backend PCM delivery is too slow: ${summary.elapsedMs.toFixed(1)} ms for ${summary.comparedAudioMs.toFixed(1)} ms between received frames`)
  return summary
}
