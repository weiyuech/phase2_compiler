/** Apply a persisted output setting and run disruptive cleanup only when the
 * playback destination really changes. Volume-only saves stay in-flight. */
export function applyAudioOutputConfig({ audioOutput, config, onDestinationChange }) {
  const previous = audioOutput.getConfig()
  const next = audioOutput.validateConfig(config)
  if (next.destination !== previous.destination) onDestinationChange?.(next, previous)
  return audioOutput.setConfig(next)
}
