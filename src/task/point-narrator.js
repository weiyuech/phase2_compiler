import fs from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

// Shared local/robot handoff policy; transport readiness is owned by the engine.
export function createPointNarrator({
  kb, llm, tts, dataDir, broadcast,
  isSpeechBlocked = () => false,
  getOutputGeneration = () => 0,
  random = Math.random,
  pollMs = 25,
}) {
  return async function narrate(item, point, {
    isCurrent = () => true, signal, onAudioStart,
  } = {}) {
    const outputGeneration = getOutputGeneration()
    const utteranceId = randomUUID()
    let open = true
    let started = false
    const ownsPoint = () => open && !signal?.aborted && isCurrent()
    const valid = () => ownsPoint() && outputGeneration === getOutputGeneration()
    const waitForPlayback = async ({ signal: playbackSignal } = {}) => {
      while (valid() && !playbackSignal?.aborted) {
        if (!isSpeechBlocked()) return true
        await wait(pollMs, [signal, playbackSignal])
      }
      return false
    }
    const playbackOptions = (payload) => ({
      utteranceId,
      signal,
      waitForPlayback,
      beforePlay: valid,
      onAudioStart: () => {
        if (!valid()) return false
        if (started) return true
        if (onAudioStart?.() === false) return false
        started = true
        broadcast('SPEECH_START', { ...payload, utteranceId, source: 'point' })
        return true
      },
      onSentenceStart: ({ text, index, resumed = false }) => {
        if (valid() && started) broadcast('SPEECH_SENTENCE', { utteranceId, source: 'point', text, index, resumed })
      },
    })

    try {
      const { map_name, path_file, goal_id } = point
      const content = await kb.getContent(map_name, path_file, goal_id, item.goal_object || null)
      if (!valid()) return
      if (!content) {
        broadcast('ERROR', { message: `没有找到点位内容: ${map_name}/${path_file}/${goal_id}，请检查知识库路径是否与巡游清单一致` })
        return
      }

      const mode = item.play_mode || (content.body ? 'tts' : 'mp3')
      if (mode === 'mp3') {
        const directory = join(dataDir, 'cruising-audio', map_name, path_file, String(goal_id))
        let files = []
        try { files = (await fs.readdir(directory)).filter(f => f.toLowerCase().endsWith('.mp3')) } catch {}
        if (!valid()) return
        if (!files.length) {
          console.log(`[系统] 点位 ${map_name}/${path_file}/${goal_id} 没有可播放的音频，保留过渡音频并继续。`)
          return
        }
        const selected = join(directory, files[Math.floor(random() * files.length)])
        const response = await tts.speakFile(selected, playbackOptions({ mp3_file: selected }))
        if (response?.ok === false && !response.aborted && valid()) {
          broadcast('ERROR', { message: `点位播报失败: ${response.error?.message || '音频播放失败'}` })
        }
      } else if (content.body) {
        const result = await llm.rewrite({ ...content, goal_object: item.goal_object ?? null })
        if (!valid()) return
        const response = await tts.speak(result.text, playbackOptions({ text: result.text }))
        if (response?.ok === false && !response.aborted && valid()) {
          broadcast('ERROR', { message: `点位播报失败: ${response.error?.message || '音频播放失败'}` })
        }
      }
    } catch (err) {
      if (valid()) broadcast('ERROR', { message: `点位播报失败: ${err.message}` })
    } finally {
      // An output switch invalidates playback, but this still-current point
      // owns its caption and must clear it. Superseded points own neither.
      if (started && ownsPoint()) broadcast('SPEECH_END', { utteranceId, source: 'point' })
      // Missing/failed content never claims the speaker. Transit continues into
      // the next leg, and the controller still stops it at tour end/stop/error.
      open = false
    }
  }
}

function wait(ms, signals) {
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer)
      for (const signal of signals) signal?.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    for (const signal of signals) signal?.addEventListener('abort', finish, { once: true })
    if (signals.some(signal => signal?.aborted)) finish()
  })
}
