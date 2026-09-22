import { buildPrompt } from '../prompt.js'

const API_URLS = Object.freeze({
  official: 'https://api.deepseek.com/chat/completions',
  ark: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
})

export class DeepseekProvider {
  constructor(config = {}) {
    this.name   = 'deepseek'
    this.platform = (config.DEEPSEEK_PLATFORM ?? process.env.DEEPSEEK_PLATFORM) || 'official'
    if (!Object.hasOwn(API_URLS, this.platform)) throw new Error('DeepSeek 平台无效，请选择 official 或 ark')
    this.apiUrl = API_URLS[this.platform]
    const prefix = this.platform === 'ark' ? 'DEEPSEEK_ARK' : 'DEEPSEEK'
    this.apiKey = config[`${prefix}_API_KEY`] ?? process.env[`${prefix}_API_KEY`]
    this.model = (config[`${prefix}_MODEL`] ?? process.env[`${prefix}_MODEL`]) || (this.platform === 'official' ? 'deepseek-chat' : '')
    this.label = this.platform === 'ark' ? 'DeepSeek（火山方舟）' : 'DeepSeek（官方）'
    const configuredMax = Number.parseInt((config.LLM_MAX_TOKENS ?? process.env.LLM_MAX_TOKENS) || '4096', 10)
    this.maxTokens = Number.isFinite(configuredMax) && configuredMax > 0 ? configuredMax : 4096
  }

  async rewrite(body, goalObject, { signal } = {}) {
    const { system, user } = buildPrompt(body, goalObject)
    return this.rewriteCustom(system, user, { signal })
  }

  async rewriteCustom(system, user, { signal } = {}) {
    if (!this.apiKey || !this.model) {
      const fields = this.platform === 'ark' ? 'DEEPSEEK_ARK_API_KEY 和 DEEPSEEK_ARK_MODEL' : 'DEEPSEEK_API_KEY'
      throw new Error(`${this.label} 未配置，请检查 ${fields}`)
    }

    const res = await fetch(this.apiUrl, {
      signal,
      redirect: 'error',
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model:    this.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user',   content: user   }
        ],
        max_tokens:  this.maxTokens,
        temperature: 0.7
      })
    })

    if (!res.ok) {
      const err = (await res.text()).split(this.apiKey).join('[REDACTED]').slice(0, 2000)
      throw new Error(`${this.label} 接口错误 ${res.status}: ${err}`)
    }

    const data = await res.json()
    return this._extractText(data)
  }

  _extractText(data) {
    const choice = data.choices?.[0]
    const text = choice?.message?.content?.trim()
    if (!text) throw new Error(`${this.label} 接口未返回有效文本`)
    const outputTokens = data.usage?.completion_tokens ?? 'unknown'
    console.log(`[LLM:deepseek:${this.platform}] finish=${choice.finish_reason || 'unknown'} outputTokens=${outputTokens} chars=${Array.from(text).length} maxTokens=${this.maxTokens}`)
    if (choice.finish_reason === 'length') {
      console.warn(`[LLM:deepseek] 输出达到 max_tokens=${this.maxTokens}，内容可能被截断`)
    }
    return text
  }
}
