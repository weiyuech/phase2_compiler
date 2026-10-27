import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { DEFAULT_STATIONARY_PROMPT } from '../../src/llm/stationary-prompt.js'
import { DEFAULT_OCR_JUDGE_PROMPT } from '../../src/phase2/ocr/judge-prompt.js'

const require = createRequire(import.meta.url)
const { parse, compileScript, compileTemplate } = require('@vue/compiler-sfc')
const Vue = require('vue')
const source = readFileSync(new URL('../src/renderer/src/components/SystemSettings.vue', import.meta.url), 'utf8')
const { descriptor, errors } = parse(source)
assert.deepEqual(errors, [])
const script = compileScript(descriptor, { id: 'ocr-judge-prompt' }).content
assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename: 'SystemSettings.vue', id: 'ocr-judge-prompt' }).errors, [])
const createComponent = new Function('Vue', 'ElMessageBox', 'ElMessage', 'window', 'setTimeout', 'DEFAULT_OCR_JUDGE_PROMPT', 'DEFAULT_STATIONARY_PROMPT', script
  .replace(/import \{ ref, reactive, onMounted, onBeforeUnmount, watch \} from 'vue'/, 'const { ref, reactive, onMounted, onBeforeUnmount, watch } = Vue')
  .replace(/import \{ ElMessageBox, ElMessage \}\s+from 'element-plus'/, '')
  .replace(/import AudioDiagnostics from '.\/AudioDiagnostics.vue'/, 'const AudioDiagnostics = {}')
  .replace(/import \{ DEFAULT_OCR_JUDGE_PROMPT \} from '[^']+'/u, '')
  .replace(/import \{ DEFAULT_STATIONARY_PROMPT \} from '[^']+'/u, '')
  .replace('export default', 'return'))

function fixture(t, overrides = {}) {
  const errors = [], writes = [], cleanups = []
  const api = {
    readStationaryPrompt: async () => ({ ok: true, text: DEFAULT_STATIONARY_PROMPT }),
    readBarragePromptJudge: async () => ({ ok: true, text: DEFAULT_OCR_JUDGE_PROMPT }),
    readLlmPrompt: async () => ({ ok: true, text: '' }),
    readBarragePromptName: async () => ({ ok: true, text: '' }),
    readBarragePromptGeneral: async () => ({ ok: true, text: '' }),
    ...Object.fromEntries(['BarragePromptJudge', 'LlmPrompt', 'BarragePromptName', 'BarragePromptGeneral', 'StationaryPrompt']
      .map(name => ['write' + name, async (text, stylePrompt, customEnabled) => { writes.push({ name, text, stylePrompt, customEnabled }); return { ok: true } }])),
    ...overrides,
  }
  const component = createComponent({ ...Vue, onMounted() {}, onBeforeUnmount: fn => cleanups.push(fn) }, {},
    { error: message => errors.push(message) }, { api }, () => 1, DEFAULT_OCR_JUDGE_PROMPT, DEFAULT_STATIONARY_PROMPT)
  const scope = Vue.effectScope()
  const state = scope.run(() => component.setup({ wsRef: null }, { expose() {} }))
  t.after(() => { for (const cleanup of cleanups) cleanup(); scope.stop() })
  return { state, writes, errors }
}

test('single TTS judge retains default/custom editing without a recovery prompt or extra API', async t => {
  const h = fixture(t)
  await h.state.loadPrompt()
  assert.equal(h.state.customJudgeEnabled.value, false)
  h.state.customJudgeEnabled.value = true
  h.state.handleJudgeSwitch(true)
  h.state.judgePromptText.value = 'My <previous_ocr> / <current_ocr> rules'
  await Vue.nextTick()
  h.state.customJudgeEnabled.value = false
  h.state.handleJudgeSwitch(false)
  await Vue.nextTick()
  assert.equal(h.state.judgePromptText.value, DEFAULT_OCR_JUDGE_PROMPT)
  h.state.customJudgeEnabled.value = true
  h.state.handleJudgeSwitch(true)
  await h.state.savePrompt()
  assert.equal(h.writes[0].text, 'My <previous_ocr> / <current_ocr> rules')
  assert.deepEqual(h.writes.map(item => item.name), ['BarragePromptJudge', 'LlmPrompt', 'BarragePromptName', 'BarragePromptGeneral', 'StationaryPrompt'])
  assert.deepEqual(h.errors, [])
  assert.match(descriptor.template.content, /仅用于 TTS/)
  assert.doesNotMatch(source, /Recovery|待播问题检查/)
})

test('saved custom judge loads unchanged and default save keeps the in-session custom draft', async t => {
  const h = fixture(t, { readBarragePromptJudge: async () => ({ ok: true, text: 'My custom rules' }) })
  await h.state.loadPrompt()
  assert.equal(h.state.customJudgeEnabled.value, true)
  h.state.customJudgeEnabled.value = false
  h.state.handleJudgeSwitch(false)
  await h.state.savePrompt()
  assert.equal(h.writes[0].text, DEFAULT_OCR_JUDGE_PROMPT)
  assert.equal(h.state.customJudgeText.value, 'My custom rules')
})

test('failed prompt load cannot overwrite an unseen custom prompt with defaults', async t => {
  const h = fixture(t, { readBarragePromptJudge: async () => ({ ok: false, error: 'Access denied' }) })
  await h.state.loadPrompt()
  await h.state.savePrompt()
  assert.equal(h.state.promptLoaded.value, false)
  assert.deepEqual(h.writes, [])
  assert.equal(h.errors[0], 'Access denied')
})

test('failed judge save cannot report successful save-all', async t => {
  const h = fixture(t, { writeBarragePromptJudge: async () => ({ ok: false, error: 'Disk full' }) })
  await h.state.loadPrompt()
  await h.state.savePrompt()
  assert.equal(h.state.promptSavedOk.value, false)
  assert.deepEqual(h.errors, ['Disk full'])
  assert.deepEqual(h.writes, [])
})

test('stationary prompt loads its default, preserves custom draft on toggle and saves selected text', async t => {
  const h = fixture(t)
  await h.state.loadPrompt()
  assert.equal(h.state.customStationaryEnabled.value, false)
  assert.equal(h.state.stationaryPromptText.value, DEFAULT_STATIONARY_PROMPT)
  h.state.customStationaryEnabled.value = true
  h.state.handleStationarySwitch(true)
  h.state.stationaryPromptText.value = '只改写原地输入，事实不变，变换开场。'
  await Vue.nextTick()
  h.state.customStationaryEnabled.value = false
  h.state.handleStationarySwitch(false)
  await Vue.nextTick()
  await h.state.savePrompt()
  assert.equal(h.writes.at(-1).text, DEFAULT_STATIONARY_PROMPT)
  h.state.customStationaryEnabled.value = true
  h.state.handleStationarySwitch(true)
  await h.state.savePrompt()
  assert.equal(h.writes.at(-1).name, 'StationaryPrompt')
  assert.equal(h.writes.at(-1).text, '只改写原地输入，事实不变，变换开场。')
  assert.deepEqual(h.errors, [])
})

test('saved stationary custom prompt loads and empty drafts cannot be saved', async t => {
  const h = fixture(t, { readStationaryPrompt: async () => ({ ok: true, text: '我的原地规则' }) })
  await h.state.loadPrompt()
  assert.equal(h.state.customStationaryEnabled.value, true)
  assert.equal(h.state.stationaryPromptText.value, '我的原地规则')
  h.state.stationaryPromptText.value = '  '
  await h.state.savePrompt()
  assert.deepEqual(h.writes, [])
  assert.match(h.errors[0], /不能为空/)
})

test('optional style loads, survives mode switches and saves null when blank', async t => {
  const h = fixture(t, { readStationaryPrompt: async () => ({ ok: true, text: DEFAULT_STATIONARY_PROMPT, stylePrompt: '搞怪一点，激情一点' }) })
  await h.state.loadPrompt()
  assert.equal(h.state.stationaryStylePrompt.value, '搞怪一点，激情一点')
  h.state.customStationaryEnabled.value = true
  h.state.handleStationarySwitch(true)
  h.state.stationaryPromptText.value = '我的自定义规则'
  await Vue.nextTick()
  await h.state.savePrompt()
  assert.equal(h.writes.at(-1).stylePrompt, '搞怪一点，激情一点')
  assert.equal(h.writes.at(-1).customEnabled, true)
  h.state.customStationaryEnabled.value = false
  h.state.handleStationarySwitch(false)
  assert.equal(h.state.stationaryStylePrompt.value, '搞怪一点，激情一点')
  h.state.stationaryStylePrompt.value = '  '
  await h.state.savePrompt()
  assert.equal(h.writes.at(-1).stylePrompt, null)
  assert.equal(h.writes.at(-1).customEnabled, false)
  assert.match(descriptor.template.content, /aria-label="原地播报补充风格要求" :disabled="customStationaryEnabled"/)
})

test('explicit custom mode survives reload even if its text still matches the default', async t => {
  const h = fixture(t, { readStationaryPrompt: async () => ({ ok: true, text: DEFAULT_STATIONARY_PROMPT, stylePrompt: '激情一点', customEnabled: true }) })
  await h.state.loadPrompt()
  assert.equal(h.state.customStationaryEnabled.value, true)
  await h.state.savePrompt()
  assert.equal(h.writes.at(-1).customEnabled, true)
})

test('stationary load/save failures cannot report success or overwrite unseen settings', async t => {
  const loading = fixture(t, { readStationaryPrompt: async () => ({ ok: false, error: 'Access denied' }) })
  await loading.state.loadPrompt()
  await loading.state.savePrompt()
  assert.equal(loading.state.promptLoaded.value, false)
  assert.deepEqual(loading.writes, [])
  const saving = fixture(t, { writeStationaryPrompt: async () => ({ ok: false, error: 'Disk full' }) })
  await saving.state.loadPrompt()
  await saving.state.savePrompt()
  assert.equal(saving.state.promptSavedOk.value, false)
  assert.deepEqual(saving.errors, ['Disk full'])
})

test('preload and main contain no recovery prompt handler', () => {
  for (const name of ['main', 'preload']) {
    const code = readFileSync(new URL('../src/' + name + '/index.js', import.meta.url), 'utf8')
    assert.doesNotMatch(code, /barrage-prompt-recovery|BarragePromptRecovery/)
  }
})
