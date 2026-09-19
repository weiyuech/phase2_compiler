import { buildPrompt } from '../prompt.js'

const API_URL = 'https://api.deepseek.com/chat/completions'

export class DeepseekProvider {
  constructor(config = {}) {
    this.name   = 'deepseek'
    this.apiKey = (config.DEEPSEEK_API_KEY ?? process.env.DEEPSEEK_API_KEY)
    this.model  = (config.DEEPSEEK_MODEL ?? process.env.DEEPSEEK_MODEL) || 'deepseek-chat'
    const configuredMax = Number.parseInt((config.LLM_MAX_TOKENS ?? process.env.LLM_MAX_TOKENS) || '4096', 10)
    this.maxTokens = Number.isFinite(configuredMax) && configuredMax > 0 ? configuredMax : 4096
  }

  async rewrite(body, goalObject) {
    if (!this.apiKey) {
      throw new Error('DeepSeek 未配置，请检查 DEEPSEEK_API_KEY')
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
      throw new Error(`DeepSeek 接口错误 ${res.status}: ${err}`)
    }

    const data = await res.json()
    return this._extractText(data)
  }

  async rewriteCustom(system, user, { signal } = {}) {
    if (!this.apiKey) {
      throw new Error('DeepSeek 未配置，请检查 DEEPSEEK_API_KEY')
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
      throw new Error(`DeepSeek 接口错误 ${res.status}: ${err}`)
    }

    const data = await res.json()
    return this._extractText(data)
  }

  _extractText(data) {
    const choice = data.choices?.[0]
    const text = choice?.message?.content?.trim()
    if (!text) throw new Error('DeepSeek 接口未返回有效文本')
    const outputTokens = data.usage?.completion_tokens ?? 'unknown'
    console.log(`[LLM:deepseek] finish=${choice.finish_reason || 'unknown'} outputTokens=${outputTokens} chars=${Array.from(text).length} maxTokens=${this.maxTokens}`)
    if (choice.finish_reason === 'length') {
      console.warn(`[LLM:deepseek] 输出达到 max_tokens=${this.maxTokens}，内容可能被截断`)
    }
    return text
  }
}
