/** Coordinates one cancellable navigation -> narration loop. No service startup. */
export class CruiseController {
  constructor({
    robot, tour, getSelectedMap, playPoint, stopSpeech, startTransit, stopTransit,
    isTransitRunning = () => false, syncAudioPause = () => {},
    deferTransitUntilSpeech = () => false, finishTransitSentence = () => Promise.resolve(), broadcast,
  }) {
    Object.assign(this, {
      robot, tour, getSelectedMap, playPoint, stopSpeech, startTransit, stopTransit,
      isTransitRunning, syncAudioPause, deferTransitUntilSpeech, finishTransitSentence, broadcast,
    })
    this._active = null
    this._phase = 'idle'
    this.finished = Promise.resolve()
  }

  get isHandlingGoal() { return this._phase === 'speaking' }

  _validateMap(items) {
    const selected = this.getSelectedMap()
    if (!selected) throw new Error('请先在点位编辑页选择并切换地图')
    const mismatch = items.find(item => item.map_name !== selected)
    if (mismatch) {
      throw new Error(`当前选择地图是 ${selected}，巡游点 ${mismatch.path_name}/${mismatch.goal_id} 属于 ${mismatch.map_name}；未发送目标点，请停止巡游后选择正确地图，或修改清单`)
    }
  }

  start(repeatCount) {
    if (this.tour.isRunning) return
    try { this._validateMap(this.tour.getList()) } catch (err) {
      this.broadcast('ERROR', { message: err.message })
      return
    }
    if (!this.tour.start(repeatCount)) {
      this.broadcast('ERROR', { message: '巡游清单为空，无法开始' })
      return
    }
    this.syncAudioPause()
    this.broadcast('TOUR_STARTED', { repeatCount: this.tour.repeatCount })
    this._launch(false)
  }

  pause() {
    if (!this.tour.isRunning || this.tour.isPaused) return
    this.tour.pause()
    this.syncAudioPause()
    this.broadcast('TOUR_PAUSED', {})
  }

  resume() {
    if (!this.tour.isRunning || !this.tour.isPaused) return
    this.tour.resume()
    this.syncAudioPause()
    this.broadcast('TOUR_RESUMED', {})
    if (this._active) this._active.resumeWait?.()
    else this._launch(true, { preserveTransit: true })
  }

  stop() {
    this._releaseCurrentPoint()
    this.tour.stop()
    this.syncAudioPause()
    this.broadcast('TOUR_STOPPED', {})
  }

  skip() {
    if (!this.tour.isRunning) return
    this._releaseCurrentPoint({ preserveTransit: true })
    const wasPaused = this.tour.isPaused
    this.tour.resume()
    if (wasPaused) {
      this.syncAudioPause()
      this.broadcast('TOUR_RESUMED', {})
    }
    if (this._advance()) this._launch(true, { preserveTransit: true })
  }

  currentRemoved(nextIndex) {
    if (!this.tour.isRunning) return
    this._releaseCurrentPoint({ preserveTransit: true })
    if (nextIndex < 0) { this.stop(); return }
    this.tour.setCurrentIndex(nextIndex)
    if (!this.tour.isPaused) this._launch(true, { preserveTransit: true })
  }

  // Retire only the old point's callbacks, never the remaining tour list.
  // Redirecting while travelling must preserve the transition player AND any
  // in-flight transition synthesis (which uses the shared main TTS engine).
  _releaseCurrentPoint({ preserveTransit = false } = {}) {
    const old = this._active
    const wasSpeaking = this.isHandlingGoal
    this._active = null
    this._phase = 'idle'
    old?.abort()
    this.robot.cancelPendingGoal()
    if (!preserveTransit || wasSpeaking) this.stopSpeech()
    if (!preserveTransit) this.stopTransit()
    if (wasSpeaking) this.broadcast('SPEECH_END', { source: 'point' })
  }

  _isCurrent(run) {
    return this._active === run && !run.signal.aborted && this.tour.isRunning
  }

  async _waitUntilResumed(run) {
    // Pause retains the current goal and any completed arrival. Resume wakes
    // this same run; stop/skip/delete wake it only to retire the old point.
    while (this._isCurrent(run) && this.tour.isPaused) {
      await new Promise(resolve => {
        const wake = () => {
          run.signal.removeEventListener('abort', wake)
          if (run.resumeWait === wake) run.resumeWait = null
          resolve()
        }
        run.resumeWait = wake
        run.signal.addEventListener('abort', wake, { once: true })
      })
    }
  }

  _launch(withTransit, options) {
    this._releaseCurrentPoint(options)
    const run = new AbortController()
    this._active = run
    if (withTransit && !this.isTransitRunning()) this.startTransit()
    this.finished = this._run(run).catch(err => {
      if (!this._isCurrent(run)) return
      this._releaseCurrentPoint()
      this.pause()
      this.broadcast('ERROR', { message: err.message })
    })
  }

  async _run(run) {
    while (this._isCurrent(run)) {
      const item = this.tour.currentItem
      if (!item) return
      try {
        // Refuse mismatched maps; map switching remains an explicit operator action.
        this._validateMap([item])
        this._phase = 'navigating'
        const arrival = this.robot.sendSetGoal(item, { signal: run.signal })
        this.broadcast('GOAL_SENT', {
          map_name: item.map_name, path_name: item.path_name, goal_id: item.goal_id,
        })
        // Await the transaction itself instead of dropping an event while an
        // earlier handler is busy. Immediate ack + done cannot be lost here.
        const point = await arrival
        if (!this._isCurrent(run)) return
        // A ready point acquires the speaker after any current TTS sentence.
        // The default hook remains false for standalone/legacy integrations.
        const deferredHandoff = this.deferTransitUntilSpeech()
        const transitFinished = deferredHandoff ? this.finishTransitSentence() : Promise.resolve()
        if (!deferredHandoff) this.stopTransit()
        this._phase = 'arrived'
        this.broadcast('POINT_ARRIVED', point)
        await this._waitUntilResumed(run)
        if (!this._isCurrent(run)) return
        this._phase = 'speaking'
        const speech = new AbortController()
        const abortSpeech = () => speech.abort()
        run.signal.addEventListener('abort', abortSpeech, { once: true })
        const isPointCurrent = () => !speech.signal.aborted && this._isCurrent(run)
        let handedOff = false
        try {
          await this.playPoint(item, point, {
            isCurrent: isPointCurrent,
            signal: speech.signal,
            onAudioStart: () => {
              if (!isPointCurrent() || this.tour.isPaused) return false
              if (!handedOff) {
                handedOff = true
                if (deferredHandoff) this.stopTransit()
              }
              return true
            },
          })
          await transitFinished
        } finally {
          // A tour run spans several points. Retire THIS point's callbacks too.
          speech.abort()
          run.signal.removeEventListener('abort', abortSpeech)
        }
      } catch (err) {
        if (!this._isCurrent(run)) return
        console.error('[巡游]', err.message)
        if (err.code !== 'NAVIGATION_FAILED') {
          this._releaseCurrentPoint()
          this.pause()
          if (err.code === 'GOAL_REJECTED') {
            this.broadcast('GOAL_CHECK_FAILED', { ...item, message: err.message })
          }
          this.broadcast('ERROR', { message: err.message })
          return
        }
        // Failure to navigate is not arrival. Alignment failure, by contrast,
        // never enters this branch under the revised business rule.
        this.broadcast('ERROR', { message: `${err.message}，已跳过该点介绍` })
      }
      await this._waitUntilResumed(run)
      if (!this._isCurrent(run)) return
      this._phase = 'navigating'
      if (!this._advance()) { this._active = null; return }
      if (!this.isTransitRunning()) this.startTransit()
    }
  }

  _advance() {
    const previousIteration = this.tour.currentIteration
    const next = this.tour.advance()
    if (!next) {
      this._phase = 'idle'
      this.stopTransit()
      this.broadcast('TOUR_FINISHED', {})
      return false
    }
    if (this.tour.currentIteration !== previousIteration) {
      this.broadcast('TOUR_ITERATION', {
        currentIteration: this.tour.currentIteration, repeatCount: this.tour.repeatCount,
      })
    }
    return true
  }
}
