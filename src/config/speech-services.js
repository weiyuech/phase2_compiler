import { LLMRewriter } from '../llm/index.js'
import { TTSEngine } from '../tts/index.js'
import { resolveSpeechProfile } from './speech-profiles.js'

export function createSpeechServices({ env = process.env, audioOutput, coordinator, diagnostics } = {}) {
  const services = {}
  for (const [profile, llmName, ttsName] of [
    ['cruise', 'llm', 'tts'], ['transit', 'transitLlm', 'transitTts'], ['barrage', 'barrageLlm', 'barrageTts'],
  ]) {
    const config = resolveSpeechProfile(env, profile)
    services[llmName] = new LLMRewriter(config)
    services[ttsName] = new TTSEngine({ ...config, audioOutput, coordinator, diagnostics, role: profile })
  }
  // Manual testing shares transit credentials, not point narration credentials.
  services.manualTts = services.transitTts
  services.stationaryTts = services.tts
  return services
}
