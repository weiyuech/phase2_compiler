// Bounds on local unsent WebSocket bytes, not the robot's playback buffer.
// Normal PCM is 640 bytes / 20 ms; JSON/base64 adds transport overhead.
export const AUDIO_SEND_POLICY = Object.freeze({
  highWaterBytes: 64 * 1024,
  lowWaterBytes: 16 * 1024,
  hardLimitBytes: 1024 * 1024,
  stallTimeoutMs: 15000,
  pollMs: 20,
  drainNoticeMs: 250,
  maxPacingCorrectionMs: 10,
})

// Keep the nominal clock independent of the minimum physical packet spacing.
// Feeding that spacing back into this deadline permanently accumulates coarse
// Windows timer rounding (20 ms requests can wake about 31 ms apart).
// Missing a whole frame discards the timing debt rather than creating a burst.
export function nextAudioFrameDeadline(deadline, sentAt, durationMs, resetPhase = false) {
  const base = resetPhase || sentAt - deadline >= durationMs ? sentAt : deadline
  return base + durationMs
}

// Same-session correction is bounded to half a full frame. Handoffs, resume
// boundaries and the final tail always retain the full previous frame duration.
export function audioFrameWireDeadline(sentAt, durationMs, boundary = false) {
  return sentAt + (boundary ? durationMs : Math.max(0, durationMs - AUDIO_SEND_POLICY.maxPacingCorrectionMs))
}

// Shared by production and the actual packaged-runtime cadence check. No spin
// waiting or repeated sends in one callback; early wakes are rechecked by caller.
export function scheduleAudioFrame(callback, { deadline, wireDeadline = 0,
  now = performance.now(), schedule = setTimeout }) {
  return schedule(callback, Math.max(0, Math.ceil(Math.max(deadline, wireDeadline) - now)))
}
