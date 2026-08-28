import { DoubaoProvider }  from './providers/doubao.js'
import { DeepseekProvider } from './providers/deepseek.js'
import { BannedWordFilter } from './banned-word-filter.js'

export class LLMRewriter {
  constructor(config = {}) {
    this.primary   = new DoubaoProvider(config)
    this.fallback  = new DeepseekProvider(config)
    this.filter    = new BannedWordFilter(
      config.BANNED_WORDS_FILE || process.env.BANNED_WORDS_FILE || './config/banned-words.txt'
    )
    this.timeoutMs = parseInt(config.LLM_TIMEOUT_MS || process.env.LLM_TIMEOUT_MS || '8000')
  }

  async init() {
    await this.filter.load()
  }

  async rewrite(content) {
    const { body, banned_local = [], goal_object = null } = content

    let result = await this._tryProvider(this.primary, body, goal_object)

    if (!result) {
      result = await this._tryProvider(this.fallback, body, goal_object)
    }

    if (!result) {
      return { text: body, source: 'fallback', provider: 'none' }
    }

    const allBanned = [...this.filter.words, ...banned_local]
    const cleaned   = this.filter.clean(result.text, body, allBanned)

    return { text: cleaned.text, source: 'llm', provider: result.provider }
  }

  async _tryProvider(provider, body, goalObject) {
    try {
      const text = await Promise.race([
        provider.rewrite(body, goalObject),
        this._timeout()
      ])
      return { text, provider: provider.name }
    } catch (err) {
      console.error(`[LLM] Rewrite with ${provider.name} failed:`, err.message)
      return null
    }
  }

  async rewriteBarrage(system, user) {
    let result = await this._tryProviderCustom(this.primary, system, user)

    if (!result) {
      result = await this._tryProviderCustom(this.fallback, system, user)
    }

    if (!result) {
      return null
    }

    const cleaned = this.filter.clean(result.text, '')
    return cleaned.text
  }

  async _tryProviderCustom(provider, system, user) {
    try {
      const text = await Promise.race([
        provider.rewriteCustom(system, user),
        this._timeout()
      ])
      return { text, provider: provider.name }
    } catch (err) {
      console.error(`[LLM] Custom rewrite with ${provider.name} failed:`, err.message)
      return null
    }
  }

  _timeout() {
    return new Promise((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), this.timeoutMs)
    )
  }
}
