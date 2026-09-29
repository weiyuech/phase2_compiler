import { setTimeout as delay } from 'node:timers/promises'

/** Rewrite the original input for each round; never persist a queue or move the robot. */
export class StationarySpeech {
  constructor({ tts, llm, onState = () => {}, loopGapMs = 250 }) {
    this.tts = tts
    this.llm = llm
    this.onState = onState
    this.loopGapMs = loopGapMs
    this.run = null
    this.state = { state: 'idle', active: false, loop: false, iteration: 0, message: '', originalText: '', rewrittenText: '', rewrittenIteration: 0 }
    this.finished = Promise.resolve()
  }

  snapshot() { return { ...this.state } }
  get active() { return this.run !== null }

  start({ text, loop = false } = {}) {
    if (this.active) throw new Error('原地播报正在进行，请先停止')
    if (typeof text !== 'string' || !text.trim()) throw new Error('请输入原地播报文本')
    if (typeof loop !== 'boolean') throw new Error('循环选项必须为开或关')
    const run = { controller: new AbortController(), text: text.trim(), previousText: '', rewrittenText: '', rewrittenIteration: 0, loop, iteration: 0 }
    this.run = run
    this.finished = this._play(run)
    return this.snapshot()
  }

  stop(message = '原地播报已停止') {
    const run = this.run
    if (!run || run.controller.signal.aborted) return this.snapshot()
    run.stopMessage = message
    this._publish(run, 'stopping', '正在停止原地播报…')
    run.controller.abort()
    return this.snapshot()
  }

  _publish(run, state, message) {
    if (this.run !== run) return
    this.state = { state, active: true, loop: run.loop, iteration: run.iteration, message,
      originalText: run.text, rewrittenText: run.rewrittenText, rewrittenIteration: run.rewrittenIteration }
    this.onState(this.snapshot())
  }

  _finish(run, state, message) {
    if (this.run !== run) return
    this.run = null
    this.state = { ...this.state, state, active: false, loop: run.loop, iteration: run.iteration, message }
    this.onState(this.snapshot())
  }

  async _rewrite(run, iteration, previousText) {
    const { signal } = run.controller
    signal.throwIfAborted()
    if (!this.llm?.rewriteStationary) throw new Error('请配置“巡游讲解”的 LLM 后再开始原地播报')
    const rewritten = await this.llm.rewriteStationary(run.text, { signal, previousText, iteration })
    signal.throwIfAborted()
    if (!rewritten?.text?.trim()) throw new Error('原地播报改写结果为空')
    return rewritten
  }

  async _play(run) {
    const { signal } = run.controller
    let nextRewrite = null
    let outcome = ['cancelled', '原地播报已停止']
    try {
      do {
        if (signal.aborted) break
        run.iteration++
        this._publish(run, 'preparing', `正在改写原地播报 · 第 ${run.iteration} 轮`)
        // A prefetched result stays private until the previous passage finishes.
        const prepared = nextRewrite ? await nextRewrite : { value: await this._rewrite(run, run.iteration, run.previousText) }
        nextRewrite = null
        signal.throwIfAborted()
        if (prepared.error) throw prepared.error
        const rewritten = prepared.value
        run.rewrittenText = rewritten.text
        run.rewrittenIteration = run.iteration
        this._publish(run, 'preparing', `正在合成原地播报 · 第 ${run.iteration} 轮`)
        if (run.loop) {
          // One round of lookahead, overlapping synthesis/playback. Always use
          // the fixed original plus the current rewrite as a diversity hint.
          // Capture failures now to avoid an unhandled rejection during audio.
          nextRewrite = this._rewrite(run, run.iteration + 1, rewritten.text.slice(0, 2000))
            .then(value => ({ value }), error => ({ error }))
        }
        const result = await this.tts.speak(rewritten.text, {
          signal,
          // Repetition must not keep appending duplicate files to the user's TTS library.
          harvest: false,
          onAudioStart: () => {
            if (!signal.aborted) this._publish(run, 'playing', `正在原地播报 · 第 ${run.iteration} 轮`)
          },
        })
        if (signal.aborted || result?.aborted) break
        if (result?.ok === false) throw result.error || new Error('语音播放失败')
        run.previousText = rewritten.text.slice(0, 2000)
        if (!run.loop) {
          outcome = ['completed', '原地播报已完成']
          break
        }
        this._publish(run, 'waiting', `第 ${run.iteration} 轮已完成，准备下一轮`)
        await delay(this.loopGapMs, undefined, { signal })
      } while (!signal.aborted)
    } catch (error) {
      if (!signal.aborted) outcome = ['failed', `原地播报失败: ${error?.message || '语音播放失败'}`]
    } finally {
      // Stop/failure cancels both playback and lookahead. Keep this run active
      // until the in-flight request settles so a restart cannot inherit it.
      run.controller.abort()
      if (nextRewrite) await nextRewrite
    }
    if (outcome[0] === 'cancelled') outcome[1] = run.stopMessage || '原地播报已停止'
    this._finish(run, ...outcome)
  }
}
