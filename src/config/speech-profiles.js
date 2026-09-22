// Three independent credential stores. Playback priority is a separate concern.
export const SPEECH_PROFILE_VERSION_KEY = 'SPEECH_PROFILES_VERSION'
export const SPEECH_PUBLIC_FIELDS = Object.freeze([
  'LLM_PROVIDER', 'LLM_FALLBACK_PROVIDER', 'QWEN_MODEL',
  'DOUBAO_MODEL', 'DEEPSEEK_PLATFORM', 'DEEPSEEK_MODEL', 'DEEPSEEK_ARK_MODEL', 'TTS_VOICE_TYPE', 'TTS_CLUSTER',
  'TTS_RESOURCE_ID', 'TTS_AUTH_MODE', 'TTS_TIMEOUT_MS', 'LLM_TIMEOUT_MS', 'LLM_MAX_TOKENS',
])
export const SPEECH_SECRET_FIELDS = Object.freeze([
  'DOUBAO_API_KEY', 'DEEPSEEK_API_KEY', 'DEEPSEEK_ARK_API_KEY', 'QWEN_API_KEY',
  'TTS_APP_ID', 'TTS_ACCESS_TOKEN', 'TTS_API_KEY',
])
const PREFIX = Object.freeze({ cruise: '', transit: 'TRANSIT_', barrage: 'BARRAGE_' })
const FIELDS = [...SPEECH_PUBLIC_FIELDS, ...SPEECH_SECRET_FIELDS]

export function speechProfileKeys(profile, { secrets = false } = {}) {
  if (!Object.hasOwn(PREFIX, profile)) throw new Error('Unknown speech profile')
  return (secrets ? SPEECH_SECRET_FIELDS : SPEECH_PUBLIC_FIELDS).map(key => PREFIX[profile] + key)
}

/** Copy the formerly effective settings once, before enabling independent blanks.
 * This migration returns only changes; it neither logs nor writes credentials. */
export function speechProfileMigration(env) {
  if (env[SPEECH_PROFILE_VERSION_KEY] === '1') return {}
  const changes = { [SPEECH_PROFILE_VERSION_KEY]: '1' }
  for (const profile of ['transit', 'barrage']) {
    const prefix = PREFIX[profile]
    const existingTransit = profile === 'transit' && FIELDS.some(key => Object.hasOwn(env, prefix + key))
    for (const key of FIELDS) {
      // Transit used cruise settings; barrage used per-field || fallbacks.
      changes[prefix + key] = existingTransit ? (env[prefix + key] ?? '') : (env[prefix + key] || env[key] || '')
    }
  }
  return changes
}

export function resolveSpeechProfile(env, profile) {
  if (!Object.hasOwn(PREFIX, profile)) throw new Error('Unknown speech profile')
  const migrated = { ...env, ...speechProfileMigration(env) }
  return Object.fromEntries(FIELDS.map(key => [key, migrated[PREFIX[profile] + key] ?? '']))
}

export function selectSpeechProfileChanges(profile, changes) {
  const allowed = [...speechProfileKeys(profile), ...speechProfileKeys(profile, { secrets: true })]
  if (profile === 'cruise') allowed.push('ROBOT_PORT', 'ROBOT_URL')
  return Object.fromEntries(allowed.filter(key => Object.hasOwn(changes, key)).map(key => [key, changes[key]]))
}
