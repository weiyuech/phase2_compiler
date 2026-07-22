import { buildPrompt } from '../prompt.js'

const API_URL = 'https://api.deepseek.com/chat/completions'

export class DeepseekProvider {
  constructor(config = {}) {
    this.name   = 'deepseek'
    this.apiKey = config.DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY
    this.model  = config.DEEPSEEK_MODEL   || process.env.DEEPSEEK_MODEL || 'deepseek-chat'
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
        max_tokens:  500,
        temperature: 0.7
      })
    })

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`DeepSeek 接口错误 ${res.status}: ${err}`)
    }

    const data = await res.json()
    return data.choices[0].message.content.trim()
  }

  async rewriteCustom(system, user) {
    if (!this.apiKey) {
      throw new Error('DeepSeek 未配置，请检查 DEEPSEEK_API_KEY')
    }

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
        max_tokens:  500,
        temperature: 0.7
      })
    })

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`DeepSeek 接口错误 ${res.status}: ${err}`)
    }

    const data = await res.json()
    return data.choices[0].message.content.trim()
  }

}
