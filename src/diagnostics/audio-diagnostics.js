import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { randomUUID } from 'node:crypto'
import { RollingLog, readRollingLog } from './rolling-log.js'

const EVENTS = new Set([
  'session-start', 'prepare-start', 'prepared', 'playback-start', 'playback-end',
  'pause', 'resume', 'stop', 'error', 'handoff', 'boundary', 'user-marker',
  'destination-change', 'connected', 'disconnected', 'runtime', 'packet-summary',
  'waiting', 'volume-change',
])
const EVENT_ALIASES = {
  sentence_prepared: 'prepared', sentence_wait: 'waiting', sentence_playing: 'playback-start',
  preparation_failed: 'error', 'sentence-boundary': 'boundary', playing: 'playback-start',
  completed: 'playback-end', cancelled: 'stop', audio_cache_ready: 'prepared',
  robot_audio_generation: 'stop', robot_audio_prepared: 'prepared', robot_audio_start: 'playback-start',
  robot_audio_read_ahead_wait: 'waiting', robot_audio_failed: 'error', robot_audio_sent: 'playback-end',
  robot_volume_change: 'volume-change',
}
const ENUMS = {
  destination: new Set(['local', 'robot']),
  direction: new Set(['client', 'server']),
  source: new Set(['tts', 'mp3', 'file', 'transit', 'point', 'barrage', 'manual', 'unknown']),
  reason: new Set(['host', 'barrage', 'tour-pause', 'stop', 'skip', 'replacement', 'disconnect', 'destination-change', 'boundary', 'finished', 'cancelled', 'error',
    'preparing', 'sentence-wait', 'ready', 'owner', 'operator', 'tour', 'preparation', 'priority', 'read-ahead', 'backpressure']),
  kind: new Set(['tts', 'file', 'mp3']),
  storage: new Set(['memory', 'disk']),
  errorCode: new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'IO_ERROR', 'AUDIO_BACKLOG', 'AUDIO_SEND_TIMEOUT', 'AUDIO_OWNERSHIP_CONFLICT', 'OTHER']),
}
const NUMBERS = new Set([
  'seq', 'bytes', 'frames', 'durationMs', 'prepareMs', 'decodeMs', 'synthesisMs',
  'waitMs', 'elapsedMs', 'scheduledAtMs', 'sentAtMs', 'gapMs', 'latenessMs',
  'bufferedBytes', 'pcmBufferedBytes', 'sendCallbackMs', 'sentenceIndex', 'sentenceCount',
  'sampleRate', 'channels', 'chunkBytes', 'chunkMs', 'code', 'frameCount',
  'maxGapMs', 'p95GapMs', 'p99GapMs', 'maxLatenessMs', 'late30Count', 'late50Count',
  'maxBufferedBytes', 'maxPcmBufferedBytes', 'maxSendCallbackMs', 'sequenceGaps',
  'eventLoopP99Ms', 'eventLoopMaxMs', 'cpuPercent', 'rssBytes', 'heapBytes',
  'generation', 'connectionGeneration', 'offsetBytes', 'memoryBytes', 'diskBytes', 'entries', 'activeDecodes', 'payloadBytes',
  'socketWrites', 'failedWrites', 'staleWrites', 'maxPayloadBytes', 'diagnosticDroppedRecords', 'diagnosticDiscardedBytes', 'diagnosticTruncatedRecords', 'diagnosticStoredBytes',
  'robotVolumePercent', 'clippedSamples', 'highWaterBytes', 'lowWaterBytes', 'hardLimitBytes',
  'audioDurationMs', 'cadenceAudioMs', 'activeSendMs', 'cadenceSamples', 'sendRateRatio', 'sendLagMs', 'capturedAt',
  'pacingCorrections', 'pacingCorrectionMs', 'pacingRebases', 'pacingRebaseMs',
  'runStartedAt', 'totalActiveSendMs', 'totalCadenceAudioMs', 'totalCadenceSamples',
  'totalPacingCorrectionMs', 'totalPacingRebases', 'totalPacingRebaseMs',
  'pcmPeak', 'pcmRms', 'pcmNonzeroSamples', 'pcmSamples',
])
const BOOLEANS = new Set(['connected', 'ducking', 'barrageEnabled', 'ocrEnabled', 'paused', 'prepared', 'compressed', 'playbackAcknowledged', 'staleConnection', 'failed', 'ramped'])
// Packets are sampled twice per frame. They only contribute these aggregates;
// event enums and unrelated metadata still use the full sanitizer below.
const PACKET_NUMBERS = new Set([
  'seq', 'bytes', 'sentAtMs', 'scheduledAtMs', 'gapMs', 'latenessMs',
  'generation', 'connectionGeneration', 'pcmBufferedBytes', 'payloadBytes', 'clippedSamples',
  'robotVolumePercent', 'pcmPeak', 'pcmSumSquares', 'pcmSamples', 'pcmNonzeroSamples',
  'pacingCorrectionMs', 'pacingRebaseMs',
])

function safeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e15
    ? Math.round(value * 1000) / 1000 : undefined
}

function packetFieldsOnly(input) {
  const result = {}
  // Enumerating only supplied keys avoids copying producer metadata and walking
  // every event field. As with object spread, inherited/non-enumerable fields
  // are excluded; the two established aliases retain their nullish precedence.
  for (const key of Object.keys(input)) {
    if (PACKET_NUMBERS.has(key)) {
      const value = safeNumber(input[key])
      if (value !== undefined) result[key] = value
    } else if ((key === 'failed' || key === 'staleConnection') && typeof input[key] === 'boolean') {
      result[key] = input[key]
    }
  }
  result.bufferedBytes = safeNumber(input.bufferedBytes ?? input.bufferedAmount)
  result.sendCallbackMs = safeNumber(input.sendCallbackMs ?? input.writeMs)
  return result
}

function normalizeFields(fields = {}) {
  if (!fields || typeof fields !== 'object') return {}
  return { ...fields,
    source: fields.source ?? (fields.role === 'cruise' ? 'point' : fields.role),
    sessionId: fields.sessionId ?? fields.utteranceId,
    sentenceIndex: fields.sentenceIndex ?? fields.index,
    prepareMs: fields.prepareMs ?? fields.preparationMs,
    bufferedBytes: fields.bufferedBytes ?? fields.bufferedAmount,
    sendCallbackMs: fields.sendCallbackMs ?? fields.writeMs,
    offsetBytes: fields.offsetBytes ?? fields.offset,
  }
}

function fieldsOnly(fields = {}) {
  const result = {}
  if (!fields || typeof fields !== 'object') return result
  for (const [key, values] of Object.entries(ENUMS)) {
    if (values.has(fields[key])) result[key] = fields[key]
  }
  for (const key of NUMBERS) {
    const value = fields[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e15) result[key] = Math.round(value * 1000) / 1000
  }
  for (const key of BOOLEANS) if (typeof fields[key] === 'boolean') result[key] = fields[key]
  return result
}

function percentile(values, fraction) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]
}

function batch() {
  return { frames: 0, bytes: 0, maxGapMs: 0, maxLatenessMs: 0, late30Count: 0, late50Count: 0,
    maxBufferedBytes: 0, maxPcmBufferedBytes: 0, maxSendCallbackMs: 0, sequenceGaps: 0, socketWrites: 0, failedWrites: 0,
    staleWrites: 0, maxPayloadBytes: 0, clippedSamples: 0,
    audioDurationMs: 0, cadenceAudioMs: 0, activeSendMs: 0, cadenceSamples: 0,
    pacingCorrections: 0, pacingCorrectionMs: 0, pacingRebases: 0, pacingRebaseMs: 0 }
}

export class AudioDiagnostics {
  constructor({ directory, flushMs = 1000, runtimeMetrics = true }) {
    this.writer = new RollingLog({ directory, name: 'audio-diagnostics.log' })
    this.runId = randomUUID()
    this.startedAt = Date.now()
    this._origin = performance.now()
    this._ids = new Map()
    this._nextId = 0
    this._recentIdValue = undefined
    this._recentId = undefined
    this._previous = new Map()
    this._events = []
    this._batch = batch()
    this._totals = batch()
    this._gaps = []
    this._lastSummary = null
    this._pcmEpoch = 0
    this._pcmBatch = null
    this._closed = false
    this._lastCpu = process.cpuUsage()
    this._lastRuntime = performance.now()
    this._lag = runtimeMetrics ? monitorEventLoopDelay({ resolution: 20 }) : null
    this._lag?.enable()
    this._timer = setInterval(() => this._summarize(), flushMs)
    this._timer.unref?.()
    this.event('runtime')
  }

  _sessionId(value) {
    if (value === undefined || value === null) return undefined
    // Consecutive packets already refer to the newest LRU entry. Avoid a Map
    // delete/set pair while keeping the same eviction order for other sessions.
    if (value === this._recentIdValue) return this._recentId
    // Incoming identifiers may be filenames. Never persist or echo them.
    if (!this._ids.has(value)) {
      if (this._ids.size >= 128) this._ids.delete(this._ids.keys().next().value)
      this._ids.set(value, `s${++this._nextId}`)
    } else {
      // Keep a long utterance's correlation stable while sentence sessions rotate.
      const id = this._ids.get(value)
      this._ids.delete(value)
      this._ids.set(value, id)
    }
    this._recentIdValue = value
    this._recentId = this._ids.get(value)
    return this._recentId
  }

  event(type, fields = {}) {
    const producerType = type
    type = EVENT_ALIASES[type] || type
    if (this._closed || !EVENTS.has(type)) return false
    fields = normalizeFields(fields)
    if (producerType.startsWith('robot_audio_')) fields.destination = 'robot'
    if (producerType === 'robot_audio_read_ahead_wait') fields.reason = 'read-ahead'
    if (producerType === 'cancelled') fields.reason ||= 'cancelled'
    if (producerType === 'completed') fields.reason ||= 'finished'
    const record = {
      schemaVersion: 1, runId: this.runId, ts: Date.now(),
      monoMs: Math.round((performance.now() - this._origin) * 1000) / 1000,
      type, ...fieldsOnly(fields),
    }
    const id = this._sessionId(fields?.sessionId)
    if (id) record.sessionId = id
    const utteranceId = this._sessionId(fields?.utteranceId)
    if (utteranceId) record.utteranceId = utteranceId
    if (['session-start', 'playback-start', 'pause', 'resume', 'stop', 'playback-end', 'boundary', 'handoff',
      'connected', 'disconnected', 'destination-change'].includes(type)) {
      if (id) this._previous.delete(id)
      else this._previous.clear()
      // Keep the last observed sample for a dated summary, but never merge it
      // into PCM measured after this session/playback boundary.
      if (!id || this._pcmBatch?.id === id) this._pcmEpoch++
    }
    this._events.push(record)
    if (this._events.length > 120) this._events.shift()
    this.writer.append(JSON.stringify(record))
    return true
  }

  packet(input = {}) {
    if (this._closed) return
    if (!input || typeof input !== 'object') input = {}
    const fields = packetFieldsOnly(input)
    // The transport reports scheduling and socket completion for the SAME frame.
    // Completion measurements must not double frame/byte counts or gap samples.
    if (Object.prototype.propertyIsEnumerable.call(input, 'stage') && input.stage === 'socket_write') {
      for (const stats of [this._batch, this._totals]) {
        stats.socketWrites++
        stats.failedWrites += fields.failed ? 1 : 0
        stats.staleWrites += fields.staleConnection ? 1 : 0
        stats.maxSendCallbackMs = Math.max(stats.maxSendCallbackMs, fields.sendCallbackMs || 0)
        stats.maxBufferedBytes = Math.max(stats.maxBufferedBytes, fields.bufferedBytes || 0)
        stats.maxPayloadBytes = Math.max(stats.maxPayloadBytes, fields.payloadBytes || 0)
      }
      return
    }
    const id = this._sessionId(input.sessionId ?? input.utteranceId) || 'unassigned'
    this._recordPacketPcm(fields, id)
    const candidate = this._previous.get(id)
    const previous = candidate
      && (candidate.generation === undefined || fields.generation === undefined || candidate.generation === fields.generation)
      && (candidate.connectionGeneration === undefined || fields.connectionGeneration === undefined
        || candidate.connectionGeneration === fields.connectionGeneration) ? candidate : null
    const sent = fields.sentAtMs ?? performance.now()
    const gap = previous ? (fields.gapMs ?? Math.max(0, sent - previous.sent)) : 0
    const late = fields.latenessMs ?? (fields.scheduledAtMs === undefined ? 0 : Math.max(0, sent - fields.scheduledAtMs))
    const seqGap = previous?.seq !== undefined && fields.seq > previous.seq ? Math.max(0, fields.seq - previous.seq - 1) : 0
    if (previous) {
      if (this._gaps.length < 2048) this._gaps.push(gap)
    }
    for (const stats of [this._batch, this._totals]) {
      stats.frames++
      stats.bytes += fields.bytes || 0
      // Robot PCM is 16 kHz, mono, signed 16-bit: 32 bytes per millisecond.
      stats.audioDurationMs += (fields.bytes || 0) / 32
      if (previous?.bytes > 0) {
        // Each gap belongs to the PREVIOUS frame. Comparing all window bytes
        // with wall time would miscount partial windows, pauses and final frames.
        stats.cadenceSamples++
        stats.cadenceAudioMs += previous.bytes / 32
        stats.activeSendMs += gap
      }
      stats.maxGapMs = Math.max(stats.maxGapMs, gap)
      stats.maxLatenessMs = Math.max(stats.maxLatenessMs, late)
      stats.late30Count += gap > 30 ? 1 : 0
      stats.late50Count += gap > 50 ? 1 : 0
      stats.maxBufferedBytes = Math.max(stats.maxBufferedBytes, fields.bufferedBytes || 0)
      stats.maxPcmBufferedBytes = Math.max(stats.maxPcmBufferedBytes, fields.pcmBufferedBytes || 0)
      stats.maxSendCallbackMs = Math.max(stats.maxSendCallbackMs, fields.sendCallbackMs || 0)
      stats.sequenceGaps += seqGap
      stats.clippedSamples += fields.clippedSamples || 0
      // Only the scheduled-send producer reports these decisions. Socket
      // completion samples above must never count the same transition again.
      stats.pacingCorrections += fields.pacingCorrectionMs > 0 ? 1 : 0
      stats.pacingCorrectionMs += fields.pacingCorrectionMs || 0
      stats.pacingRebases += fields.pacingRebaseMs > 0 ? 1 : 0
      stats.pacingRebaseMs += fields.pacingRebaseMs || 0
    }
    if (candidate) {
      candidate.sent = sent
      candidate.seq = fields.seq
      candidate.bytes = fields.bytes
      candidate.generation = fields.generation
      candidate.connectionGeneration = fields.connectionGeneration
    } else {
      if (this._previous.size >= 128) this._previous.delete(this._previous.keys().next().value)
      this._previous.set(id, { sent, seq: fields.seq, bytes: fields.bytes,
        generation: fields.generation, connectionGeneration: fields.connectionGeneration })
    }
    // No per-packet file, console, IPC or WebSocket writes.
  }

  _recordPacketPcm(fields, id) {
    let pcm = this._pcmBatch
    if (pcm && (pcm.id !== id || pcm.epoch !== this._pcmEpoch
      || pcm.generation !== fields.generation || pcm.connectionGeneration !== fields.connectionGeneration)) {
      this._pcmBatch = pcm = null
    }
    const samples = fields.pcmSamples
    const nonzero = fields.pcmNonzeroSamples
    const peak = fields.pcmPeak
    const sumSquares = fields.pcmSumSquares
    // Measurements cover exactly the post-gain PCM frame; partial or malformed
    // metadata must not make unmeasured audio look silent. No samples are kept.
    if (!Number.isInteger(samples) || samples <= 0 || samples !== fields.bytes / 2
      || !Number.isInteger(nonzero) || nonzero < 0 || nonzero > samples
      || !Number.isInteger(peak) || peak < 0 || peak > 32768
      || sumSquares === undefined || sumSquares < peak * peak || sumSquares > peak * peak * nonzero
      || (nonzero === 0 ? peak !== 0 || sumSquares !== 0 : peak === 0)) return
    if (!pcm) {
      this._pcmBatch = pcm = { id, epoch: this._pcmEpoch,
        generation: fields.generation, connectionGeneration: fields.connectionGeneration,
        pcmSamples: 0, pcmNonzeroSamples: 0, pcmPeak: 0, sumSquares: 0 }
    }
    pcm.pcmSamples += samples
    pcm.pcmNonzeroSamples += nonzero
    pcm.pcmPeak = Math.max(pcm.pcmPeak, peak)
    pcm.sumSquares += sumSquares
    if (fields.robotVolumePercent !== undefined) pcm.robotVolumePercent = fields.robotVolumePercent
  }

  _summarize() {
    if (this._closed) return
    if (this._batch.frames || this._batch.socketWrites) {
      const summary = { ...this._batch, capturedAt: Date.now(),
        // Retain run totals in every rolling summary: an export hours later
        // need not contain the startup records. Keep both durations rather
        // than summing positive-only window lag, which ignores later recovery.
        runStartedAt: this.startedAt,
        totalActiveSendMs: this._totals.activeSendMs,
        totalCadenceAudioMs: this._totals.cadenceAudioMs,
        totalCadenceSamples: this._totals.cadenceSamples,
        totalPacingCorrectionMs: this._totals.pacingCorrectionMs,
        totalPacingRebases: this._totals.pacingRebases,
        totalPacingRebaseMs: this._totals.pacingRebaseMs,
        p95GapMs: percentile(this._gaps, 0.95), p99GapMs: percentile(this._gaps, 0.99),
        sendLagMs: Math.max(0, this._batch.activeSendMs - this._batch.cadenceAudioMs),
        ...(this._batch.activeSendMs > 0
          ? { sendRateRatio: this._batch.cadenceAudioMs / this._batch.activeSendMs } : {}),
      }
      if (this._pcmBatch) {
        const pcm = this._pcmBatch
        Object.assign(summary, { pcmSamples: pcm.pcmSamples, pcmNonzeroSamples: pcm.pcmNonzeroSamples,
          pcmPeak: pcm.pcmPeak, pcmRms: Math.sqrt(pcm.sumSquares / pcm.pcmSamples) })
        if (pcm.robotVolumePercent !== undefined) summary.robotVolumePercent = pcm.robotVolumePercent
      }
      // Late socket callbacks still get logged, but must not replace the last
      // meaningful send sample with a zero-frame summary between UI polls.
      if (this._batch.frames) this._lastSummary = summary
      this.event('packet-summary', summary)
      this._batch = batch()
      this._pcmBatch = null
      this._gaps = []
    }
    if (this._lag) {
      const now = performance.now()
      const cpu = process.cpuUsage()
      const cpuPercent = (cpu.user - this._lastCpu.user + cpu.system - this._lastCpu.system) / Math.max(1, now - this._lastRuntime) / 10
      const memory = process.memoryUsage()
      const storage = this.writer.snapshot()
      this.event('runtime', { eventLoopP99Ms: this._lag.percentile(99) / 1e6,
        eventLoopMaxMs: this._lag.max / 1e6, cpuPercent, rssBytes: memory.rss, heapBytes: memory.heapUsed,
        diagnosticDroppedRecords: storage.droppedRecords, diagnosticDiscardedBytes: storage.discardedBytes,
        diagnosticTruncatedRecords: storage.truncatedRecords, diagnosticStoredBytes: storage.storedBytes })
      this._lag.reset()
      this._lastCpu = cpu
      this._lastRuntime = now
    }
  }

  snapshot() {
    return {
      schemaVersion: 1, runId: this.runId, startedAt: this.startedAt, capturedAt: Date.now(),
      storage: this.writer.snapshot(), totals: { ...this._totals },
      lastSummary: this._lastSummary ? { ...this._lastSummary } : null,
      events: this._events.map(event => ({ ...event })),
      note: 'sender-timing-only; robot receive/playout and AV sync are not measured',
    }
  }

  async flush() { this._summarize(); await this.writer.flush() }
  async destroy() {
    clearInterval(this._timer)
    this._summarize()
    this._closed = true
    this._lag?.disable()
    await this.writer.destroy()
  }
}

/** Re-validate persisted data before export; malformed/legacy lines are skipped. */
export async function readAudioHistory({ directory }) {
  const text = await readRollingLog({ directory, name: 'audio-diagnostics.log' })
  const events = []
  for (const line of text.split('\n')) {
    try {
      const event = JSON.parse(line)
      if (!EVENTS.has(event.type) || !Number.isFinite(event.ts)) continue
      const clean = { schemaVersion: 1, type: event.type, ts: event.ts, ...fieldsOnly(event) }
      if (typeof event.runId === 'string' && /^[a-f0-9-]{36}$/.test(event.runId)) clean.runId = event.runId
      for (const key of ['sessionId', 'utteranceId']) {
        if (typeof event[key] === 'string' && /^s\d{1,12}$/.test(event[key])) clean[key] = event[key]
      }
      if (Number.isFinite(event.monoMs) && event.monoMs >= 0) clean.monoMs = event.monoMs
      events.push(clean)
    } catch { /* partial first/last records after truncation or a crash */ }
  }
  return events
}
