import { VolcengineTTSWSClient } from './volcengine-ws-client.js'
import { AudioPlayer }           from './audio-player.js'
import fs                        from 'fs'
import path                      from 'path'
import crypto                    from 'crypto'
import * as uiBridge             from '../ui-bridge.js'
import { PreparedTextSource, abortError, sentenceCacheKey } from './sentence-preparation.js'
import { access, stat, mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import ffmpegStatic from 'ffmpeg-static'

export function filterTtsText(text) {
  if (!text) return ''
  return text
    // Only allow Chinese, English, numbers, standard spaces, and standard punctuation/math symbols
    .replace(/[^\u4e00-\u9fa5a-zA-Z0-9\s，。！？、；：（）“”《》——~～‘’…\-_\/.?!,:;'"()\[\]\\*=+@#%&]/g, '')
    // Normalize whitespace
    .replace(/\s+/g, ' ')
    .trim()
}

export class TTSEngine {
  constructor(config = {}) {
    this.wsClient     = new VolcengineTTSWSClient(config)
    this.player       = new AudioPlayer({ outputRouter: config.audioOutput })
    this.activeWSCall = null
    this._playbackJob = null
    this.audioOutput = config.audioOutput
    this.coordinator = config.coordinator
    this.role = config.role || 'cruise'
    this.diagnostics = config.diagnostics
    this.harvest = config.harvest !== false
    this._harvests = new Set()
    this._sentenceOptions = { scheduler: config.synthesisScheduler, cache: config.sentenceCache }

    this.enabled = this.wsClient.isConfigured()
    console.log('[TTS] 使用火山引擎 V3 单向流式接口')
  }

  /**
   * Legacy one-shot synthesis helper. It stops this engine's active playback;
   * coordinated callers must use prepareText instead to keep preparation isolated.
   */
  async synthesizeBuffer(text) {
    const cleanedText = filterTtsText(text)
    if (!cleanedText) {
      throw new Error('TTS 合成文本为空')
    }
    if (!this.enabled) {
      throw new Error('TTS 未配置，无法合成音频')
    }

    this.stop()

    return new Promise((resolve, reject) => {
      let settled = false
      const chunks = []

      const cleanUp = () => {
        if (this.activeReject === safeReject) {
          this.activeReject = null
        }
      }
      const safeResolve = (value) => {
        if (settled) return
        settled = true
        cleanUp()
        resolve(value)
      }
      const safeReject = (err) => {
        if (settled) return
        settled = true
        cleanUp()
        reject(err)
      }

      this.activeReject = safeReject

      try {
        const call = this.wsClient.synthesizeStream(
          cleanedText,
          (chunk) => {
            if (!settled) chunks.push(Buffer.from(chunk))
          },
          () => {
            if (settled) return
            this.activeWSCall = null
            safeResolve(Buffer.concat(chunks))
          },
          (err) => {
            if (settled) return
            this.activeWSCall = null
            safeReject(err)
          },
        )
        if (!settled) this.activeWSCall = call
      } catch (err) {
        this.activeWSCall = null
        safeReject(err)
      }
    })
  }

  /**
   * With a coordinator: prepare complete sentences and arbitrate each boundary.
   * Without one: retain legacy streaming TTS (WS → ffplay) behavior below.
   * @param {string} text
   * @param {object} [opts]
   * @param {() => boolean} [opts.beforePlay] - Sync predicate called RIGHT BEFORE
   *   audio playback starts (ffplay about to spawn). If it returns false, playback
   *   is aborted silently: WS call is cancelled, ffplay never spawns, cruising audio
   *   is never paused. Resolves with { ok: false, aborted: true }.
   * @param {({ signal: AbortSignal }) => Promise<boolean>} [opts.waitForPlayback]
   *   Optional cancellable eligibility wait. Incoming audio remains buffered while
   *   waiting, even if synthesis completes. Does not enable full-file preparation.
   * @param {AbortSignal} [opts.signal] - Cancel preparation and playback together.
   * @param {() => void} [opts.onAudioStart] - Fires once at the playback handoff.
   */
  async speak(text, opts = {}) {
    if (this.coordinator) return this._speakSentences(text, opts)
    if (!text) return
    const cleanedText = filterTtsText(text)
    if (!cleanedText) return

    if (!this.enabled) {
      console.log(`[TTS] 测试模式 — 播报内容: "${cleanedText}"`)
      return
    }

    this.stop()

    const job = new AbortController()
    this._playbackJob = job
    return new Promise(resolve => {
      const PRE_BUFFER_THRESHOLD = 4096
      const gated = typeof opts.waitForPlayback === 'function'
      let terminal = false
      let call = null
      let stream = null
      let requestedStart = false
      let playing = false
      let sourceDone = false
      let streamEnded = false
      let playbackDone = false
      let bufferedSize = 0
      let bufferedChunks = []
      const capturedChunks = []
      const ownsJob = () => this._playbackJob === job
      const abortExternal = () => job.abort()
      const abortCall = () => {
        if (this.activeWSCall === call) this.activeWSCall = null
        try { call?.abort() } catch {}
      }
      const settle = result => {
        if (terminal) return
        terminal = true
        bufferedChunks = []
        opts.signal?.removeEventListener('abort', abortExternal)
        job.signal.removeEventListener('abort', cancel)
        if (this.activeReject === fail) this.activeReject = null
        if (ownsJob()) this._playbackJob = null
        resolve(result)
      }
      const cancel = () => {
        if (terminal) return
        // Settle BEFORE aborting: providers may synchronously call onError/finish.
        const owned = ownsJob()
        settle({ ok: false, aborted: true })
        job.abort()
        abortCall()
        if (owned) this.player.stop()
      }
      const fail = err => {
        if (terminal) return
        const owned = ownsJob()
        settle({ ok: false, error: err })
        job.abort()
        abortCall()
        if (owned) this.player.stop()
        console.error('[TTS] 播报播放失败:', err.message)
      }
      const complete = () => {
        if (terminal || !sourceDone || !streamEnded || !playbackDone) return
        saveHarvestedAudio(cleanedText, capturedChunks)
        settle({ ok: true })
      }
      const finishStream = () => {
        if (terminal || !playing || !sourceDone || streamEnded) return
        streamEnded = true
        try { stream.end() } catch (err) { fail(err); return }
        complete()
      }
      const canPlay = (checkPredicate = true) => !terminal && !job.signal.aborted && ownsJob()
        && (!checkPredicate || !opts.beforePlay || opts.beforePlay())
      const activate = () => {
        if (!canPlay(gated)) { cancel(); return }
        playing = true
        try {
          if (opts.onAudioStart?.() === false) { cancel(); return }
        } catch (err) {
          console.error('[TTS] onAudioStart hook threw:', err.message)
        }
        if (terminal) return
        try {
          for (const chunk of bufferedChunks) stream.write(chunk)
          bufferedChunks = []
          finishStream()
        } catch (err) { fail(err) }
      }
      const launch = () => {
        if (!canPlay()) { cancel(); return }
        stream = this.player.startStream()
        if (!stream) { fail(new Error('无法启动音频播放流')); return }
        // Observe failure immediately, including failures before synthesis ends.
        Promise.resolve(stream.promise).then(() => {
          playbackDone = true
          complete()
        }, fail)
        if (!gated) {
          // Retain the existing synchronous barrage/robot handoff contract.
          activate()
          return
        }
        Promise.resolve(stream.ready).then(async () => {
          if (terminal) return
          // A host/pause event may arrive while the child is launching. No MP3
          // bytes have been written yet, so waiting here cannot leak narration.
          const allowed = await opts.waitForPlayback({ signal: job.signal })
          if (terminal) return
          if (allowed === false) { cancel(); return }
          activate()
        }).catch(fail)
      }
      const requestStart = () => {
        if (terminal || requestedStart) return
        requestedStart = true
        if (!gated) {
          try { launch() } catch (err) { fail(err) }
          return
        }
        Promise.resolve().then(() => terminal ? false : opts.waitForPlayback({ signal: job.signal })).then(allowed => {
          if (terminal) return
          if (allowed === false) { cancel(); return }
          launch()
        }).catch(fail)
      }
      this.activeReject = fail
      job.signal.addEventListener('abort', cancel, { once: true })
      opts.signal?.addEventListener('abort', abortExternal, { once: true })
      if (opts.signal?.aborted) { job.abort(); return }
      try {
        call = this.wsClient.synthesizeStream(
          cleanedText,
          chunk => {
            if (terminal || sourceDone) return
            const bytes = Buffer.from(chunk)
            capturedChunks.push(bytes)
            if (playing) {
              try { stream.write(bytes) } catch (err) { fail(err) }
            } else {
              bufferedChunks.push(bytes)
              bufferedSize += bytes.length
              if (bufferedSize >= PRE_BUFFER_THRESHOLD) requestStart()
            }
          },
          () => {
            if (terminal || sourceDone) return
            sourceDone = true
            if (this.activeWSCall === call) this.activeWSCall = null
            if (capturedChunks.length === 0) { fail(new Error('TTS 未返回音频')); return }
            requestStart()
            finishStream()
          },
          fail,
        )
        if (terminal) abortCall()
        else if (!sourceDone) this.activeWSCall = call
      } catch (err) { fail(err) }
    })
  }

  async speakFile(filePath, opts = {}) {
    if (this.coordinator) return this._speakCoordinatedFile(filePath, opts)
    if (!filePath) return
    this.stop()
    const job = new AbortController()
    this._playbackJob = job
    const abortExternal = () => job.abort()
    opts.signal?.addEventListener('abort', abortExternal, { once: true })
    if (opts.signal?.aborted) job.abort()
    try {
      if (job.signal.aborted) return { ok: false, aborted: true }
      const result = await this.player.playFile(filePath, { ...opts, signal: job.signal })
      return result || { ok: true }
    } catch (err) {
      console.error('[TTS] 播放文件出错:', err.message)
      return { ok: false, error: err }
    } finally {
      opts.signal?.removeEventListener('abort', abortExternal)
      if (this._playbackJob === job) this._playbackJob = null
    }
  }

  /** Preparation never calls stop(): transit/prefetch cannot replace playback. */
  async prepareText(text, opts = {}) {
    const cleanedText = filterTtsText(text)
    if (!cleanedText) throw new Error('TTS 合成文本为空')
    if (!this.enabled) throw new Error('TTS 未配置，无法合成音频')
    const generation = this.audioOutput?.generation
    const source = new PreparedTextSource(cleanedText, this.wsClient, {
      ...this._sentenceOptions, ...opts, role: this.role, diagnostics: this.diagnostics,
      isCurrent: () => generation === this.audioOutput?.generation,
    })
    source.prefetch(0)
    try {
      await source.get(0)
      return source
    } catch (error) { source.release(); throw error }
  }

  async _speakSentences(text, opts) {
    this.stop()
    const operation = this._newOperation(opts.signal)
    let source
    try {
      source = await this.prepareText(text, { signal: operation.signal })
      return await this._playSentenceSource(source, opts, operation)
    } catch (error) { return this._operationError(error, operation) }
    finally { source?.release(); operation.dispose() }
  }

  /** A reusable voice-snapshotted source for transit loops, still window-bounded. */
  async speakPreparedText(source, opts = {}) {
    this.stop()
    const operation = this._newOperation(opts.signal, source.signal)
    try { return await this._playSentenceSource(source, opts, operation) }
    catch (error) { return this._operationError(error, operation) }
    finally { operation.dispose() }
  }

  _newOperation(...signals) {
    const controller = new AbortController()
    this._playbackJob = controller
    const owns = () => this._playbackJob === controller
    const abort = () => {
      if (owns()) this.player.stop()
      // Tear down bytes/process ownership before releasing the coordinator lease;
      // cancelling the lease may synchronously resume a lower-priority source.
      controller.abort()
    }
    for (const signal of signals) {
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
    }
    return {
      controller, signal: controller.signal, owns,
      dispose: () => {
        for (const signal of signals) signal?.removeEventListener('abort', abort)
        if (owns()) this._playbackJob = null
      },
    }
  }

  _operationError(error, operation) {
    if (operation.signal.aborted || !operation.owns() || error?.name === 'AbortError') return { ok: false, aborted: true }
    this.diagnostics?.event?.('error', { source: this.role === 'cruise' ? 'point' : this.role, errorCode: error?.code || 'OTHER' })
    console.error('[TTS] 准备/播放失败:', error.message)
    return { ok: false, error }
  }

  async _playSentenceSource(source, opts, operation) {
    const utteranceId = opts.utteranceId || crypto.randomUUID()
    const robotMode = !!this.audioOutput?.isRobotDestination()
    const generation = this.audioOutput?.generation
    const valid = () => operation.owns() && !operation.signal.aborted && !source.signal.aborted
      && source.isCurrent() && generation === this.audioOutput?.generation && opts.beforePlay?.() !== false
    let currentSentence = -1
    const coordination = this.coordinator.createJob({
      id: utteranceId, role: this.role, kind: 'tts', signal: operation.signal,
      pause: () => this.player.pause(), resume: () => {
        const resumed = this.player.resume()
        if (currentSentence >= 0 && valid()) opts.onSentenceStart?.({
          utteranceId, index: currentSentence, text: source.sentences[currentSentence], resumed: true,
        })
        return resumed
      },
    })
    const sequenceState = { nextSeq: 1 }
    const units = new Map()
    let started = false, completed = 0, harvestScheduled = false
    const harvest = this.harvest && opts.harvest !== false
      ? new SentenceHarvest(source.text, source.length, sentenceCacheKey(source.text, source.client)) : null
    if (harvest) this._harvests.add(harvest)
    const diag = (type, fields = {}) => this.diagnostics?.event?.(type, {
      source: this.role === 'cruise' ? 'point' : this.role, sessionId: utteranceId, ...fields,
    })
    const prepare = index => {
      if (units.has(index)) return units.get(index)
      const unit = { ready: false, handle: null, data: null }
      units.set(index, unit)
      unit.promise = source.get(index, { speculative: index > completed }).then(async data => {
        if (!valid()) throw abortError()
        unit.data = data
        if (robotMode) unit.handle = await this.audioOutput.prepareBuffer(data.buffer, {
          signal: operation.signal, cacheKey: data.key,
        })
        if (!valid()) { unit.handle?.release(); unit.handle = null; throw abortError() }
        unit.ready = true
        return unit
      })
      unit.promise.catch(() => {})
      return unit
    }
    const fillWindow = index => {
      source.prefetch(index)
      for (let next = index; next < Math.min(source.length, index + 3); next++) prepare(next)
    }
    const wait = async () => {
      if (!valid()) return false
      if (opts.waitForPlayback && await abortable(opts.waitForPlayback({ signal: operation.signal }), operation.signal) === false) return false
      if (!valid()) return false
      if (await abortable(coordination.acquire(), operation.signal) === false) return false
      return valid() && coordination.active
    }
    try {
      fillWindow(0)
      for (let index = 0; index < source.length; index++) {
        if (!valid()) throw abortError()
        source.get(index).catch(() => {}) // Promote queued speculative synthesis.
        const unit = prepare(index)
        const waitingAt = performance.now()
        if (!unit.ready) diag('waiting', { sentenceIndex: index, reason: 'preparation', prepared: false })
        await abortable(unit.promise, operation.signal)
        diag('prepared', { sentenceIndex: index, waitMs: performance.now() - waitingAt, prepared: true })
        if (index === 0) opts.onPrepared?.({ utteranceId })
        if (!await wait()) throw abortError()
        const onAudioStart = () => {
          if (!valid() || !coordination.active) return false
          if (!started) {
            if (opts.onAudioStart?.() === false) return false
            started = true
          }
          currentSentence = index
          opts.onSentenceStart?.({ utteranceId, index, text: unit.data.text })
          diag('playback-start', { sentenceIndex: index })
          return valid()
        }
        const playbackOpts = {
          signal: operation.signal, beforePlay: () => valid() && coordination.active,
          waitForPlayback: wait, onAudioStart, sequenceState, managed: true,
          utteranceId, source: this.role === 'cruise' ? 'point' : this.role,
        }
        const result = robotMode
          ? await this.player.playPrepared(unit.handle, playbackOpts)
          : await this.player.playSentence(unit.data.buffer, playbackOpts)
        if (!valid() || result?.aborted) throw abortError()
        if (result?.ok === false) throw result.error || new Error('语音播放失败')
        harvest?.append(index, unit.data.buffer)
        unit.handle?.release()
        unit.handle = null
        // Commit the completed cursor before arbitration. No next-sentence bytes
        // can enter a player until its fresh acquire() has won the speaker.
        completed = index + 1
        currentSentence = -1
        diag('boundary', { sentenceIndex: index })
        units.delete(index)
        source.releaseBefore(completed)
        const remaining = completed < source.length
        coordination.boundary(remaining && units.get(completed)?.ready === true, { hold: remaining })
        if (remaining) fillWindow(completed)
      }
      if (harvest) {
        harvestScheduled = true
        harvest.finish().finally(async () => { await harvest.dispose(); this._harvests.delete(harvest) }).catch(() => {})
      }
      diag('playback-end', { sentenceCount: completed, reason: 'finished' })
      return { ok: true, utteranceId, completedSentences: completed }
    } catch (error) {
      return this._operationError(error, operation)
    } finally {
      // Stop/skip may leave prefetched decoders unresolved. Their own signal is
      // cancelled before handles are retired, preventing late prepared leaks.
      operation.controller.abort()
      coordination.finish()
      for (const unit of units.values()) unit.handle?.release()
      source.releaseBefore(source.length)
      if (!harvestScheduled && harvest) { await harvest.dispose(); this._harvests.delete(harvest) }
    }
  }

  async _speakCoordinatedFile(filePath, opts) {
    this.stop()
    const operation = this._newOperation(opts.signal)
    const generation = this.audioOutput?.generation
    const robotMode = !!this.audioOutput?.isRobotDestination()
    const utteranceId = opts.utteranceId || crypto.randomUUID()
    const valid = () => operation.owns() && !operation.signal.aborted
      && generation === this.audioOutput?.generation && opts.beforePlay?.() !== false
    let handle, coordination, started = false
    try {
      if (!valid()) throw abortError()
      // Failed input must never acquire/preempt the current speaker.
      if (robotMode) handle = await this.audioOutput.prepareFile(filePath, { signal: operation.signal })
      else {
        await access(filePath, fs.constants.R_OK)
        if (!(await stat(filePath)).isFile()) throw new Error('音频文件不是普通文件')
      }
      if (!valid()) throw abortError()
      opts.onPrepared?.({ utteranceId })
      coordination = this.coordinator.createJob({
        id: utteranceId, role: this.role, kind: 'mp3', signal: operation.signal,
        pause: () => this.player.pause(), resume: () => this.player.resume(),
      })
      const wait = async () => {
        if (!valid()) return false
        if (opts.waitForPlayback && await abortable(opts.waitForPlayback({ signal: operation.signal }), operation.signal) === false) return false
        if (!valid()) return false
        if (await abortable(coordination.acquire(), operation.signal) === false) return false
        return valid() && coordination.active
      }
      if (!await wait()) throw abortError()
      const playbackOpts = {
        signal: operation.signal, waitForPlayback: wait,
        beforePlay: () => valid() && coordination.active,
        onAudioStart: () => {
          if (!valid() || !coordination.active) return false
          if (!started) {
            if (opts.onAudioStart?.() === false) return false
            started = true
          }
          return true
        },
        managed: true, sequenceState: { nextSeq: 1 },
        utteranceId, source: this.role === 'cruise' ? 'point' : this.role,
      }
      const result = robotMode
        ? await this.player.playPrepared(handle, playbackOpts)
        : await this.player.playFile(filePath, playbackOpts)
      if (!valid() || result?.aborted) throw abortError()
      if (result?.ok === false) throw result.error || new Error('音频播放失败')
      return { ok: true, utteranceId }
    } catch (error) { return this._operationError(error, operation) }
    finally {
      coordination?.finish()
      handle?.release()
      operation.dispose()
    }
  }

  stop() {
    const operation = this._playbackJob
    // Stop the physical output BEFORE abort listeners release the speaker lease.
    // A cancelled job's pause bit must not freeze its eligible replacement.
    this.player.stop({ clearPause: !!this.coordinator })
    operation?.abort()
    if (this._playbackJob === operation) this._playbackJob = null
    if (this.activeWSCall) {
      try {
        this.activeWSCall.abort()
      } catch {}
      this.activeWSCall = null
    }
    if (this.activeReject) {
      this.activeReject(new Error('TTS playback stopped'))
      this.activeReject = null
    }
  }

  destroy() {
    this.stop()
    for (const harvest of this._harvests) harvest.cancel()
  }
}

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const cancel = () => { cleanUp(); reject(abortError()) }
    const cleanUp = () => signal.removeEventListener('abort', cancel)
    signal.addEventListener('abort', cancel, { once: true })
    Promise.resolve(promise).then(value => { cleanUp(); resolve(value) }, error => { cleanUp(); reject(error) })
  })
}

// Independent MP3 sentences are NOT concatenated as MP3 bytes. A successful
// utterance is joined through ffmpeg's concat demuxer and encoded once. The
// private spool is bounded and disposed on cancellation or conversion failure.
let activeHarvests = 0
class SentenceHarvest {
  constructor(text, count, hash) {
    this.text = text
    this.count = count
    this.hash = hash
    this.bytes = 0
    this.disabled = activeHarvests >= 2
    this.slot = !this.disabled
    if (this.slot) activeHarvests++
    this.files = []
    this.writes = []
    this.directory = null
    this.directoryPromise = null
    this.child = null
  }
  append(index, buffer) {
    if (this.disabled) return
    this.bytes += buffer.length
    if (this.bytes > 16 * 1024 * 1024) { this.disabled = true; return }
    if (!this.directoryPromise) this.directoryPromise = mkdtemp(path.join(tmpdir(), 'robot-tts-harvest-')).then(dir => (this.directory = dir))
    const pending = this.directoryPromise.then(async dir => {
      const file = path.join(dir, `${index}.mp3`)
      await writeFile(file, buffer)
      this.files[index] = file
    }).catch(error => { this.disabled = true; console.warn('[TTS Harvester] 临时缓存失败:', error.code || error.name) })
    this.writes.push(pending)
  }
  async finish() {
    await Promise.all(this.writes)
    if (this.disabled || this.files.length !== this.count || this.files.some(file => !file)) return
    try {
      if (this.count === 1) { await savePreparedHarvest(this.text, await readFile(this.files[0]), this.hash); return }
      const list = path.join(this.directory, 'segments.txt')
      await writeFile(list, this.files.map(file => `file '${file.replace(/'/g, "'\\''")}'`).join('\n'))
      const joined = path.join(this.directory, 'utterance.mp3')
      await new Promise((resolve, reject) => {
        const child = this.child = spawn(ffmpegStatic, ['-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-vn', '-c:a', 'libmp3lame', '-y', joined], { stdio: 'ignore' })
        const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('TTS utterance merge timeout')) }, 30000)
        timeout.unref?.()
        const cleanup = () => { clearTimeout(timeout); if (this.child === child) this.child = null }
        child.once('error', error => { cleanup(); reject(error) })
        child.once('close', code => { cleanup(); code === 0 ? resolve() : reject(new Error('TTS utterance merge failed')) })
      })
      const result = await stat(joined)
      if (!this.disabled && result.size <= 16 * 1024 * 1024) await savePreparedHarvest(this.text, await readFile(joined), this.hash)
    } catch (error) { console.warn('[TTS Harvester] 合并失败:', error.code || error.name) }
  }
  async dispose() {
    await Promise.all(this.writes)
    if (this.directory) await rm(this.directory, { recursive: true, force: true }).catch(() => {})
    if (this.slot) { this.slot = false; activeHarvests-- }
  }
  cancel() {
    this.disabled = true
    try { this.child?.kill('SIGKILL') } catch {}
  }
}

async function savePreparedHarvest(text, buffer, hash) {
  const directory = path.join(process.env.USER_DATA_DIR ? path.join(process.env.USER_DATA_DIR, 'data') : './data', 'tts-cache')
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, `${hash}.mp3`), buffer)
  await writeFile(path.join(directory, `${hash}.txt`), text, 'utf8')
  uiBridge.broadcast('TTS_HARVESTED', { hash })
}

function saveHarvestedAudio(text, chunks) {
  try {
    const hash = crypto.createHash('md5').update(text).digest('hex')
    const USER_DATA = process.env.USER_DATA_DIR
    const DATA_DIR = USER_DATA ? path.join(USER_DATA, 'data') : './data'
    const cacheDir = path.join(DATA_DIR, 'tts-cache')
    
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true })
    }
    
    const mp3Path = path.join(cacheDir, `${hash}.mp3`)
    const txtPath = path.join(cacheDir, `${hash}.txt`)
    
    const fullBuffer = Buffer.concat(chunks)
    fs.writeFileSync(mp3Path, fullBuffer)
    fs.writeFileSync(txtPath, text, 'utf8')
    console.log(`[TTS Harvester] Saved: ${hash} ("${text.slice(0, 15)}...")`)
    
    // Broadcast event to UI
    uiBridge.broadcast('TTS_HARVESTED', { hash })
  } catch (err) {
    console.error('[TTS Harvester] Failed to save harvested audio:', err.message)
  }
}
