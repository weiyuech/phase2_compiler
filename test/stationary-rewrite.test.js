import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import { LLMRewriter } from '../src/llm/index.js'
import { buildStationaryPrompt, DEFAULT_STATIONARY_PROMPT, LEGACY_STATIONARY_PROMPT } from '../src/llm/stationary-prompt.js'
import { readStationaryPrompt, readStationaryOptions, readStationaryStylePrompt, writeStationaryPrompt, stationaryPromptPath } from '../src/llm/stationary-prompt-store.js'

function fixture(t, config = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'stationary-rewrite-'))
  const before = process.env.USER_DATA_DIR
  process.env.USER_DATA_DIR = directory
  t.after(() => {
    if (before === undefined) delete process.env.USER_DATA_DIR
    else process.env.USER_DATA_DIR = before
    rmSync(directory, { recursive: true, force: true })
  })
  t.mock.method(console, 'error', () => {})
  return { directory, llm: new LLMRewriter({ LLM_FALLBACK_PROVIDER: 'none', ...config }) }
}

test('short stationary rounds vary delivery and a previous question always leads into a statement', () => {
  const structure = (iteration, previousText = '') => {
    const { user } = buildStationaryPrompt('喜乐', { iteration, previousText })
    return JSON.parse(user.split('\n')[1]).structure_instruction
  }
  assert.match(DEFAULT_STATIONARY_PROMPT, /称呼听众时用“您”或“大家”/)
  assert.match(structure(1), /陈述句.*不提问/)
  assert.match(structure(2, '刚才说到喜乐。'), /陈述句.*不提问/)
  assert.match(structure(3, '刚才说到喜乐。'), /提一个简短的问题/)
  assert.match(structure(3, '您怎么理解呀？”'), /这次只说一句陈述句，不提问/)
})

test('stationary uses its own default, reloads custom settings per round and bounds prior phrasing', async t => {
  const { llm } = fixture(t)
  const requests = []
  llm.primary = { name: 'test', rewriteCustom: async (system, user) => {
    requests.push({ system, input: JSON.parse(user.slice(user.indexOf('\n') + 1)) })
    return '改写后的口播稿'
  } }
  assert.equal((await llm.rewriteStationary('原始资料')).text, '改写后的口播稿')
  assert.equal(requests[0].system, DEFAULT_STATIONARY_PROMPT)
  assert.equal(requests[0].input.original_text, '原始资料')
  assert.equal(requests[0].input.previous_version_excerpt, '')
  assert.equal(requests[0].input.style_instruction, null)
  assert.match(requests[0].input.structure_instruction, /用一句/)
  writeStationaryPrompt('自定义原地播报规则')
  await llm.rewriteStationary('原始资料', { iteration: 2, previousText: '旧'.repeat(4000) })
  assert.equal(requests[1].system, '自定义原地播报规则')
  assert.equal(requests[1].input.original_text, '原始资料')
  assert.equal(requests[1].input.round, 2)
  assert.equal(requests[1].input.previous_version_excerpt.length, 2000)
  writeStationaryPrompt(DEFAULT_STATIONARY_PROMPT)
  await llm.rewriteStationary('原始资料')
  assert.equal(requests[2].system, DEFAULT_STATIONARY_PROMPT)
})

test('prompt IPC persists independently per machine, defaults on missing files and rejects invalid saves', t => {
  const { directory } = fixture(t)
  const source = readFileSync(new URL('../robot-ui/src/main/machine-runtime.js', import.meta.url), 'utf8')
  const block = source.slice(source.indexOf("ipcMain.handle('read-stationary-prompt'"), source.indexOf("ipcMain.handle('write-barrage-prompt-name'"))
  const machines = [1, 2, 3].map(id => {
    const handlers = {}, path = join(directory, `machine-${id}`, 'config/stationary-prompt.txt')
    vm.runInNewContext(block, {
      ipcMain: { handle: (name, handler) => { handlers[name] = handler } },
      STATIONARY_PROMPT_PATH: path, readStationaryPrompt, readStationaryOptions, writeStationaryPrompt,
    })
    return { handlers, path }
  })
  for (const { handlers } of machines) assert.equal(handlers['read-stationary-prompt']().text, DEFAULT_STATIONARY_PROMPT)
  const first = machines[0]
  assert.equal(first.handlers['write-stationary-prompt'](null, '我的规则').ok, true)
  assert.equal(readFileSync(first.path, 'utf8'), '我的规则')
  assert.equal(first.handlers['read-stationary-prompt']().text, '我的规则')
  for (const invalid of ['', '  ', null, 5, '长'.repeat(32001)]) {
    assert.equal(first.handlers['write-stationary-prompt'](null, invalid).ok, false)
  }
  assert.equal(first.handlers['read-stationary-prompt']().text, '我的规则')
  for (const { handlers } of machines.slice(1)) assert.equal(handlers['read-stationary-prompt']().text, DEFAULT_STATIONARY_PROMPT)
  mkdirSync(stationaryPromptPath(), { recursive: true })
  assert.throws(() => readStationaryPrompt(), 'read errors must not silently discard custom settings')
})

test('primary timeout is cancelled before fallback; both failures never return original input', async t => {
  const { llm } = fixture(t, { LLM_TIMEOUT_MS: '10' })
  let cancelled = false
  llm.primary = { name: 'primary', rewriteCustom: (_system, _user, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { cancelled = true; reject(signal.reason) }, { once: true })
  }) }
  llm.fallback = { name: 'fallback', rewriteCustom: async () => {
    assert.equal(cancelled, true)
    return '备用改写稿'
  } }
  assert.equal((await llm.rewriteStationary('原文')).text, '备用改写稿')
  llm.fallback.rewriteCustom = async () => { throw new Error('provider failed') }
  await assert.rejects(llm.rewriteStationary('未经检查的原文'), /未播放原文/)
})

test('nullable style is used only with default prompt; older defaults migrate without overwriting custom text', async t => {
  const { llm } = fixture(t)
  const requests = []
  llm.primary = { name: 'test', rewriteCustom: async (system, user) => {
    requests.push({ system, input: JSON.parse(user.slice(user.indexOf('\n') + 1)) })
    return '改写稿'
  } }
  writeStationaryPrompt(LEGACY_STATIONARY_PROMPT, stationaryPromptPath(), '搞怪一点，激情一点')
  assert.equal(readStationaryPrompt(), DEFAULT_STATIONARY_PROMPT)
  await llm.rewriteStationary('原文')
  assert.equal(requests.at(-1).input.style_instruction, '搞怪一点，激情一点')
  assert.match(requests.at(-1).system, /7\. 可选风格/)
  assert.doesNotMatch(requests.at(-1).system, /搞怪|激情|幽默|活泼/)
  writeStationaryPrompt('自定义的独立规则')
  await llm.rewriteStationary('原文')
  assert.equal(requests.at(-1).system, '自定义的独立规则')
  assert.equal(Object.hasOwn(requests.at(-1).input, 'style_instruction'), false)
  assert.equal(readStationaryStylePrompt(), '搞怪一点，激情一点')
  writeStationaryPrompt(DEFAULT_STATIONARY_PROMPT, stationaryPromptPath(), '搞怪一点，激情一点', true)
  await llm.rewriteStationary('原文')
  assert.equal(readStationaryOptions().customEnabled, true)
  assert.equal(Object.hasOwn(requests.at(-1).input, 'style_instruction'), false, 'explicit custom mode disables the style even before editing the default text')
  writeStationaryPrompt(DEFAULT_STATIONARY_PROMPT, stationaryPromptPath(), '搞怪一点，激情一点', false)
  await llm.rewriteStationary('原文', { iteration: 2, previousText: '前一次的说法。' })
  assert.equal(requests.at(-1).input.style_instruction, '搞怪一点，激情一点')
  assert.match(requests.at(-1).input.structure_instruction, /上一版已经播过/)
  for (const style of [null, '', '  ']) {
    writeStationaryPrompt(DEFAULT_STATIONARY_PROMPT, stationaryPromptPath(), style)
    await llm.rewriteStationary('原文')
    assert.equal(requests.at(-1).input.style_instruction, null)
  }
  for (const invalid of [1, {}, '长'.repeat(1001)]) {
    assert.throws(() => writeStationaryPrompt('不要保存', stationaryPromptPath(), invalid), /风格要求/)
    assert.equal(readStationaryPrompt(), DEFAULT_STATIONARY_PROMPT)
  }
})

test('stop aborts active rewrite without trying fallback or producing speech', async t => {
  const { llm } = fixture(t)
  const controller = new AbortController()
  let aborted = false, fallback = false
  llm.primary = { name: 'primary', rewriteCustom: (_system, _user, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(signal.reason) }, { once: true })
  }) }
  llm.fallback = { name: 'fallback', rewriteCustom: async () => { fallback = true; return '不要播放' } }
  const pending = llm.rewriteStationary('原文', { signal: controller.signal })
  controller.abort(new Error('user stopped'))
  await assert.rejects(pending, /user stopped/)
  assert.equal(aborted, true)
  assert.equal(fallback, false)
})

test('empty, filtered, or no-speech results cannot fall back to unchecked source text', async t => {
  const { llm } = fixture(t)
  llm.filter.words = ['保证治愈']
  for (const text of ['', '保证治愈', '[[NO_SPEECH]]']) {
    llm.primary = { name: 'test', rewriteCustom: async () => text }
    await assert.rejects(llm.rewriteStationary('原文保证治愈'), /改写/)
  }
})

for (const provider of ['doubao', 'deepseek', 'qwen']) {
  test(`${provider} receives stationary input and dedicated prompt through its real HTTP client`, async t => {
    const { llm } = fixture(t, { LLM_PROVIDER: provider, DOUBAO_API_KEY: 'test', DOUBAO_MODEL: 'test',
      DEEPSEEK_API_KEY: 'test', QWEN_API_KEY: 'test' })
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      const { messages } = JSON.parse(options.body)
      assert.equal(messages[0].content, DEFAULT_STATIONARY_PROMPT)
      assert.match(messages[1].content, /本次输入/)
      assert.ok(options.signal)
      return { ok: true, json: async () => ({ choices: [{ message: { content: '口播版本' } }] }) }
    })
    assert.equal((await llm.rewriteStationary('本次输入')).text, '口播版本')
  })
}
