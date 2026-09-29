import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { DEFAULT_STATIONARY_PROMPT } from '../../src/llm/stationary-prompt.js'
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
const createComponent = new Function('Vue', 'ElMessageBox', 'ElMessage', 'window', 'setTimeout', 'DEFAULT_OCR_JUDGE_PROMPT', 'DEFAULT_STATIONARY_PROMPT', script
  .replace(/import \{ ref, reactive, onMounted, onBeforeUnmount, watch \} from 'vue'/, 'const { ref, reactive, onMounted, onBeforeUnmount, watch } = Vue')
  .replace(/import \{ ElMessageBox, ElMessage \}\s+from 'element-plus'/, '')
  .replace(/import AudioDiagnostics from '.\/AudioDiagnostics.vue'/, 'const AudioDiagnostics = {}')
  .replace(/import \{ DEFAULT_OCR_JUDGE_PROMPT \} from '[^']+'/u, '')
  .replace(/import \{ DEFAULT_STATIONARY_PROMPT \} from '[^']+'/u, '')
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
    { prompt: async () => ({ value: 'test-password' }) }, { error: msg => errors.push(msg), success() {} }, { api }, () => 1, DEFAULT_OCR_JUDGE_PROMPT, DEFAULT_STATIONARY_PROMPT)
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
  test(`${profile} reuses only its own Doubao key and persists it only on explicit profile save`, async t => {
    const h = fixture(t), target = prefix + 'DEEPSEEK_ARK_API_KEY'
    await h.state.loadPublicEnv()
    await h.state.doUnlock()
    h.state.activeSection.value = profile
    const before = { ...h.state.sensitiveEnv }
    assert.equal(h.state.canReuseDoubaoKey(target), true)
    h.state.reuseDoubaoKey(target)
    assert.equal(h.state.sensitiveEnv[target], profile + '-original')
    h.state.sensitiveEnv[prefix + 'DOUBAO_API_KEY'] = '  newly-pasted-key  '
    h.state.reuseDoubaoKey(target)
    assert.equal(h.state.sensitiveEnv[target], 'newly-pasted-key')
    assert.equal(h.saved.length, 0)
    assert.equal(h.stored[target], profile + '-original')
    assert.equal(h.state.sensitiveEnv[prefix + 'DEEPSEEK_API_KEY'], before[prefix + 'DEEPSEEK_API_KEY'])
    for (const other of ['cruise', 'transit', 'barrage'].filter(p => p !== profile)) {
      for (const key of speechProfileKeys(other, { secrets: true })) assert.equal(h.state.sensitiveEnv[key], before[key])
    }
    await h.state.saveSensitiveEnv()
    assert.equal(h.saved[0].changes[target], 'newly-pasted-key')
    assert.equal(h.restarts(), 1)
    assert.equal(h.state.canReuseDoubaoKey(target), false)
  })

  test(`${profile} saves voice/model and credentials together without saving another group's drafts`, async t => {
    const h = fixture(t)
    await h.state.loadPublicEnv()
    await h.state.doUnlock()
    h.state.activeSection.value = profile
    h.state.publicEnv[prefix + 'TTS_VOICE_TYPE'] = 'new-voice'
    h.state.publicEnv[prefix + 'LLM_PROVIDER'] = 'qwen'
    h.state.publicEnv[prefix + 'LLM_FALLBACK_PROVIDER'] = 'none'
    h.state.publicEnv[prefix + 'QWEN_MODEL'] = 'qwen3.8-flash'
    h.state.publicEnv[prefix + 'DEEPSEEK_PLATFORM'] = 'ark'
    h.state.publicEnv[prefix + 'DEEPSEEK_ARK_MODEL'] = 'ep-test'
    h.state.sensitiveEnv[prefix + 'DEEPSEEK_ARK_API_KEY'] = 'synthetic-ark-key'
    h.state.sensitiveEnv[prefix + 'QWEN_API_KEY'] = 'synthetic-qwen-key'
    h.state.sensitiveEnv[prefix + 'TTS_API_KEY'] = 'reused-api-key'
    await h.state.saveSensitiveEnv()
    assert.deepEqual(h.errors, [])
    assert.equal(h.saved.length, 1)
    assert.equal(h.saved[0].profile, profile)
    assert.equal(h.saved[0].changes[prefix + 'TTS_VOICE_TYPE'], 'new-voice')
    assert.equal(h.saved[0].changes[prefix + 'TTS_API_KEY'], 'reused-api-key')
    assert.equal(h.saved[0].changes[prefix + 'LLM_PROVIDER'], 'qwen')
    assert.equal(h.saved[0].changes[prefix + 'LLM_FALLBACK_PROVIDER'], 'none')
    assert.equal(h.saved[0].changes[prefix + 'QWEN_MODEL'], 'qwen3.8-flash')
    assert.equal(h.saved[0].changes[prefix + 'QWEN_API_KEY'], 'synthetic-qwen-key')
    assert.equal(h.saved[0].changes[prefix + 'DEEPSEEK_PLATFORM'], 'ark')
    assert.equal(h.saved[0].changes[prefix + 'DEEPSEEK_ARK_MODEL'], 'ep-test')
    assert.equal(h.saved[0].changes[prefix + 'DEEPSEEK_ARK_API_KEY'], 'synthetic-ark-key')
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

test('key reuse rejects blank sources, other groups, official credentials, and locked settings', async t => {
  const h = fixture(t)
  await h.state.doUnlock()
  h.state.activeSection.value = 'transit'
  const target = 'TRANSIT_DEEPSEEK_ARK_API_KEY'
  h.state.sensitiveEnv.TRANSIT_DOUBAO_API_KEY = '   '
  for (const key of [target, 'DEEPSEEK_ARK_API_KEY', 'BARRAGE_DEEPSEEK_ARK_API_KEY', 'TRANSIT_DEEPSEEK_API_KEY']) {
    const before = h.state.sensitiveEnv[key]
    assert.equal(h.state.canReuseDoubaoKey(key), false)
    h.state.reuseDoubaoKey(key)
    assert.equal(h.state.sensitiveEnv[key], before)
  }
  h.state.lockSensitive()
  h.state.reuseDoubaoKey(target)
  assert.equal(h.state.sensitiveEnv[target], '')
  assert.equal(h.saved.length, 0)
})
