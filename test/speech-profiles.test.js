import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveSpeechProfile, speechProfileMigration, selectSpeechProfileChanges } from '../src/config/speech-profiles.js'
import { createSpeechServices } from '../src/config/speech-services.js'
import { registerTourControls } from '../src/task/ui-controls.js'

const legacy = { TTS_API_KEY: 'old-main-key', TTS_VOICE_TYPE: 'old-voice', DOUBAO_API_KEY: 'old-llm', DOUBAO_MODEL: 'old-model', BARRAGE_TTS_VOICE_TYPE: 'barrage-voice' }

test('legacy upgrade copies effective settings once without subsequent inheritance', () => {
  const migration = speechProfileMigration(legacy)
  assert.equal(migration.TRANSIT_TTS_API_KEY, 'old-main-key')
  assert.equal(migration.TRANSIT_DOUBAO_MODEL, 'old-model')
  assert.equal(migration.BARRAGE_TTS_API_KEY, 'old-main-key')
  assert.equal(migration.BARRAGE_TTS_VOICE_TYPE, 'barrage-voice')
  assert.equal(legacy.TRANSIT_TTS_API_KEY, undefined)
  const migrated = { ...legacy, ...migration, TTS_API_KEY: 'changed-main', TRANSIT_TTS_API_KEY: '' }
  assert.deepEqual(speechProfileMigration(migrated), {})
  assert.equal(resolveSpeechProfile(migrated, 'transit').TTS_API_KEY, '')
  assert.equal(resolveSpeechProfile(migrated, 'barrage').TTS_API_KEY, 'old-main-key')
})

test('partial explicit transit profile does not import missing keys from cruise', () => {
  const config = resolveSpeechProfile({ ...legacy, TRANSIT_TTS_API_KEY: 'independent' }, 'transit')
  assert.equal(config.TTS_API_KEY, 'independent')
  assert.equal(config.TTS_VOICE_TYPE, '')
  assert.equal(config.DOUBAO_API_KEY, '')
})

test('atomic profile updates cannot change another profile or unrelated environment keys', () => {
  assert.deepEqual(selectSpeechProfileChanges('transit', {
    TRANSIT_TTS_API_KEY: 'transit', TRANSIT_TTS_VOICE_TYPE: 'voice',
    TTS_API_KEY: 'cruise', BARRAGE_TTS_API_KEY: 'barrage', NODE_OPTIONS: 'invalid',
  }), { TRANSIT_TTS_VOICE_TYPE: 'voice', TRANSIT_TTS_API_KEY: 'transit' })
  assert.throws(() => selectSpeechProfileChanges('__proto__', {}), /Unknown/)
})

test('real speech clients keep profiles independent: manual uses transit, stationary uses cruise', async t => {
  const env = { SPEECH_PROFILES_VERSION: '1' }
  for (const [prefix, name] of [['', 'cruise'], ['TRANSIT_', 'transit'], ['BARRAGE_', 'barrage']]) {
    env[prefix + 'TTS_API_KEY'] = name + '-tts'
    env[prefix + 'TTS_VOICE_TYPE'] = name + '-voice'
    env[prefix + 'DOUBAO_API_KEY'] = name + '-llm'
    env[prefix + 'DOUBAO_MODEL'] = name + '-model'
    env[prefix + 'DEEPSEEK_API_KEY'] = name + '-fallback'
  }
  const services = createSpeechServices({ env })
  t.after(() => { for (const name of ['tts', 'transitTts', 'barrageTts']) services[name].destroy() })
  for (const [llm, tts, name] of [[services.llm, services.tts, 'cruise'], [services.transitLlm, services.transitTts, 'transit'], [services.barrageLlm, services.barrageTts, 'barrage']]) {
    assert.equal(tts.wsClient.apiKey, name + '-tts')
    assert.equal(tts.wsClient.voiceType, name + '-voice')
    assert.equal(llm.primary.apiKey, name + '-llm')
    assert.equal(llm.primary.model, name + '-model')
    assert.equal(llm.fallback.apiKey, name + '-fallback')
  }
  const handlers = {}, calls = []
  services.transitTts.speak = async () => { calls.push('transit'); return { ok: true } }
  services.tts.speak = async () => { calls.push('cruise'); return { ok: true } }
  assert.equal(services.stationaryTts, services.tts)
  services.llm.primary.rewriteCustom = async (_system, input) => {
    assert.match(input, /stationary/)
    calls.push('cruise-llm')
    return '原地改写稿'
  }
  const controls = registerTourControls({ uiBridge: { on: (key, fn) => { handlers[key] = fn }, broadcast() {} }, tour: { isRunning: false }, tts: services.manualTts, stationaryTts: services.stationaryTts, stationaryLlm: services.llm, logger: { log() {}, error() {} } })
  await handlers.onTestSpeech('manual')
  assert.deepEqual(calls, ['transit'])
  handlers.onStartStationarySpeech({ text: 'stationary', loop: false })
  await controls.stationary.finished
  assert.deepEqual(calls, ['transit', 'cruise-llm', 'cruise'])
})

test('blank independent profiles cannot borrow credentials from process.env', async t => {
  const keys = ['TTS_API_KEY', 'TTS_VOICE_TYPE', 'DOUBAO_API_KEY', 'DOUBAO_MODEL', 'DEEPSEEK_API_KEY']
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  for (const key of keys) process.env[key] = 'ambient-secret'
  t.after(() => { for (const key of keys) { if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key] } })
  const services = createSpeechServices({ env: { SPEECH_PROFILES_VERSION: '1' } })
  t.after(() => { for (const name of ['tts', 'transitTts', 'barrageTts']) services[name].destroy() })
  for (const name of ['tts', 'transitTts', 'barrageTts']) {
    assert.equal(services[name].enabled, false)
    assert.equal(services[name].wsClient.apiKey, '')
    await assert.rejects(services[name].prepareText('hello'), /TTS 未配置/)
  }
  for (const name of ['llm', 'transitLlm', 'barrageLlm']) {
    assert.equal(services[name].primary.apiKey, '')
    assert.equal(services[name].fallback.apiKey, '')
  }
})
