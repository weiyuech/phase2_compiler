import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { DEFAULT_OCR_JUDGE_PROMPT } from '../../src/phase2/ocr/judge-prompt.js'
import { speechProfileKeys } from '../../src/config/speech-profiles.js'

const require = createRequire(import.meta.url)
const Vue = require('vue')
const { parse, compileScript, compileTemplate } = require('@vue/compiler-sfc')
const source = readFileSync(new URL('../src/renderer/src/components/SystemSettings.vue', import.meta.url), 'utf8')
const { descriptor, errors } = parse(source)
assert.deepEqual(errors, [])
assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename: 'SystemSettings.vue', id: 'speech-profiles' }).errors, [])
const script = compileScript(descriptor, { id: 'speech-profiles' }).content
const createComponent = new Function('Vue', 'ElMessageBox', 'ElMessage', 'window', 'setTimeout', 'DEFAULT_OCR_JUDGE_PROMPT', script
  .replace(/import \{ ref, reactive, onMounted, onBeforeUnmount, watch \} from 'vue'/, 'const { ref, reactive, onMounted, onBeforeUnmount, watch } = Vue')
  .replace(/import \{ ElMessageBox, ElMessage \}\s+from 'element-plus'/, '')
  .replace(/import AudioDiagnostics from '.\/AudioDiagnostics.vue'/, 'const AudioDiagnostics = {}')
  .replace(/import \{ DEFAULT_OCR_JUDGE_PROMPT \} from '[^']+'/u, '')
  .replace('export default', 'return'))

function fixture(t) {
  const saved = [], errors = [], cleanups = []
  const stored = {}
  for (const profile of ['cruise', 'transit', 'barrage']) {
    for (const key of [...speechProfileKeys(profile), ...speechProfileKeys(profile, { secrets: true })]) stored[key] = profile + '-original'
  }
  let restarts = 0
  const api = {
    readPublicEnv: async () => ({ ok: true, env: Object.fromEntries(['cruise', 'transit', 'barrage'].flatMap(profile => speechProfileKeys(profile)).map(key => [key, stored[key]])) }),
    readSensitiveEnv: async () => ({ ok: true, env: Object.fromEntries(['cruise', 'transit', 'barrage'].flatMap(profile => speechProfileKeys(profile, { secrets: true })).map(key => [key, stored[key]])) }),
    writePublicEnv: async changes => { saved.push({ public: true, changes }); Object.assign(stored, changes); return { ok: true } },
    writeSpeechProfile: async (pwd, profile, changes) => { saved.push({ pwd, profile, changes }); Object.assign(stored, changes); return { ok: true } },
    restartBackend: async () => { restarts++ },
  }
  const component = createComponent({ ...Vue, onMounted() {}, onBeforeUnmount: fn => cleanups.push(fn) },
    { prompt: async () => ({ value: 'test-password' }) }, { error: msg => errors.push(msg) }, { api }, () => 1, DEFAULT_OCR_JUDGE_PROMPT)
  const scope = Vue.effectScope()
  const state = scope.run(() => component.setup({ wsRef: null }, { expose() {} }))
  t.after(() => { for (const cleanup of cleanups) cleanup(); scope.stop() })
  return { state, saved, stored, errors, restarts: () => restarts }
}

test('three clearly named sections select their own public and secret fields', t => {
  const h = fixture(t)
  assert.deepEqual(h.state.navItems.slice(0, 3).map(item => item.label), ['巡游讲解', '过渡音频与手动播报', '弹幕回复'])
  for (const profile of ['cruise', 'transit', 'barrage']) {
    h.state.activeSection.value = profile
    const expected = speechProfileKeys(profile)
    const actual = h.state.currentPublicEnvDef().map(item => item.key)
    for (const key of expected) assert.ok(actual.includes(key), key)
    assert.deepEqual(h.state.currentSensitiveKeys(), speechProfileKeys(profile, { secrets: true }))
  }
})

for (const [profile, prefix] of [['cruise', ''], ['transit', 'TRANSIT_'], ['barrage', 'BARRAGE_']]) {
  test(`${profile} saves voice/model and credentials together without saving another group's drafts`, async t => {
    const h = fixture(t)
    await h.state.loadPublicEnv()
    await h.state.doUnlock()
    h.state.activeSection.value = profile
    h.state.publicEnv[prefix + 'TTS_VOICE_TYPE'] = 'new-voice'
    h.state.sensitiveEnv[prefix + 'TTS_API_KEY'] = 'reused-api-key'
    await h.state.saveSensitiveEnv()
    assert.deepEqual(h.errors, [])
    assert.equal(h.saved.length, 1)
    assert.equal(h.saved[0].profile, profile)
    assert.equal(h.saved[0].changes[prefix + 'TTS_VOICE_TYPE'], 'new-voice')
    assert.equal(h.saved[0].changes[prefix + 'TTS_API_KEY'], 'reused-api-key')
    for (const other of ['cruise', 'transit', 'barrage'].filter(item => item !== profile)) {
      for (const key of speechProfileKeys(other, { secrets: true })) {
        assert.equal(h.saved[0].changes[key], undefined)
        assert.equal(h.stored[key], other + '-original')
      }
    }
    assert.equal(h.restarts(), 1)
    assert.equal(h.state.sensitiveUnlocked.value, false)
    assert.equal(Object.values(h.state.sensitiveEnv).every(value => value === ''), true)
  })
}

test('parameter-only save is scoped to the current profile and never sends credentials', async t => {
  const h = fixture(t)
  await h.state.loadPublicEnv()
  h.state.activeSection.value = 'transit'
  h.state.publicEnv.TTS_VOICE_TYPE = 'unsaved-cruise-draft'
  h.state.publicEnv.TRANSIT_TTS_VOICE_TYPE = 'transit-voice'
  await h.state.savePublicEnv()
  assert.equal(h.saved[0].changes.TTS_VOICE_TYPE, undefined)
  assert.equal(h.saved[0].changes.TRANSIT_TTS_API_KEY, undefined)
  assert.equal(h.stored.TTS_VOICE_TYPE, 'cruise-original')
  assert.equal(h.stored.TRANSIT_TTS_VOICE_TYPE, 'transit-voice')
})

test('unloaded settings cannot overwrite stored values with empty form defaults', async t => {
  const h = fixture(t)
  await h.state.savePublicEnv()
  await h.state.doUnlock()
  await h.state.saveSensitiveEnv()
  assert.equal(h.saved.length, 0)
  assert.equal(h.errors.length, 2)
})
