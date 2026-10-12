import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { RollingLog, readRollingLog } from './rolling-log.js'

export const ROBOT_DIAGNOSTICS_VERSION = 1
const EVENT_LOG = 'robot-diagnostics.log'
const INCIDENT_LOG = 'robot-incidents.log'
const INCIDENT_BYTES = 12 * 1024
const RECENT_EVENTS = 80
const EVENTS = new Set([
  'robot-recorder-start', 'robot-connection-attempt', 'robot-connection-open',
  'robot-connection-error', 'robot-connection-close', 'robot-connection-retry',
  'robot-connection-stopped', 'robot-heartbeat', 'robot-goal-sent',
  'robot-goal-reply', 'robot-goal-heartbeat', 'robot-goal-result',
])
const VALUE_TYPES = new Set(['undefined', 'null', 'string', 'number', 'boolean', 'object', 'array', 'unknown'])
const STATUS = new Set(['ready', 'preparing', 'loading', 'unloaded', 'going', 'done', 'failed', 'faild', 'error', 'idle', 'unknown'])
const ENUMS = {
  direction: new Set(['client', 'server']),
  stage: new Set(['connect', 'socket', 'listen', 'stopped', 'preflight', 'ack', 'arrival']),
  reason: new Set(['connect-error', 'socket-error', 'closed', 'stopped', 'retry',
    'no-pending', 'already-accepted', 'missing-reply', 'path-mismatch', 'goal-id-mismatch',
    'object-mismatch', 'accepted', 'rejected', 'map-missing', 'map-not-ready', 'before-ack',
    'task-missing', 'navigating', 'arrived', 'navigation-failed', 'periodic', 'changed', 'failed']),
  mapStatus: STATUS, goalStatus: STATUS, objectStatus: STATUS,
  errorCode: new Set(['GOAL_ACK_TIMEOUT', 'GOAL_ARRIVAL_TIMEOUT', 'GOAL_REJECTED',
    'GOAL_CANCELLED', 'INVALID_GOAL', 'MAP_NOT_READY', 'NAVIGATION_FAILED', 'ROBOT_DISCONNECTED',
    'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH',
    'ENETDOWN', 'ENOTFOUND', 'EAI_AGAIN', 'EADDRINUSE', 'EADDRNOTAVAIL', 'EACCES', 'EPERM',
    'EPIPE', 'ERR_INVALID_URL', 'ERR_INVALID_PROTOCOL', 'ERR_TLS_CERT_ALTNAME_INVALID',
    'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'WS_ERR_UNEXPECTED_RSV_1', 'WS_ERR_UNEXPECTED_RSV_2_3', 'WS_ERR_INVALID_OPCODE',
    'WS_ERR_EXPECTED_MASK', 'WS_ERR_UNEXPECTED_MASK', 'WS_ERR_INVALID_CONTROL_PAYLOAD_LENGTH',
    'WS_ERR_INVALID_CLOSE_CODE', 'WS_ERR_INVALID_UTF8', 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH',
    'WS_ERR_UNSUPPORTED_DATA_PAYLOAD_LENGTH', 'OTHER']),
}
const NUMBERS = new Set(['attemptId', 'generation', 'commandId', 'elapsedMs', 'uptimeMs',
  'closeCode', 'heartbeatAgeMs', 'retryDelayMs', 'ackTimeoutMs', 'arrivalTimeoutMs',
  'replyCount', 'mismatchCount', 'heartbeatCount', 'lastHeartbeatAgeMs', 'suppressedHeartbeats',
  'expectedGoalId', 'receivedGoalId'])
const BOOLEANS = new Set(['opened', 'pathMatches', 'goalIdMatches', 'objectMatches', 'mapMatches'])
const IDENTITIES = ['expectedMap', 'expectedPath', 'expectedGoalId', 'expectedObject',
  'receivedMap', 'receivedPath', 'receivedGoalId', 'receivedObject']
const ID_KEYS = ['attemptId', 'commandId']
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const HASH = /^[a-f0-9]{24}$/
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e15
const typeOf = value => value === null ? 'null' : Array.isArray(value) ? 'array'
  : VALUE_TYPES.has(typeof value) ? typeof value : 'unknown'

// This whitelist is also applied when reading persisted records. Never export
// raw strings merely because a file claims they were sanitized by an older run.
function safeFields(input = {}) {
  const result = {}
  for (const [key, choices] of Object.entries(ENUMS)) {
    if (choices.has(input[key])) result[key] = input[key]
    else if (Object.hasOwn(input, key) && key.endsWith('Status')) result[key] = 'unknown'
    else if (input[key] != null && key === 'errorCode') result[key] = 'OTHER'
  }
  for (const key of NUMBERS) if (finite(input[key])) {
    if (['attemptId', 'generation', 'commandId', 'expectedGoalId', 'receivedGoalId'].includes(key)
      && !Number.isSafeInteger(input[key])) continue
    result[key] = Math.round(input[key] * 1000) / 1000
  }
  for (const key of BOOLEANS) if (typeof input[key] === 'boolean') result[key] = input[key]
  for (const key of [...IDENTITIES, ...ID_KEYS]) {
    if (VALUE_TYPES.has(input[`${key}Type`])) result[`${key}Type`] = input[`${key}Type`]
    if (Number.isSafeInteger(input[`${key}Length`]) && input[`${key}Length`] >= 0 && input[`${key}Length`] <= 1e9) {
      result[`${key}Length`] = input[`${key}Length`]
    }
    if (typeof input[`${key}Hash`] === 'string' && HASH.test(input[`${key}Hash`])) result[`${key}Hash`] = input[`${key}Hash`]
  }
  if (VALUE_TYPES.has(input.goalCheckType)) result.goalCheckType = input.goalCheckType
  if ([true, false, 'true', 'false', 'unknown'].includes(input.goalCheck)) result.goalCheck = input.goalCheck
  return result
}

function readEvent(input) {
  if (!input || !EVENTS.has(input.type) || !finite(input.ts) || !UUID.test(input.runId || '')) return null
  const event = { schemaVersion: ROBOT_DIAGNOSTICS_VERSION, type: input.type,
    runId: input.runId, ts: input.ts, ...safeFields(input) }
  if (finite(input.monoMs)) event.monoMs = input.monoMs
  if (Number.isSafeInteger(input.seq) && input.seq >= 0) event.seq = input.seq
  return event
}

function failure(event) {
  if (event.type === 'robot-goal-result') {
    return event.errorCode !== 'GOAL_CANCELLED' && (event.reason === 'failed' || Boolean(event.errorCode))
  }
  return event.type === 'robot-connection-error'
    || (event.type === 'robot-connection-close' && event.reason !== 'stopped')
}

function storageState(writer) {
  try {
    if (!writer) return { status: 'error', errorCode: 'IO_ERROR' }
    const state = writer?.snapshot?.() || {}
    const safe = { status: ['recording', 'initializing', 'error'].includes(state.status) ? state.status : 'error' }
    for (const key of ['capBytes', 'storedBytes', 'queuedBytes', 'droppedRecords', 'discardedBytes', 'truncatedRecords']) {
      if (finite(state[key])) safe[key] = state[key]
    }
    safe.errorCode = state.errorCode == null ? null :
      new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'EROFS', 'EIO', 'UNSAFE_LOG_PATH']).has(state.errorCode)
        ? state.errorCode : 'IO_ERROR'
    return safe
  } catch { return { status: 'error', errorCode: 'IO_ERROR' } }
}

export class RobotDiagnostics {
  constructor({ directory, writerFactory = options => new RollingLog(options),
    clock = Date.now, monotonic = () => performance.now() } = {}) {
    this.runId = randomUUID()
    this.startedAt = clock()
    this._clock = clock
    this._monotonic = monotonic
    this._origin = monotonic()
    this._key = randomBytes(32)
    this._seq = 0
    this._events = []
    this._anchors = new Map()
    this._incidents = new Map()
    this._incidentCounter = 0
    this._heartbeatSignatures = new Map()
    this._heartbeatWindow = { start: 0, count: 0 }
    this._suppressedHeartbeats = 0
    this._closed = false
    // A recorder must never prevent robot control from starting, including when
    // the diagnostics directory is unavailable or a storage adapter fails.
    try { this.writer = writerFactory({ directory, name: EVENT_LOG }) } catch {}
    try { this.incidentWriter = writerFactory({ directory, name: INCIDENT_LOG }) } catch {}
    this.event('robot-recorder-start')
  }

  _identity(value) {
    const result = { Type: typeOf(value) }
    if (typeof value === 'string') result.Length = Math.min(value.length, 1e9)
    if (value === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof value)) {
      // Bounded primitive inputs only; do not stringify arbitrary robot objects.
      // Type participates in the digest, retaining number/string distinctions.
      const text = String(value)
      if (text.length <= 4096) result.Hash = createHmac('sha256', this._key)
        .update(`${result.Type}:${text}`).digest('hex').slice(0, 24)
    }
    return result
  }

  _fields(input) {
    const fields = safeFields(input)
    for (const key of [...IDENTITIES, ...ID_KEYS]) {
      if (!Object.hasOwn(input, key)) continue
      for (const [suffix, value] of Object.entries(this._identity(input[key]))) fields[key + suffix] = value
      if (key.endsWith('GoalId') && typeof input[key] === 'string' && /^\d{1,15}$/.test(input[key])) {
        fields[key] = Number(input[key])
      }
    }
    if (Object.hasOwn(input, 'goalCheck')) {
      fields.goalCheckType = typeOf(input.goalCheck)
      fields.goalCheck = [true, false, 'true', 'false'].includes(input.goalCheck) ? input.goalCheck : 'unknown'
    }
    return fields
  }

  _heartbeatAllowed(record) {
    if (!['robot-heartbeat', 'robot-goal-heartbeat'].includes(record.type)) return true
    const now = record.monoMs
    if (now - this._heartbeatWindow.start >= 10000) this._heartbeatWindow = { start: now, count: 0 }
    const key = `${record.type}:${record.commandId ?? record.commandIdHash ?? ''}:${record.attemptId ?? ''}`
    const signature = JSON.stringify(Object.fromEntries(Object.entries(record).filter(([name]) =>
      !['seq', 'ts', 'monoMs', 'elapsedMs', 'uptimeMs', 'heartbeatCount', 'lastHeartbeatAgeMs',
        'heartbeatAgeMs', 'replyCount', 'mismatchCount', 'suppressedHeartbeats', 'reason'].includes(name))))
    const last = this._heartbeatSignatures.get(key)
    if (this._heartbeatWindow.count >= 20 || (last?.signature === signature && now - last.time < 10000)) {
      this._suppressedHeartbeats++
      return false
    }
    this._heartbeatWindow.count++
    if (this._heartbeatSignatures.size >= 80) this._heartbeatSignatures.delete(this._heartbeatSignatures.keys().next().value)
    this._heartbeatSignatures.set(key, { signature, time: now })
    return true
  }

  event(type, input = {}) {
    try {
      if (this._closed || !EVENTS.has(type) || !input || typeof input !== 'object') return false
      const record = { schemaVersion: ROBOT_DIAGNOSTICS_VERSION, type, runId: this.runId,
        seq: ++this._seq, ts: this._clock(), monoMs: Math.max(0, this._monotonic() - this._origin),
        ...this._fields(input) }
      if (!this._heartbeatAllowed(record)) return false
      record.suppressedHeartbeats = this._suppressedHeartbeats
      this._events.push(record)
      if (this._events.length > RECENT_EVENTS) this._events.shift()
      if (['robot-goal-sent', 'robot-goal-reply', 'robot-connection-attempt', 'robot-connection-open'].includes(type)) {
        const anchorKey = `${type}:${type.startsWith('robot-goal-')
          ? record.commandId ?? record.commandIdHash ?? '' : record.attemptId ?? record.attemptIdHash ?? ''}`
        this._anchors.delete(anchorKey)
        this._anchors.set(anchorKey, record)
        if (this._anchors.size > 16) this._anchors.delete(this._anchors.keys().next().value)
      }
      try { this.writer?.append(JSON.stringify(record))?.catch?.(() => {}) } catch {}
      if (failure(record)) this._captureIncident(record)
      return true
    } catch { return false }
  }

  _captureIncident(trigger) {
    const key = trigger.type === 'robot-goal-result'
      ? `goal:${trigger.commandId ?? trigger.commandIdHash ?? trigger.seq}`
      : `connection:${trigger.attemptId ?? trigger.attemptIdHash ?? trigger.seq}`
    const existing = this._incidents.get(key)
    // A long wait may outlive the recent-event ring. Keep the command and its
    // most recent reply, plus the matching connection's opening evidence.
    const anchors = [...this._anchors.values()].filter(event => event.type.startsWith('robot-goal-')
      ? trigger.type === 'robot-goal-result' && (trigger.commandId !== undefined
        ? event.commandId === trigger.commandId : trigger.commandIdHash && event.commandIdHash === trigger.commandIdHash)
      : trigger.attemptId !== undefined ? event.attemptId === trigger.attemptId
        : trigger.attemptIdHash && event.attemptIdHash === trigger.attemptIdHash)
    const protectedSeqs = new Set(anchors.map(event => event.seq))
    const context = [...new Map([...anchors, ...this._events].map(event => [event.seq, event])).values()]
      .sort((a, b) => a.seq - b.seq)
    const incident = { schemaVersion: ROBOT_DIAGNOSTICS_VERSION, runId: this.runId,
      incidentId: existing?.incidentId || `${this.runId}:${++this._incidentCounter}`,
      ts: trigger.ts, trigger, events: context }
    let encoded = JSON.stringify(incident)
    while ((Buffer.byteLength(encoded) > INCIDENT_BYTES || incident.events.length > RECENT_EVENTS) && incident.events.length) {
      const disposable = incident.events.findIndex(event => !protectedSeqs.has(event.seq))
      incident.events.splice(disposable < 0 ? 0 : disposable, 1)
      encoded = JSON.stringify(incident)
    }
    this._incidents.delete(key)
    this._incidents.set(key, incident)
    if (this._incidents.size > 16) this._incidents.delete(this._incidents.keys().next().value)
    try { this.incidentWriter?.append(encoded)?.catch?.(() => {}) } catch {}
  }

  snapshot() {
    return { schemaVersion: ROBOT_DIAGNOSTICS_VERSION, runId: this.runId, startedAt: this.startedAt,
      storage: storageState(this.writer), incidentStorage: storageState(this.incidentWriter),
      suppressedHeartbeats: this._suppressedHeartbeats,
      events: this._events.map(event => ({ ...event })),
      incidents: [...this._incidents.values()].map(incident => ({ ...incident,
        trigger: { ...incident.trigger }, events: incident.events.map(event => ({ ...event })) })) }
  }

  async flush() {
    await Promise.allSettled([this.writer, this.incidentWriter].map(async writer => { await writer?.flush() }))
  }

  async destroy() {
    this._closed = true
    await Promise.allSettled([this.writer, this.incidentWriter].map(async writer => { await writer?.destroy() }))
  }
}

export async function readRobotHistory({ directory }) {
  const text = await readRollingLog({ directory, name: EVENT_LOG })
  const events = []
  for (const line of text.split('\n')) {
    try { const event = readEvent(JSON.parse(line)); if (event) events.push(event) } catch {}
  }
  return events
}

export async function readRobotIncidents({ directory }) {
  const text = await readRollingLog({ directory, name: INCIDENT_LOG })
  const incidents = new Map()
  for (const line of text.split('\n')) {
    try {
      if (Buffer.byteLength(line) > INCIDENT_BYTES) continue
      const input = JSON.parse(line)
      const trigger = readEvent(input.trigger)
      if (!trigger || !failure(trigger) || input.runId !== trigger.runId || !finite(input.ts)
        || typeof input.incidentId !== 'string'
        || !new RegExp(`^${trigger.runId}:\\d{1,12}$`).test(input.incidentId)) continue
      const events = Array.isArray(input.events) ? input.events.slice(-RECENT_EVENTS)
        .map(readEvent).filter(event => event && event.runId === trigger.runId && event.ts <= trigger.ts) : []
      const incident = { schemaVersion: ROBOT_DIAGNOSTICS_VERSION, runId: trigger.runId,
        incidentId: input.incidentId, ts: input.ts, trigger, events }
      incidents.delete(incident.incidentId)
      incidents.set(incident.incidentId, incident)
    } catch { /* partial, hostile or obsolete persisted records are excluded */ }
  }
  return [...incidents.values()].slice(-32)
}

/** Findings describe observed protocol facts, never the robot's presumed cause. */
export function robotDiagnosticFindings(events, incidents) {
  const unique = new Map()
  for (const event of [...events, ...incidents.flatMap(incident => [...incident.events, incident.trigger])]) {
    unique.set(`${event.runId}:${event.seq ?? event.ts}:${event.type}`, event)
  }
  const findings = new Map()
  const add = (code, summary, event) => {
    const previous = findings.get(code)
    const evidence = { runId: event.runId, ts: event.ts, type: event.type }
    for (const key of ['seq', 'attemptId', 'commandId', 'stage', 'errorCode', 'heartbeatCount',
      'lastHeartbeatAgeMs', 'replyCount', 'mismatchCount', 'pathMatches', 'goalIdMatches', 'objectMatches']) {
      if (event[key] !== undefined) evidence[key] = event[key]
    }
    findings.set(code, { code, summary, count: (previous?.count || 0) + 1,
      evidence: [...(previous?.evidence || []), evidence].slice(-5) })
  }
  for (const event of unique.values()) {
    if (['robot-connection-close', 'robot-connection-error'].includes(event.type)) {
      if (event.opened === false && event.stage !== 'listen') {
        add('CONNECTION_NOT_ESTABLISHED', '连接尝试结束或报错前，没有记录到 WebSocket 建立成功；不能据此判定具体网络原因。', event)
      } else if (event.type === 'robot-connection-close' && event.opened === true) {
        add('ESTABLISHED_CONNECTION_CLOSED', '曾建立成功的机器人连接随后关闭；关闭记录不等同于机器人程序故障。', event)
      } else if (event.type === 'robot-connection-error') {
        add('CONNECTION_ERROR', '机器人连接或监听出现错误；请结合错误代码和同次连接事件判断。', event)
      }
    }
    if (event.type === 'robot-goal-reply' && ['path-mismatch', 'goal-id-mismatch', 'object-mismatch'].includes(event.reason)) {
      add('GOAL_REPLY_MISMATCH', '收到目标回复，但路径、点位或对象未匹配当前指令，因此未接受这次确认。', event)
    }
    if (event.type !== 'robot-goal-result') continue
    if (event.errorCode === 'GOAL_ACK_TIMEOUT') {
      add(event.heartbeatCount > 0 ? 'ACK_TIMEOUT_WITH_HEARTBEATS' : 'GOAL_ACK_TIMEOUT',
        event.heartbeatCount > 0
          ? '等待目标确认期间仍收到机器人心跳，但未在时限内收到被程序接受的目标确认。'
          : '目标确认等待超时；记录不足以将原因归为网络中断或机器人程序故障。', event)
    } else if (event.errorCode === 'GOAL_ARRIVAL_TIMEOUT') {
      add('GOAL_ARRIVAL_TIMEOUT', '目标已确认，但在到达时限内没有收到符合条件的到达状态。', event)
    } else if (event.errorCode === 'GOAL_REJECTED') {
      add('GOAL_REJECTED', '机器人返回了匹配目标的回复，但未确认该目标有效。', event)
    } else if (event.errorCode === 'MAP_NOT_READY') {
      add('MAP_NOT_READY', '目标处理因地图名称、就绪状态或心跳时效不满足要求而结束。', event)
    } else if (event.errorCode === 'NAVIGATION_FAILED') {
      add('NAVIGATION_FAILED', '机器人心跳报告当前目标导航失败；记录未提供失败的底层原因。', event)
    }
  }
  return [...findings.values()]
}
