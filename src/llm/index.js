import { DoubaoProvider }  from './providers/doubao.js'
import { DeepseekProvider } from './providers/deepseek.js'
import { QwenProvider } from './providers/qwen.js'
import { BannedWordFilter } from './banned-word-filter.js'

export class LLMRewriter {
  constructor(config = {}) {
    const providers = { doubao: DoubaoProvider, deepseek: DeepseekProvider, qwen: QwenProvider }
    const primary = (config.LLM_PROVIDER ?? process.env.LLM_PROVIDER) || 'doubao'
    const fallback = (config.LLM_FALLBACK_PROVIDER ?? process.env.LLM_FALLBACK_PROVIDER) || 'deepseek'
    if (!Object.hasOwn(providers, primary)) throw new Error('LLM 主服务商无效，请选择 doubao、deepseek 或 qwen')
    if (fallback !== 'none' && !Object.hasOwn(providers, fallback)) throw new Error('LLM 备用服务商无效，请选择 none、doubao、deepseek 或 qwen')
    this.primary = new providers[primary](config)
    this.fallback = fallback === 'none' || fallback === primary ? null : new providers[fallback](config)
    this.filter    = new BannedWordFilter(
      (config.BANNED_WORDS_FILE ?? process.env.BANNED_WORDS_FILE) || './config/banned-words.txt'
    )
    this.timeoutMs = parseInt((config.LLM_TIMEOUT_MS ?? process.env.LLM_TIMEOUT_MS) || '8000')
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
    if (!provider) return null
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('timeout')), this.timeoutMs)
    try {
      const text = await provider.rewrite(body, goalObject, { signal: controller.signal })
      return { text, provider: provider.name }
    } catch (err) {
      console.error(`[LLM] Rewrite with ${provider.name} failed:`, err.message)
      return null
    } finally { clearTimeout(timer) }
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

  async judgeOcr(system, user) {
    const result = await this._tryProviderCustom(this.primary, system, user)
      || await this._tryProviderCustom(this.fallback, system, user)
    // Preserve the judge's exact control signal; speech word filtering belongs
    // to the later reply stage, not the comparison result.
    return result?.text ?? null
  }

  async _tryProviderCustom(provider, system, user) {
    if (!provider) return null
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('timeout')), this.timeoutMs)
    try {
      // Both custom providers propagate this signal through fetch/body reads.
      // Await cancellation before fallback/retry; Promise.race alone left the
      // previous HTTP request alive after the decision clock became available.
      const text = await provider.rewriteCustom(system, user, { signal: controller.signal })
      return { text, provider: provider.name }
    } catch (err) {
      console.error(`[LLM] Custom rewrite with ${provider.name} failed:`, err.message)
      return null
    } finally { clearTimeout(timer) }
  }

}
