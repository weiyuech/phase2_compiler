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
    const status = (state, message) => {
      logger.log(`[系统] 手动播报测试: ${state}`)
      uiBridge.broadcast('TEST_SPEECH_STATUS', { state, message })
    }
    status('preparing', '后端已收到，正在准备语音…')
    try {
      if (typeof text !== 'string' || !text.trim()) throw new Error('请输入测试播报文本')
      const result = await tts.speak(text, {
        onAudioStart: () => { status('playing', '正在播放测试语音') },
      })
      if (result?.ok === false && !result.aborted) {
        throw result.error || new Error('语音播放失败')
      } else if (result?.aborted) status('cancelled', '测试播报已取消')
      else status('completed', '测试播报已完成')
    } catch (error) {
      const message = error?.message || '语音播放失败'
      logger.error('[系统] 手动播报测试失败:', message)
      status('failed', `测试播报失败: ${message}`)
      uiBridge.broadcast('ERROR', { message: `手动播报测试失败: ${message}` })
    }
  })
}
