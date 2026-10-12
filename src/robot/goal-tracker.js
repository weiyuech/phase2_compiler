// Navigation transactions are local bookkeeping only. The hardware JSON protocol
// has no request ID, so never add one to outgoing messages without robot support.
export class GoalError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

const sameId = (a, b) => a != null && b != null && String(a) === String(b)
const objectName = value => value == null ? '' : String(value)
const valueType = value => value === null ? 'null' : typeof value
const identity = (data, prefix, pathKey = 'path_file') => ({
  [`${prefix}Map`]: data?.map_name,
  [`${prefix}Path`]: data?.[pathKey],
  [`${prefix}GoalId`]: data?.goal_id,
  [`${prefix}Object`]: data?.goal_object,
  [`${prefix}PathType`]: valueType(data?.[pathKey]),
  [`${prefix}GoalIdType`]: valueType(data?.goal_id),
  [`${prefix}ObjectType`]: valueType(data?.goal_object),
})

export class GoalTracker {
  constructor({ send, emit, getMapState, ackTimeoutMs = 5000, arrivalTimeoutMs = 180000, diagnostics }) {
    this.send = send
    this.emit = emit
    this.getMapState = getMapState
    this.ackTimeoutMs = ackTimeoutMs
    this.arrivalTimeoutMs = arrivalTimeoutMs
    this.pending = null
    this.diagnostics = diagnostics
    this._commandId = 0
  }

  _diagnostic(type, fields) {
    try { this.diagnostics?.event?.(type, fields)?.catch?.(() => {}) } catch {}
  }

  _evidence(pending) {
    return {
      commandId: pending.commandId,
      ...identity(pending.item, 'expected', 'path_name'),
      stage: pending.accepted ? 'arrival' : 'ack',
      elapsedMs: Math.round(performance.now() - pending.startedAt),
      replyCount: pending.replyCount, mismatchCount: pending.mismatchCount,
      heartbeatCount: pending.heartbeatCount,
      lastHeartbeatAgeMs: pending.lastHeartbeatAt == null ? null : Math.round(performance.now() - pending.lastHeartbeatAt),
      ...pending.lastHeartbeat,
    }
  }

  recordRejectedStart(item, error, { commandId = ++this._commandId, map, startedAt = performance.now() } = {}) {
    // Rejections before dispatch need an incident too, but must never look like
    // a command was sent or cancel an existing transaction in the listener.
    try {
      if (!map) { try { map = this.getMapState() } catch {} }
      this._diagnostic('robot-goal-result', {
        commandId, ...identity(item, 'expected', 'path_name'),
        receivedMap: map?.name, mapStatus: map?.status,
        heartbeatAgeMs: Number.isFinite(map?.ageMs) ? map.ageMs : null,
        stage: 'preflight', reason: 'failed', errorCode: error?.code,
        elapsedMs: Math.round(performance.now() - startedAt),
        replyCount: 0, mismatchCount: 0, heartbeatCount: 0, lastHeartbeatAgeMs: null,
      })
    } catch { /* Preserve the original rejection even if observation fails. */ }
  }

  start(item, { signal } = {}) {
    this.cancel()
    const commandId = ++this._commandId, startedAt = performance.now()
    let map
    try {
      if (signal?.aborted) throw new GoalError('GOAL_CANCELLED', '目标点等待已取消')
      if (!item.map_name || !item.path_name || !Number.isInteger(item.goal_id) || item.goal_id < 1) {
        throw new GoalError('INVALID_GOAL', '目标点的地图、路径或点位 ID 无效')
      }
      map = this.getMapState()
      if (map.name !== item.map_name || map.status !== 'ready' || map.ageMs > 10000) {
        throw new GoalError('MAP_NOT_READY', `目标地图为 ${item.map_name}，机器人当前地图为 ${map.name || '未知'}，且必须有最近的 ready 心跳；未发送目标点，请先确认地图`)
      }
    } catch (error) {
      this.recordRejectedStart(item, error, { commandId, map, startedAt })
      throw error
    }

    return new Promise((resolve, reject) => {
      const pending = {
        item: { ...item }, accepted: false, resolve, reject, signal,
        commandId, startedAt,
        replyCount: 0, mismatchCount: 0, heartbeatCount: 0,
        lastHeartbeatAt: null, lastHeartbeat: null, lastHeartbeatKey: null, lastDiagnosticAt: null,
      }
      this.pending = pending
      pending.abort = () => this._finish(pending, new GoalError('GOAL_CANCELLED', '目标点等待已取消'))
      signal?.addEventListener('abort', pending.abort, { once: true })
      pending.timer = setTimeout(() => this._finish(pending,
        new GoalError('GOAL_ACK_TIMEOUT', `等待目标点确认超时: ${item.path_name}/${item.goal_id}`)), this.ackTimeoutMs)
      try {
        // This ID only correlates local diagnostics; the robot payload is unchanged.
        this._diagnostic('robot-goal-sent', {
          ...this._evidence(pending), ackTimeoutMs: this.ackTimeoutMs, arrivalTimeoutMs: this.arrivalTimeoutMs,
        })
        // map_name is checked locally, but is NOT a field in the set_goal protocol.
        const { path_name, goal_id, goal_object } = item
        if (!this.send({ set_goal: { path_name, goal_id, goal_object } })) {
          throw new GoalError('ROBOT_DISCONNECTED', '机器人未连接，未发送目标点')
        }
      } catch (err) {
        this._finish(pending, err)
      }
    })
  }

  handleReply(data) {
    const pending = this.pending
    if (pending) pending.replyCount++
    const evidence = {
      ...(pending ? this._evidence(pending) : {}), ...identity(data, 'received'),
      goalCheck: data?.goal_check,
    }
    if (!pending || pending.accepted || !data) {
      this._diagnostic('robot-goal-reply', { ...evidence,
        reason: !pending ? 'no-pending' : pending.accepted ? 'already-accepted' : 'missing-reply' })
      return
    }
    const item = pending.item
    const matches = {
      pathMatches: data.path_file === item.path_name,
      goalIdMatches: sameId(data.goal_id, item.goal_id),
      objectMatches: objectName(data.goal_object) === objectName(item.goal_object),
    }
    if (!matches.pathMatches || !matches.goalIdMatches || !matches.objectMatches) {
      pending.mismatchCount++
      this._diagnostic('robot-goal-reply', { ...evidence, ...matches, mismatchCount: pending.mismatchCount,
        reason: !matches.pathMatches ? 'path-mismatch' : !matches.goalIdMatches ? 'goal-id-mismatch' : 'object-mismatch' })
      return
    }
    if (data.goal_check !== true && data.goal_check !== 'true') {
      this._diagnostic('robot-goal-reply', { ...evidence, ...matches, reason: 'rejected' })
      this._finish(pending, new GoalError('GOAL_REJECTED', `机器人未确认目标点存在: ${item.path_name}/${item.goal_id}`))
      return
    }
    pending.accepted = true
    this._diagnostic('robot-goal-reply', { ...evidence, ...matches, reason: 'accepted' })
    clearTimeout(pending.timer)
    pending.timer = setTimeout(() => this._finish(pending,
      new GoalError('GOAL_ARRIVAL_TIMEOUT', `等待目标点到达超时: ${item.path_name}/${item.goal_id}；请检查机器人心跳的地图、路径和点位 ID`)), this.arrivalTimeoutMs)
    this.emit('goal-accepted', { ...item })
  }

  handleHeartbeat(msg) {
    const pending = this.pending
    if (!pending) return
    const { map, task } = msg
    pending.heartbeatCount++
    pending.lastHeartbeatAt = performance.now()
    pending.lastHeartbeat = {
      ...identity({ ...task, map_name: map?.name }, 'received'),
      mapStatus: map?.status, goalStatus: task?.goal_status, objectStatus: task?.object_status,
    }
    const reason = !map ? 'map-missing'
      : map.name !== pending.item.map_name || map.status !== 'ready' ? 'map-not-ready'
        : !pending.accepted ? 'before-ack' : !task ? 'task-missing'
          : task.path_file !== pending.item.path_name ? 'path-mismatch'
            : !sameId(task.goal_id, pending.item.goal_id) ? 'goal-id-mismatch'
              : task.goal_status === 'done' ? 'arrived'
                : ['failed', 'faild'].includes(task.goal_status) ? 'navigation-failed' : 'navigating'
    // Do not log every 1 Hz heartbeat. Keep transitions and a ten-second summary;
    // every result also includes the latest heartbeat and total count.
    try {
      const key = JSON.stringify({ ...pending.lastHeartbeat, reason })
      if (key !== pending.lastHeartbeatKey || performance.now() - pending.lastDiagnosticAt >= 10000) {
        pending.lastHeartbeatKey = key
        pending.lastDiagnosticAt = performance.now()
        this._diagnostic('robot-goal-heartbeat', { ...this._evidence(pending), reason })
      }
    } catch { /* Malformed diagnostic values must not affect navigation. */ }
    if (!map) return
    if (map.name !== pending.item.map_name || map.status !== 'ready') {
      this._finish(pending, new GoalError('MAP_NOT_READY', '导航期间机器人地图发生变化或定位未就绪，巡游已暂停'))
      return
    }
    // Never reuse a pre-ack completion or relabel another target's status. A
    // matching post-ack done is sufficient: going is NOT required (fast arrival).
    if (!pending.accepted || !task || task.path_file !== pending.item.path_name ||
        !sameId(task.goal_id, pending.item.goal_id)) return
    const status = task.goal_status
    if (status === 'failed' || status === 'faild') {
      this._finish(pending, new GoalError('NAVIGATION_FAILED', `导航失败: ${task.path_file}/${task.goal_id}`))
    } else if (status === 'done') {
      // Revised business rule: object_status never gates narration, including
      // going, failed/faild, missing, and done. Only navigation must be done.
      this._finish(pending, null, {
        map_name: map.name, path_file: task.path_file, goal_id: Number(task.goal_id),
      })
    }
  }

  cancel(error = new GoalError('GOAL_CANCELLED', '目标点等待已取消')) {
    if (this.pending) this._finish(this.pending, error)
  }

  _finish(pending, error, result) {
    if (this.pending !== pending) return
    this.pending = null
    clearTimeout(pending.timer)
    pending.signal?.removeEventListener('abort', pending.abort)
    this._diagnostic('robot-goal-result', { ...this._evidence(pending),
      reason: error ? 'failed' : 'arrived', errorCode: error?.code })
    if (error) {
      pending.reject(error)
    } else {
      pending.resolve(result)
      this.emit('goal-reached', result)
    }
  }
}
