import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { randomUUID } from 'node:crypto'
import { RollingLog, readRollingLog } from './rolling-log.js'

const EVENTS = new Set([
  'session-start', 'prepare-start', 'prepared', 'playback-start', 'playback-end',
  'pause', 'resume', 'stop', 'error', 'handoff', 'boundary', 'user-marker',
  'destination-change', 'connected', 'disconnected', 'runtime', 'packet-summary',
  'waiting',
])
const EVENT_ALIASES = {
  sentence_prepared: 'prepared', sentence_wait: 'waiting', sentence_playing: 'playback-start',
  preparation_failed: 'error', 'sentence-boundary': 'boundary', playing: 'playback-start',
  completed: 'playback-end', cancelled: 'stop', audio_cache_ready: 'prepared',
  robot_audio_generation: 'stop', robot_audio_prepared: 'prepared', robot_audio_start: 'playback-start',
  robot_audio_read_ahead_wait: 'waiting', robot_audio_failed: 'error', robot_audio_sent: 'playback-end',
}
const ENUMS = {
  destination: new Set(['local', 'robot']),
  source: new Set(['tts', 'mp3', 'file', 'transit', 'point', 'barrage', 'manual', 'unknown']),
  reason: new Set(['host', 'barrage', 'tour-pause', 'stop', 'skip', 'replacement', 'disconnect', 'destination-change', 'boundary', 'finished', 'cancelled', 'error',
    'preparing', 'sentence-wait', 'ready', 'owner', 'operator', 'tour', 'preparation', 'priority', 'read-ahead']),
  kind: new Set(['tts', 'file', 'mp3']),
  storage: new Set(['memory', 'disk']),
  errorCode: new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'IO_ERROR', 'AUDIO_BACKLOG', 'AUDIO_OWNERSHIP_CONFLICT', 'OTHER']),
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
])
const BOOLEANS = new Set(['connected', 'ducking', 'barrageEnabled', 'ocrEnabled', 'paused', 'prepared', 'compressed', 'playbackAcknowledged', 'staleConnection', 'failed'])

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
    staleWrites: 0, maxPayloadBytes: 0 }
}

export class AudioDiagnostics {
  constructor({ directory, flushMs = 1000, runtimeMetrics = true }) {
    this.writer = new RollingLog({ directory, name: 'audio-diagnostics.log' })
    this.runId = randomUUID()
    this.startedAt = Date.now()
    this._origin = performance.now()
    this._ids = new Map()
    this._nextId = 0
    this._previous = new Map()
    this._events = []
    this._batch = batch()
    this._totals = batch()
    this._gaps = []
    this._lastSummary = null
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
    return this._ids.get(value)
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
    if (['pause', 'resume', 'stop', 'playback-end'].includes(type)) {
      if (id) this._previous.delete(id)
      else this._previous.clear()
    }
    this._events.push(record)
    if (this._events.length > 120) this._events.shift()
    this.writer.append(JSON.stringify(record))
    return true
  }

  packet(input = {}) {
    if (this._closed) return
    input = normalizeFields(input)
    const fields = fieldsOnly(input)
    // The transport reports scheduling and socket completion for the SAME frame.
    // Completion measurements must not double frame/byte counts or gap samples.
    if (input.stage === 'socket_write') {
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
    const id = this._sessionId(input.sessionId) || 'unassigned'
    const previous = this._previous.get(id)
    const sent = fields.sentAtMs ?? performance.now()
    const gap = previous ? (fields.gapMs ?? Math.max(0, sent - previous.sent)) : 0
    const late = fields.latenessMs ?? (fields.scheduledAtMs === undefined ? 0 : Math.max(0, sent - fields.scheduledAtMs))
    const seqGap = previous?.seq !== undefined && fields.seq > previous.seq ? Math.max(0, fields.seq - previous.seq - 1) : 0
    if (this._previous.size >= 128 && !this._previous.has(id)) this._previous.delete(this._previous.keys().next().value)
    this._previous.set(id, { sent, seq: fields.seq })
    if (previous) {
      if (this._gaps.length < 2048) this._gaps.push(gap)
    }
    for (const stats of [this._batch, this._totals]) {
      stats.frames++
      stats.bytes += fields.bytes || 0
      stats.maxGapMs = Math.max(stats.maxGapMs, gap)
      stats.maxLatenessMs = Math.max(stats.maxLatenessMs, late)
      stats.late30Count += gap > 30 ? 1 : 0
      stats.late50Count += gap > 50 ? 1 : 0
      stats.maxBufferedBytes = Math.max(stats.maxBufferedBytes, fields.bufferedBytes || 0)
      stats.maxPcmBufferedBytes = Math.max(stats.maxPcmBufferedBytes, fields.pcmBufferedBytes || 0)
      stats.maxSendCallbackMs = Math.max(stats.maxSendCallbackMs, fields.sendCallbackMs || 0)
      stats.sequenceGaps += seqGap
    }
    // No per-packet file, console, IPC or WebSocket writes.
  }

  _summarize() {
    if (this._closed) return
    if (this._batch.frames || this._batch.socketWrites) {
      this._lastSummary = { ...this._batch, p95GapMs: percentile(this._gaps, 0.95), p99GapMs: percentile(this._gaps, 0.99) }
      this.event('packet-summary', this._lastSummary)
      this._batch = batch()
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
