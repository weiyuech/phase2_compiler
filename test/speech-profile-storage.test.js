import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import * as fs from 'node:fs'
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { speechProfileKeys, speechProfileMigration, selectSpeechProfileChanges } from '../src/config/speech-profiles.js'

const main = fs.readFileSync(new URL('../robot-ui/src/main/index.js', import.meta.url), 'utf8')
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
  vm.runInContext(main.slice(main.indexOf("ipcMain.handle('read-public-env'")), context)
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
