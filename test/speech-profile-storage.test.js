import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import * as fs from 'node:fs'
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { speechProfileKeys, speechProfileMigration, selectSpeechProfileChanges, resolveSpeechProfile } from '../src/config/speech-profiles.js'
import { LLMRewriter } from '../src/llm/index.js'

const main = fs.readFileSync(new URL('../robot-ui/src/main/machine-runtime.js', import.meta.url), 'utf8')
function fixture(t, text = '') {
  const dir = fs.mkdtempSync(join(tmpdir(), 'speech-profile-storage-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const ENV_PATH = join(dir, '.env'), ADMIN_PATH = join(dir, 'admin.json'), handlers = {}
  fs.writeFileSync(ENV_PATH, text)
  const context = vm.createContext({
    ...fs, randomBytes, scryptSync, timingSafeEqual, Buffer,
    ENV_PATH, ADMIN_PATH, speechProfileKeys, speechProfileMigration, selectSpeechProfileChanges,
    ipcMain: { handle: (key, fn) => { handlers[key] = fn } },
  })
  vm.runInContext(main.slice(main.indexOf('const PUBLIC_ENV_KEYS'), main.indexOf('// ─── .env helpers')), context)
  vm.runInContext(main.slice(main.indexOf('function parseEnv('), main.indexOf('// ─── Backend auto-start')), context)
  vm.runInContext(main.slice(main.indexOf("ipcMain.handle('read-public-env'"), main.indexOf("// End machine IPC")), context)
  fs.writeFileSync(ADMIN_PATH, JSON.stringify(context.hashPassword('test-password')))
  return { context, handlers, path: ENV_PATH, read: () => context.parseEnv(fs.readFileSync(ENV_PATH, 'utf8')) }
}

test('profile IPC migrates old effective settings then persists only the selected group', t => {
  const h = fixture(t, '# keep comment\nTTS_API_KEY=old-main\nTTS_VOICE_TYPE=old-voice\nROBOT_PORT=8765\n')
  const result = h.handlers['write-speech-profile'](null, 'test-password', 'transit', {
    TRANSIT_TTS_API_KEY: 'new-transit', TRANSIT_TTS_VOICE_TYPE: 'new-voice', TTS_API_KEY: 'must-not-write', ROBOT_PORT: 'invalid',
  })
  assert.equal(result.ok, true)
  const stored = h.read()
  assert.equal(stored.TTS_API_KEY, 'old-main')
  assert.equal(stored.BARRAGE_TTS_API_KEY, 'old-main')
  assert.equal(stored.TRANSIT_TTS_API_KEY, 'new-transit')
  assert.equal(stored.TRANSIT_TTS_VOICE_TYPE, 'new-voice')
  assert.equal(stored.SPEECH_PROFILES_VERSION, '1')
  assert.equal(stored.ROBOT_PORT, '8765')
  assert.ok(fs.readFileSync(h.path, 'utf8').startsWith('# keep comment'))
  assert.equal(h.handlers['write-speech-profile'](null, 'test-password', 'transit', { TRANSIT_TTS_API_KEY: '' }).ok, true)
  assert.equal(h.handlers['read-sensitive-env'](null, 'test-password').env.TRANSIT_TTS_API_KEY, '')
})

test('public IPC cannot read or write profile secrets; bad passwords cannot change settings', t => {
  const h = fixture(t, 'SPEECH_PROFILES_VERSION=1\nTRANSIT_TTS_API_KEY=secret\n')
  assert.equal(h.handlers['read-public-env']().env.TRANSIT_TTS_API_KEY, undefined)
  assert.equal(h.handlers['write-public-env'](null, { TRANSIT_TTS_API_KEY: 'attempt', TRANSIT_TTS_VOICE_TYPE: 'voice' }).ok, true)
  assert.equal(h.read().TRANSIT_TTS_API_KEY, 'secret')
  assert.equal(h.read().TRANSIT_TTS_VOICE_TYPE, 'voice')
  assert.equal(h.handlers['read-sensitive-env'](null, 'wrong').ok, false)
  const before = fs.readFileSync(h.path, 'utf8')
  assert.equal(h.handlers['write-speech-profile'](null, 'wrong', 'transit', { TRANSIT_TTS_API_KEY: 'attempt' }).ok, false)
  assert.equal(fs.readFileSync(h.path, 'utf8'), before)
  assert.equal(h.handlers['write-speech-profile'](null, 'test-password', 'transit', { TRANSIT_TTS_API_KEY: 'bad\nNODE_OPTIONS=x' }).ok, false)
  assert.equal(fs.readFileSync(h.path, 'utf8'), before)
})

for (const [profile, prefix] of [['cruise', ''], ['transit', 'TRANSIT_'], ['barrage', 'BARRAGE_']]) {
  test(`${profile}: DeepSeek platform switching preserves both credentials and keeps Ark keys private`, t => {
    const h = fixture(t, 'SPEECH_PROFILES_VERSION=1\n')
    const changes = {
      [prefix + 'LLM_PROVIDER']: 'deepseek', [prefix + 'LLM_FALLBACK_PROVIDER']: 'none',
      [prefix + 'DEEPSEEK_PLATFORM']: 'ark', [prefix + 'DEEPSEEK_API_KEY']: 'official-key',
      [prefix + 'DEEPSEEK_MODEL']: 'deepseek-chat', [prefix + 'DEEPSEEK_ARK_API_KEY']: 'ark-key',
      [prefix + 'DEEPSEEK_ARK_MODEL']: 'ep-test',
    }
    assert.equal(h.handlers['write-speech-profile'](null, 'test-password', profile, changes).ok, true)
    const ark = new LLMRewriter(resolveSpeechProfile(h.read(), profile)).primary
    assert.equal(ark.apiUrl, 'https://ark.cn-beijing.volces.com/api/v3/chat/completions')
    assert.equal(ark.apiKey, 'ark-key')
    assert.equal(ark.model, 'ep-test')
    assert.equal(h.handlers['read-public-env']().env[prefix + 'DEEPSEEK_ARK_API_KEY'], undefined)
    assert.equal(h.handlers['read-sensitive-env'](null, 'test-password').env[prefix + 'DEEPSEEK_ARK_API_KEY'], 'ark-key')
    assert.equal(h.handlers['write-public-env'](null, { [prefix + 'DEEPSEEK_PLATFORM']: 'official', [prefix + 'DEEPSEEK_ARK_API_KEY']: 'must-not-save' }).ok, true)
    const official = new LLMRewriter(resolveSpeechProfile(h.read(), profile)).primary
    assert.equal(official.apiUrl, 'https://api.deepseek.com/chat/completions')
    assert.equal(official.apiKey, 'official-key')
    assert.equal(official.model, 'deepseek-chat')
    assert.equal(h.read()[prefix + 'DEEPSEEK_ARK_API_KEY'], 'ark-key')
    for (const other of ['cruise', 'transit', 'barrage'].filter(p => p !== profile)) {
      assert.equal(resolveSpeechProfile(h.read(), other).DEEPSEEK_ARK_API_KEY, '')
    }
    const before = fs.readFileSync(h.path, 'utf8')
    for (const write of [changes => h.handlers['write-public-env'](null, changes),
      changes => h.handlers['write-speech-profile'](null, 'test-password', profile, changes)]) {
      assert.equal(write({ [prefix + 'DEEPSEEK_PLATFORM']: 'invalid' }).ok, false)
      assert.equal(fs.readFileSync(h.path, 'utf8'), before)
    }
  })

  test(`${profile}: saved Qwen settings survive IPC storage and construct the selected backend client`, t => {
    const h = fixture(t, 'SPEECH_PROFILES_VERSION=1\n')
    const changes = { [prefix + 'LLM_PROVIDER']: 'qwen', [prefix + 'LLM_FALLBACK_PROVIDER']: 'none',
      [prefix + 'QWEN_MODEL']: 'qwen3.8-flash', [prefix + 'QWEN_API_KEY']: 'synthetic-key' }
    assert.equal(h.handlers['write-speech-profile'](null, 'test-password', profile, changes).ok, true)
    const llm = new LLMRewriter(resolveSpeechProfile(h.read(), profile))
    assert.equal(llm.primary.name, 'qwen')
    assert.equal(llm.primary.model, 'qwen3.8-flash')
    assert.equal(llm.primary.apiKey, 'synthetic-key')
    assert.equal(llm.fallback, null)
    assert.equal(h.handlers['read-public-env']().env[prefix + 'LLM_PROVIDER'], 'qwen')
    assert.equal(h.handlers['read-public-env']().env[prefix + 'QWEN_API_KEY'], undefined)
    const before = fs.readFileSync(h.path, 'utf8')
    assert.equal(h.handlers['write-public-env'](null, { [prefix + 'LLM_PROVIDER']: 'invalid' }).ok, false)
    assert.equal(fs.readFileSync(h.path, 'utf8'), before)
  })
}
