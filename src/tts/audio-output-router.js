// Stable public entry point. Robot playback is prepared in full before activation.
export { PreparedAudioOutputRouter as AudioOutputRouter } from './prepared-audio-router.js'

export const ROBOT_AUDIO_FORMAT = Object.freeze({
  rate: 16000,
  channels: 1,
  sampleFormat: 's16le',
  chunkMs: 20,
  chunkBytes: 640,
})
