import test from 'node:test'
import assert from 'node:assert/strict'
import { QwenProvider, QWEN_API_URL } from '../src/llm/providers/qwen.js'
import { LLMRewriter } from '../src/llm/index.js'
import { createSpeechServices } from '../src/config/speech-services.js'

const ok = text => ({ ok: true, json: async () => ({ choices: [{ message: { content: text }, finish_reason: 'stop' }] }) })

test('all three real clients route narration, OCR judgment and replies to their own Qwen model/key', async t => {
  const env = { SPEECH_PROFILES_VERSION: '1' }, calls = []
  for (const prefix of ['', 'TRANSIT_', 'BARRAGE_']) {
    Object.assign(env, { [prefix + 'LLM_PROVIDER']: 'qwen', [prefix + 'LLM_FALLBACK_PROVIDER']: 'none',
      [prefix + 'QWEN_API_KEY']: prefix + 'test-key', [prefix + 'QWEN_MODEL']: prefix + 'test-model' })
  }
  const services = createSpeechServices({ env })
  t.after(() => { for (const name of ['tts', 'transitTts', 'barrageTts']) services[name].destroy() })
  t.mock.method(console, 'log', () => {})
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, QWEN_API_URL)
    assert.equal(options.redirect, 'error')
    assert.ok(options.signal instanceof AbortSignal)
    const body = JSON.parse(options.body)
    assert.equal(body.enable_thinking, false)
    assert.equal(body.stream, false)
    calls.push({ key: options.headers.Authorization, body })
    return ok(body.messages[0].content === 'judge' ? '无新问题' : '生成的回复')
  })
  assert.equal((await services.llm.rewrite({ body: '点位原文' })).provider, 'qwen')
  assert.equal((await services.transitLlm.rewrite({ body: '过渡原文' })).text, '生成的回复')
  assert.equal(await services.barrageLlm.judgeOcr('judge', '弹幕'), '无新问题')
  assert.equal(await services.barrageLlm.rewriteBarrage('reply', '问题'), '生成的回复')
  assert.deepEqual(calls.map(c => c.key), ['Bearer test-key', 'Bearer TRANSIT_test-key', 'Bearer BARRAGE_test-key', 'Bearer BARRAGE_test-key'])
  assert.deepEqual(calls.map(c => c.body.model), ['test-model', 'TRANSIT_test-model', 'BARRAGE_test-model', 'BARRAGE_test-model'])
})

test('provider selection supports Qwen as fallback, none, and avoids duplicate provider requests', async t => {
  t.mock.method(console, 'error', () => {})
  t.mock.method(console, 'log', () => {})
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(url)
    return url === QWEN_API_URL ? ok('备用回复') : { ok: false, status: 429, text: async () => 'rate limited' }
  })
  const config = { LLM_PROVIDER: 'doubao', LLM_FALLBACK_PROVIDER: 'qwen', DOUBAO_API_KEY: 'test', DOUBAO_MODEL: 'test', QWEN_API_KEY: 'test' }
  assert.equal(await new LLMRewriter(config).rewriteBarrage('system', 'user'), '备用回复')
  assert.equal(calls.length, 2)
  assert.equal(new LLMRewriter({ LLM_PROVIDER: 'deepseek', LLM_FALLBACK_PROVIDER: 'none' }).primary.name, 'deepseek')
  for (const fallback of ['none', 'qwen']) {
    calls.length = 0
    t.mock.method(globalThis, 'fetch', async url => { calls.push(url); return { ok: false, status: 429, text: async () => 'limited' } })
    const llm = new LLMRewriter({ LLM_PROVIDER: 'qwen', LLM_FALLBACK_PROVIDER: fallback, QWEN_API_KEY: 'test' })
    assert.deepEqual(await llm.rewrite({ body: '原文' }), { text: '原文', source: 'fallback', provider: 'none' })
    assert.equal(calls.length, 1)
    assert.equal(await llm.judgeOcr('system', 'user'), null)
    assert.equal(await llm.rewriteBarrage('system', 'user'), null)
    assert.equal(calls.length, 3)
  }
  assert.throws(() => new LLMRewriter({ LLM_PROVIDER: 'invalid' }), /主服务商无效/)
})

test('Qwen validates text, preserves status errors without leaking keys, and honors explicit blank credentials', async t => {
  const provider = new QwenProvider({ QWEN_API_KEY: 'synthetic-secret', QWEN_MODEL: '', LLM_MAX_TOKENS: '500' })
  assert.equal(provider.model, 'qwen3.8-flash')
  assert.equal(provider.maxTokens, 500)
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 401, text: async () => 'invalid synthetic-secret' }))
  await assert.rejects(provider.rewriteCustom('s', 'u'), e => e.message.includes('401') && !e.message.includes('synthetic-secret'))
  t.mock.method(globalThis, 'fetch', async () => ok('   '))
  await assert.rejects(provider.rewriteCustom('s', 'u'), /未返回有效文本/)
  t.mock.method(globalThis, 'fetch', async () => { throw Error('must not send') })
  await assert.rejects(new QwenProvider({ QWEN_API_KEY: '' }).rewriteCustom('s', 'u'), /千问未配置/)
})

test('narration timeout aborts Qwen before starting the configured fallback', async t => {
  let active = false
  const llm = new LLMRewriter({ LLM_PROVIDER: 'qwen', LLM_FALLBACK_PROVIDER: 'deepseek', QWEN_API_KEY: 'test', LLM_TIMEOUT_MS: '15' })
  t.mock.method(console, 'error', () => {})
  t.mock.method(globalThis, 'fetch', (_url, { signal }) => new Promise((_resolve, reject) => {
    active = true
    signal.addEventListener('abort', () => { active = false; reject(signal.reason) }, { once: true })
  }))
  llm.fallback.rewrite = async () => { assert.equal(active, false); return '备用文本' }
  assert.equal((await llm.rewrite({ body: '原文' })).text, '备用文本')
})
