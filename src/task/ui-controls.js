const MANUAL_SPEECH_BLOCKED = '请先停止巡游，再进行手动播报测试'

export function getTourState(tour) {
  return {
    running: tour.isRunning,
    paused: tour.isPaused,
    repeatCount: tour.repeatCount,
    currentIteration: tour.currentIteration,
  }
}

/** These UI handlers never take ownership away from a running/paused tour. */
export function registerTourControls({ uiBridge, tour, tts, logger = console }) {
  uiBridge.on('onGetTourState', reply => reply('TOUR_STATE', getTourState(tour)))
  uiBridge.on('onTestSpeech', async text => {
    // The backend is authoritative: a stale/reconnecting UI can still send this.
    if (tour.isRunning) {
      uiBridge.broadcast('ERROR', { message: MANUAL_SPEECH_BLOCKED })
      return
    }
    try {
      const result = await tts.speak(text)
      if (result?.ok === false && !result.aborted) {
        uiBridge.broadcast('ERROR', { message: `手动播报测试失败: ${result.error?.message || '语音播放失败'}` })
      }
    } catch (error) {
      const message = error?.message || '语音播放失败'
      logger.error('[系统] 手动播报测试失败:', message)
      uiBridge.broadcast('ERROR', { message: `手动播报测试失败: ${message}` })
    }
  })
}
