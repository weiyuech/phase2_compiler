import { buildPrompt } from '../prompt.js'

const API_URL = 'https://ark.cn-beijing.volces.com/api/v3/chat/completions'

export class DoubaoProvider {
  constructor(config = {}) {
    this.name   = 'doubao'
    this.apiKey = config.DOUBAO_API_KEY || process.env.DOUBAO_API_KEY
    this.model  = config.DOUBAO_MODEL   || process.env.DOUBAO_MODEL
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
        max_tokens:  500,
        temperature: 0.7
      })
    })

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`豆包接口错误 ${res.status}: ${err}`)
    }

    const data = await res.json()
    return data.choices[0].message.content.trim()
  }

  async rewriteCustom(system, user) {
    if (!this.apiKey || !this.model) {
      throw new Error('豆包未配置，请检查 DOUBAO_API_KEY 和 DOUBAO_MODEL')
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
      throw new Error(`豆包接口错误 ${res.status}: ${err}`)
    }

    const data = await res.json()
    return data.choices[0].message.content.trim()
  }

}
