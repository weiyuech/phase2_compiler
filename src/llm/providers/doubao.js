import { buildPrompt } from '../prompt.js'

const API_URL = 'https://ark.cn-beijing.volces.com/api/v3/chat/completions'

export class DoubaoProvider {
  constructor(config = {}) {
    this.name   = 'doubao'
    this.apiKey = config.DOUBAO_API_KEY || process.env.DOUBAO_API_KEY
    this.model  = config.DOUBAO_MODEL   || process.env.DOUBAO_MODEL
    const configuredMax = Number.parseInt(config.LLM_MAX_TOKENS || process.env.LLM_MAX_TOKENS || '4096', 10)
    this.maxTokens = Number.isFinite(configuredMax) && configuredMax > 0 ? configuredMax : 4096
  }

  async rewrite(body, goalObject) {
    if (!this.apiKey || !this.model) {
      throw new Error('豆包未配置，请检查 DOUBAO_API_KEY 和 DOUBAO_MODEL')
    }

    const { system, user } = buildPrompt(body, goalObject)

    const res = await fetch(API_URL, {
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
      const err = await res.text()
      throw new Error(`豆包接口错误 ${res.status}: ${err}`)
    }

    const data = await res.json()
    return this._extractText(data)
  }

  async rewriteCustom(system, user, { signal } = {}) {
    if (!this.apiKey || !this.model) {
      throw new Error('豆包未配置，请检查 DOUBAO_API_KEY 和 DOUBAO_MODEL')
    }

    const res = await fetch(API_URL, {
      signal,
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
      const err = await res.text()
      throw new Error(`豆包接口错误 ${res.status}: ${err}`)
    }

    const data = await res.json()
    return this._extractText(data)
  }

  _extractText(data) {
    const choice = data.choices?.[0]
    const text = choice?.message?.content?.trim()
    if (!text) throw new Error('豆包接口未返回有效文本')
    const outputTokens = data.usage?.completion_tokens ?? 'unknown'
    console.log(`[LLM:doubao] finish=${choice.finish_reason || 'unknown'} outputTokens=${outputTokens} chars=${Array.from(text).length} maxTokens=${this.maxTokens}`)
    if (choice.finish_reason === 'length') {
      console.warn(`[LLM:doubao] 输出达到 max_tokens=${this.maxTokens}，内容可能被截断`)
    }
    return text
  }
}
