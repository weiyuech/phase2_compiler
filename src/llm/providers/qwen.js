import { buildPrompt } from '../prompt.js'

// Qianwen's documented OpenAI-compatible endpoint. Keys never go to a
// user-controlled URL, and this provider never falls back to another profile.
export const QWEN_API_URL = 'https://maas.qianwenaiapi.com/compatible-mode/v1/chat/completions'

export class QwenProvider {
  constructor(config = {}) {
    this.name = 'qwen'
    this.apiKey = config.QWEN_API_KEY ?? process.env.QWEN_API_KEY
    this.model = (config.QWEN_MODEL ?? process.env.QWEN_MODEL) || 'qwen3.8-flash'
    const max = Number.parseInt((config.LLM_MAX_TOKENS ?? process.env.LLM_MAX_TOKENS) || '4096', 10)
    this.maxTokens = Number.isFinite(max) && max > 0 ? max : 4096
  }

  async rewrite(body, goalObject, options = {}) {
    const { system, user } = buildPrompt(body, goalObject)
    return this.rewriteCustom(system, user, options)
  }

  async rewriteCustom(system, user, { signal } = {}) {
    if (!this.apiKey) throw new Error('千问未配置，请在当前组填写完整的千问 API Key')
    const res = await fetch(QWEN_API_URL, {
      method: 'POST', signal, redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        max_tokens: this.maxTokens, temperature: 0.7,
        // Live narration needs the answer, not a hidden reasoning budget.
        enable_thinking: false, stream: false,
      }),
    })
    if (!res.ok) {
      const detail = (await res.text()).replaceAll(this.apiKey, '[redacted]').slice(0, 2000)
      throw new Error(`千问接口错误 ${res.status}: ${detail}`)
    }
    const data = await res.json()
    const choice = data.choices?.[0]
    const text = choice?.message?.content?.trim()
    if (!text) throw new Error('千问接口未返回有效文本')
    console.log(`[LLM:qwen] finish=${choice.finish_reason || 'unknown'} outputTokens=${data.usage?.completion_tokens ?? 'unknown'} chars=${Array.from(text).length} maxTokens=${this.maxTokens}`)
    if (choice.finish_reason === 'length') console.warn(`[LLM:qwen] 输出达到 max_tokens=${this.maxTokens}，内容可能被截断`)
    return text
  }
}
