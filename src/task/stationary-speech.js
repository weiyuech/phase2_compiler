import { setTimeout as delay } from 'node:timers/promises'

function shufflePlaylist(items) {
  const shuffled = [...items]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const index = Math.floor(Math.random() * (i + 1))
    ;[shuffled[i], shuffled[index]] = [shuffled[index], shuffled[i]]
  }
  return shuffled
}

/** A stationary run never moves the robot. The cruise engine arbitrates playback with barrage and host speech. */
export class StationarySpeech {
  constructor({ tts, llm, library, onLibraryChange = () => {}, onState = () => {}, loopGapMs = 0 }) {
    this.tts = tts
    this.llm = llm
    this.library = library
    this.onLibraryChange = onLibraryChange
    this.onState = onState
    this.loopGapMs = loopGapMs
    this.run = null
    this.state = { state: 'idle', active: false, loop: false, iteration: 0, message: '', originalText: '', rewrittenText: '', rewrittenIteration: 0 }
    this.finished = Promise.resolve()
  }

  snapshot() { return { ...this.state } }
  get active() { return this.run !== null }

  start({ groupId, text, mode, loop, recordingIds, shuffle } = {}) {
    if (this.active) throw new Error('定点播放正在进行，请先停止')
    let group
    if (this.library) {
      const { groups } = this.library.snapshot()
      group = groupId === undefined ? groups[0] : groups.find(item => item.id === groupId)
      if (!group) throw new Error('定点不存在')
    }
    // Old desktop clients supplied only text and loop, always meaning TTS.
    mode ??= groupId ? group?.mode ?? 'tts' : 'tts'
    loop ??= groupId ? group?.loop ?? true : false
    shuffle ??= group?.shuffle ?? false
    if (!['tts', 'mp3'].includes(mode)) throw new Error('未知的播放方式')
    if (typeof loop !== 'boolean' || typeof shuffle !== 'boolean') throw new Error('循环与随机选项必须为开或关')
    text ??= group?.text
    if (mode === 'tts' && (typeof text !== 'string' || !text.trim())) throw new Error('请输入定点播放原文')
    let playlist = []
    if (mode === 'mp3') {
      if (!group) throw new Error('请选择定点录音')
      playlist = this.library.playlist(group.id, recordingIds ?? group.recordingIds)
    }
    if (groupId && group) {
      this.library.updateGroup(group.id, { mode, loop, shuffle, text: mode === 'tts' ? text : undefined, recordingIds })
      this.onLibraryChange()
    }
    const run = { controller: new AbortController(), groupId: group?.id ?? null, mode, playlist, shuffle,
      text: text?.trim() || '', rewrittenText: '', rewrittenIteration: 0, loop, iteration: 0 }
    this.run = run
    this.finished = this._play(run)
    return this.snapshot()
  }

  stop(message = '定点播放已停止') {
    const run = this.run
    if (!run || run.controller.signal.aborted) return this.snapshot()
    run.stopMessage = message
    this._publish(run, 'stopping', '正在停止定点播放…')
    run.controller.abort()
    return this.snapshot()
  }

  _publish(run, state, message) {
    if (this.run !== run) return
    this.state = { state, active: true, loop: run.loop, groupId: run.groupId, mode: run.mode,
      recordingId: run.recordingId ?? null, iteration: run.iteration, message,
      originalText: run.text, rewrittenText: run.rewrittenText, rewrittenIteration: run.rewrittenIteration }
    this.onState(this.snapshot())
  }

  async _rewrite(run, iteration, previousText) {
    const { signal } = run.controller
    signal.throwIfAborted()
    if (!this.llm?.rewriteStationary) throw new Error('请先配置“巡游讲解”的 LLM')
    const rewritten = await this.llm.rewriteStationary(run.text, { signal, previousText, iteration })
    signal.throwIfAborted()
    if (!rewritten?.text?.trim()) throw new Error('定点播放改写结果为空')
    return rewritten.text
  }

  async _prepareNext(run, text) {
    const rewritten = await this._rewrite(run, run.iteration + 1, text.slice(0, 2000))
    const source = this.tts.prepareText && this.tts.speakPreparedText
      ? await this.tts.prepareText(rewritten, { signal: run.controller.signal, speculative: true }) : null
    return { rewritten, source }
  }

  async _playTts(run) {
    const { signal } = run.controller
    let next, saving
    try {
      do {
        run.iteration++
        const iteration = run.iteration
        this._publish(run, 'preparing', `正在准备第 ${iteration} 轮改写稿`)
        const prepared = next ? await next : { rewritten: await this._rewrite(run, iteration, '') }
        next = null
        if (prepared.error) throw prepared.error
        try {
          signal.throwIfAborted()
          const text = prepared.rewritten
          run.rewrittenText = text
          run.rewrittenIteration = iteration
          this._publish(run, 'preparing', `正在准备第 ${iteration} 轮语音`)
          const prefetch = () => {
            if (run.loop && !next && !signal.aborted) next = this._prepareNext(run, text).catch(error => ({ error }))
          }
          // Prioritize initial playback over speculative synthesis. Providers
          // with only the legacy speak interface can already overlap the rewrite.
          if (!this.tts.prepareText) prefetch()
          await saving
          const opts = {
            signal, harvest: false,
            onAudioStart: () => {
              if (signal.aborted) return false
              this._publish(run, 'playing', `正在播放第 ${iteration} 轮改写稿`)
              prefetch()
            },
          }
          if (run.groupId) opts.onRecording = file => {
            this.library.addRecording(run.groupId, { file, text, iteration })
            this.onLibraryChange()
          }
          const result = prepared.source ? await this.tts.speakPreparedText(prepared.source, opts) : await this.tts.speak(text, opts)
          if (result?.recording) {
            saving = result.recording
            saving.catch(() => {})
          }
          if (signal.aborted || result?.aborted) return false
          if (result?.ok === false) throw result.error || new Error('语音播放失败')
          if (!run.loop) return true
          prefetch()
        } finally {
          prepared.source?.release()
        }
        this._publish(run, 'waiting', `第 ${iteration} 轮已完成，准备下一轮`)
        if (this.loopGapMs > 0) await delay(this.loopGapMs, undefined, { signal })
      } while (!signal.aborted)
      return false
    } finally {
      // The completed recording can finish on disk while the next round is
      // prepared. At most one asynchronous encoder remains at this boundary.
      if (next) {
        run.controller.abort()
        const pending = await next
        pending.source?.release()
      }
      await saving
    }
  }

  async _playFiles(run) {
    const { signal } = run.controller
    do {
      run.iteration++
      const playlist = run.shuffle ? shufflePlaylist(run.playlist) : run.playlist
      for (const file of playlist) {
        signal.throwIfAborted()
        run.recordingId = file.id
        this._publish(run, 'preparing', `正在准备录音 · ${file.title}`)
        const result = await this.tts.speakFile(file.path, { signal, onAudioStart: () => {
          if (signal.aborted) return false
          this._publish(run, 'playing', `正在播放录音 · ${file.title}`)
        } })
        if (result?.aborted || signal.aborted) return false
        if (result?.ok === false) throw result.error || new Error('录音播放失败')
      }
      if (run.loop) await delay(0, undefined, { signal })
    } while (run.loop && !signal.aborted)
    return !signal.aborted
  }

  async _play(run) {
    let state = 'cancelled', message = '定点播放已停止'
    try {
      const completed = run.mode === 'mp3' ? await this._playFiles(run) : await this._playTts(run)
      if (completed && !run.controller.signal.aborted) { state = 'completed'; message = '定点播放已完成' }
    } catch (error) {
      if (!run.stopMessage && error?.name !== 'AbortError') {
        state = 'failed'
        message = `定点播放失败：${error?.message || '语音播放失败'}`
      }
    } finally {
      run.controller.abort()
      this.run = null
      this.state = { ...this.state, state, active: false, message: run.stopMessage || message }
      this.onState(this.snapshot())
    }
  }
}
