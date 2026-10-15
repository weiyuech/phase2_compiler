// Bounds on local unsent WebSocket bytes, not the robot's playback buffer.
// Normal PCM is 640 bytes / 20 ms; JSON/base64 adds transport overhead.
export const AUDIO_SEND_POLICY = Object.freeze({
  highWaterBytes: 64 * 1024,
  lowWaterBytes: 16 * 1024,
  hardLimitBytes: 1024 * 1024,
  stallTimeoutMs: 15000,
  pollMs: 20,
  drainNoticeMs: 250,
  maxPacingCorrectionMs: 2,
})

// Preserve the 20 ms average cadence through ordinary timer jitter, but never
// repay a stall with a burst. A missed whole frame starts a fresh clock phase.
export function nextAudioFrameDeadline(deadline, sentAt, durationMs, resetPhase = false) {
  const base = resetPhase || sentAt - deadline >= durationMs ? sentAt : deadline
  return Math.max(base + durationMs,
    sentAt + Math.max(0, durationMs - AUDIO_SEND_POLICY.maxPacingCorrectionMs))
}
