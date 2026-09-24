import { setTimeout as delay } from 'node:timers/promises'

/** Ephemeral playback only: never persists a queue, moves the robot, or rewrites text. */
export class StationarySpeech {
  constructor({ tts, onState = () => {}, loopGapMs = 250 }) {
    this.tts = tts
    this.onState = onState
    this.loopGapMs = loopGapMs
    this.run = null
    this.state = { state: 'idle', active: false, loop: false, iteration: 0, message: '' }
    this.finished = Promise.resolve()
  }

  snapshot() { return { ...this.state } }
  get active() { return this.run !== null }

  start({ text, loop = false } = {}) {
    if (this.active) throw new Error('原地播报正在进行，请先停止')
    if (typeof text !== 'string' || !text.trim()) throw new Error('请输入原地播报文本')
    if (typeof loop !== 'boolean') throw new Error('循环选项必须为开或关')
    const run = { controller: new AbortController(), text: text.trim(), loop, iteration: 0 }
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
    this.state = { state, active: true, loop: run.loop, iteration: run.iteration, message }
    this.onState(this.snapshot())
  }

  _finish(run, state, message) {
    if (this.run !== run) return
    this.run = null
    this.state = { state, active: false, loop: run.loop, iteration: run.iteration, message }
    this.onState(this.snapshot())
  }

  async _play(run) {
    const { signal } = run.controller
    try {
      do {
        if (signal.aborted) break
        run.iteration++
        this._publish(run, 'preparing', `正在准备原地播报 · 第 ${run.iteration} 轮`)
        const result = await this.tts.speak(run.text, {
          signal,
          // Repetition must not keep appending duplicate files to the user's TTS library.
          harvest: false,
          onAudioStart: () => {
            if (!signal.aborted) this._publish(run, 'playing', `正在原地播报 · 第 ${run.iteration} 轮`)
          },
        })
        if (signal.aborted || result?.aborted) {
          this._finish(run, 'cancelled', run.stopMessage || '原地播报已取消')
          return
        }
        if (result?.ok === false) throw result.error || new Error('语音播放失败')
        if (!run.loop) {
          this._finish(run, 'completed', '原地播报已完成')
          return
        }
        this._publish(run, 'waiting', `第 ${run.iteration} 轮已完成，准备下一轮`)
        await delay(this.loopGapMs, undefined, { signal })
      } while (!signal.aborted)
      this._finish(run, 'cancelled', run.stopMessage || '原地播报已停止')
    } catch (error) {
      if (signal.aborted) this._finish(run, 'cancelled', run.stopMessage || '原地播报已停止')
      else this._finish(run, 'failed', `原地播报失败: ${error?.message || '语音播放失败'}`)
    }
  }
}
