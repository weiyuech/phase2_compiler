import test from 'node:test'
import assert from 'node:assert/strict'
import { DeepseekProvider } from '../src/llm/providers/deepseek.js'
import { createSpeechServices } from '../src/config/speech-services.js'
import { resolveSpeechProfile } from '../src/config/speech-profiles.js'
import { LLMRewriter } from '../src/llm/index.js'

const urls = { official: 'https://api.deepseek.com/chat/completions', ark: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions' }
const ok = () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '回复' }, finish_reason: 'stop' }] }) })

for (const platform of ['official', 'ark']) {
  test(`${platform}: all three speech clients send only the selected platform's model and key`, async t => {
    const env = { SPEECH_PROFILES_VERSION: '1' }, calls = []
    for (const prefix of ['', 'TRANSIT_', 'BARRAGE_']) {
      Object.assign(env, {
        [prefix + 'LLM_PROVIDER']: 'deepseek', [prefix + 'LLM_FALLBACK_PROVIDER']: 'none',
        [prefix + 'DEEPSEEK_PLATFORM']: platform,
        [prefix + 'DEEPSEEK_API_KEY']: prefix + 'official-key', [prefix + 'DEEPSEEK_MODEL']: prefix + 'official-model',
        [prefix + 'DEEPSEEK_ARK_API_KEY']: prefix + 'ark-key', [prefix + 'DEEPSEEK_ARK_MODEL']: prefix + 'ark-model',
      })
    }
    const services = createSpeechServices({ env })
    t.after(() => { for (const name of ['tts', 'transitTts', 'barrageTts']) services[name].destroy() })
    t.mock.method(console, 'log', () => {})
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      assert.equal(url, urls[platform])
      assert.equal(options.redirect, 'error')
      assert.ok(options.signal instanceof AbortSignal)
      calls.push({ auth: options.headers.Authorization, body: JSON.parse(options.body) })
      return ok()
    })
    assert.equal((await services.llm.rewrite({ body: '巡游原文' })).provider, 'deepseek')
    assert.equal((await services.transitLlm.rewrite({ body: '过渡原文' })).text, '回复')
    assert.equal(await services.barrageLlm.judgeOcr('judge', '弹幕'), '回复')
    assert.equal(await services.barrageLlm.rewriteBarrage('reply', '问题'), '回复')
    assert.deepEqual(calls.map(c => c.auth), ['', 'TRANSIT_', 'BARRAGE_', 'BARRAGE_'].map(p => `Bearer ${p}${platform}-key`))
    assert.deepEqual(calls.map(c => c.body.model), ['', 'TRANSIT_', 'BARRAGE_', 'BARRAGE_'].map(p => `${p}${platform}-model`))
  })

  test(`${platform}: HTTP failures redact credentials and custom/narration requests support cancellation`, async t => {
    const provider = new DeepseekProvider({ DEEPSEEK_PLATFORM: platform, DEEPSEEK_API_KEY: 'official-secret',
      DEEPSEEK_ARK_API_KEY: 'ark-secret', DEEPSEEK_ARK_MODEL: 'ep-test' })
    t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 401, text: async () => `invalid ${provider.apiKey}` }))
    await assert.rejects(provider.rewriteCustom('s', 'u'), e => e.message.includes('401') && !e.message.includes(provider.apiKey))
    t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ choices: [] }) }))
    await assert.rejects(provider.rewrite('x'), /未返回有效文本/)
    t.mock.method(globalThis, 'fetch', (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }))
    for (const request of [signal => provider.rewrite('原文', null, { signal }), signal => provider.rewriteCustom('s', 'u', { signal })]) {
      const controller = new AbortController()
      const pending = request(controller.signal)
      controller.abort(new Error('cancelled'))
      await assert.rejects(pending, /cancelled/)
    }
  })
}

test('missing platform preserves official configuration; Ark never borrows official or Doubao credentials/model', async t => {
  assert.equal(new DeepseekProvider({ DEEPSEEK_API_KEY: 'legacy' }).apiUrl, urls.official)
  assert.equal(new DeepseekProvider({ DEEPSEEK_API_KEY: 'legacy' }).model, 'deepseek-chat')
  assert.throws(() => new DeepseekProvider({ DEEPSEEK_PLATFORM: 'unknown' }), /平台无效/)
  t.mock.method(globalThis, 'fetch', () => { assert.fail('must not send an unconfigured request') })
  for (const config of [
    { DEEPSEEK_PLATFORM: 'ark', DEEPSEEK_API_KEY: 'wrong', DOUBAO_API_KEY: 'wrong', DEEPSEEK_ARK_API_KEY: '', DEEPSEEK_ARK_MODEL: 'ep-test' },
    { DEEPSEEK_PLATFORM: 'ark', DEEPSEEK_MODEL: 'wrong', DEEPSEEK_ARK_API_KEY: 'test', DEEPSEEK_ARK_MODEL: '' },
    { DEEPSEEK_PLATFORM: 'official', DEEPSEEK_API_KEY: '', DEEPSEEK_ARK_API_KEY: 'wrong', DEEPSEEK_ARK_MODEL: 'ep-test' },
  ]) await assert.rejects(new DeepseekProvider(config).rewriteCustom('s', 'u'), /未配置/)

  const before = process.env.DEEPSEEK_ARK_API_KEY
  process.env.DEEPSEEK_ARK_API_KEY = 'ambient-secret'
  t.after(() => { if (before === undefined) delete process.env.DEEPSEEK_ARK_API_KEY; else process.env.DEEPSEEK_ARK_API_KEY = before })
  for (const prefix of ['', 'TRANSIT_', 'BARRAGE_']) {
    const profile = prefix === '' ? 'cruise' : prefix === 'TRANSIT_' ? 'transit' : 'barrage'
    const config = resolveSpeechProfile({ SPEECH_PROFILES_VERSION: '1', [prefix + 'DEEPSEEK_PLATFORM']: 'ark' }, profile)
    await assert.rejects(new DeepseekProvider(config).rewriteCustom('s', 'u'), /未配置/)
  }
})

test('DeepSeek via Ark can be the configured fallback', async t => {
  const calls = []
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', () => {})
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push(url)
    if (url === urls.ark) {
      assert.equal(options.headers.Authorization, 'Bearer ark-key')
      return ok()
    }
    return { ok: false, status: 429, text: async () => 'limited' }
  })
  const llm = new LLMRewriter({ LLM_PROVIDER: 'qwen', LLM_FALLBACK_PROVIDER: 'deepseek', QWEN_API_KEY: 'test',
    DEEPSEEK_PLATFORM: 'ark', DEEPSEEK_ARK_API_KEY: 'ark-key', DEEPSEEK_ARK_MODEL: 'ep-test' })
  assert.equal(await llm.judgeOcr('s', 'u'), '回复')
  assert.equal(calls.length, 2)
  assert.equal(calls[1], urls.ark)
})
