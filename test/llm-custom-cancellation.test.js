import test from 'node:test'
import assert from 'node:assert/strict'
import { LLMRewriter } from '../src/llm/index.js'
import { DoubaoProvider } from '../src/llm/providers/doubao.js'
import { DeepseekProvider } from '../src/llm/providers/deepseek.js'

test('barrage judge timeout aborts primary before invoking fallback', async t => {
  const llm = new LLMRewriter({ LLM_TIMEOUT_MS: '20' })
  let active = false, cancelled = false
  t.mock.method(console, 'error', () => {})
  llm.primary = { name: 'test-primary', rewriteCustom: (_system, _user, { signal }) => new Promise((resolve, reject) => {
    active = true
    signal.addEventListener('abort', () => {
      active = false
      cancelled = true
      reject(signal.reason)
    }, { once: true })
  }) }
  llm.fallback = { name: 'test-fallback', rewriteCustom: async () => {
    assert.equal(active, false, 'fallback must not overlap the timed-out client request')
    assert.equal(cancelled, true)
    return '无新问题'
  } }
  assert.equal(await llm.judgeOcr('system', 'user'), '无新问题')
})

test('successful custom requests clear their timer and preserve the exact judge output', async t => {
  const llm = new LLMRewriter()
  let callback, cleared = false
  const token = {}
  t.mock.method(globalThis, 'setTimeout', fn => { callback = fn; return token })
  t.mock.method(globalThis, 'clearTimeout', timer => { assert.equal(timer, token); cleared = true })
  llm.primary = { name: 'test', rewriteCustom: async (_system, _user, { signal }) => {
    assert.equal(signal.aborted, false)
    return '无新问题。'
  } }
  assert.equal(await llm.judgeOcr('system', 'user'), '无新问题。')
  assert.equal(typeof callback, 'function')
  assert.equal(cleared, true)
})

for (const Provider of [DoubaoProvider, DeepseekProvider]) {
  test(Provider.name + ' custom request carries cancellation through fetch', async t => {
    const controller = new AbortController()
    const provider = new Provider({ DOUBAO_API_KEY: 'synthetic-key', DOUBAO_MODEL: 'synthetic-model',
      DEEPSEEK_API_KEY: 'synthetic-key' })
    let calls = 0
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      calls++
      assert.equal(options.signal, controller.signal)
      const body = JSON.parse(options.body)
      assert.deepEqual(body.messages, [{ role: 'system', content: 'system' }, { role: 'user', content: 'user' }])
      return { ok: true, json: () => new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
      }) }
    })
    const request = provider.rewriteCustom('system', 'user', { signal: controller.signal })
    // Let fetch resolve so cancellation occurs while reading the response body.
    await new Promise(resolve => setImmediate(resolve))
    controller.abort(new Error('test cancellation'))
    await assert.rejects(request, /test cancellation/)
    assert.equal(calls, 1)
  })
}
