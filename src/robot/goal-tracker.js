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

export class GoalTracker {
  constructor({ send, emit, getMapState, ackTimeoutMs = 5000, arrivalTimeoutMs = 180000 }) {
    this.send = send
    this.emit = emit
    this.getMapState = getMapState
    this.ackTimeoutMs = ackTimeoutMs
    this.arrivalTimeoutMs = arrivalTimeoutMs
    this.pending = null
  }

  start(item, { signal } = {}) {
    this.cancel()
    if (signal?.aborted) throw new GoalError('GOAL_CANCELLED', '目标点等待已取消')
    if (!item.map_name || !item.path_name || !Number.isInteger(item.goal_id) || item.goal_id < 1) {
      throw new GoalError('INVALID_GOAL', '目标点的地图、路径或点位 ID 无效')
    }
    const map = this.getMapState()
    if (map.name !== item.map_name || map.status !== 'ready' || map.ageMs > 10000) {
      throw new GoalError('MAP_NOT_READY', `目标地图为 ${item.map_name}，机器人当前地图为 ${map.name || '未知'}，且必须有最近的 ready 心跳；未发送目标点，请先确认地图`)
    }

    return new Promise((resolve, reject) => {
      const pending = { item: { ...item }, accepted: false, resolve, reject, signal }
      this.pending = pending
      pending.abort = () => this._finish(pending, new GoalError('GOAL_CANCELLED', '目标点等待已取消'))
      signal?.addEventListener('abort', pending.abort, { once: true })
      pending.timer = setTimeout(() => this._finish(pending,
        new GoalError('GOAL_ACK_TIMEOUT', `等待目标点确认超时: ${item.path_name}/${item.goal_id}`)), this.ackTimeoutMs)
      try {
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
    if (!pending || pending.accepted || !data) return
    const item = pending.item
    if (data.path_file !== item.path_name || !sameId(data.goal_id, item.goal_id) ||
        objectName(data.goal_object) !== objectName(item.goal_object)) return
    if (data.goal_check !== true && data.goal_check !== 'true') {
      this._finish(pending, new GoalError('GOAL_REJECTED', `机器人未确认目标点存在: ${item.path_name}/${item.goal_id}`))
      return
    }
    pending.accepted = true
    clearTimeout(pending.timer)
    pending.timer = setTimeout(() => this._finish(pending,
      new GoalError('GOAL_ARRIVAL_TIMEOUT', `等待目标点到达超时: ${item.path_name}/${item.goal_id}；请检查机器人心跳的地图、路径和点位 ID`)), this.arrivalTimeoutMs)
    this.emit('goal-accepted', { ...item })
  }

  handleHeartbeat(msg) {
    const pending = this.pending
    if (!pending) return
    const { map, task } = msg
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
    if (error) {
      pending.reject(error)
    } else {
      pending.resolve(result)
      this.emit('goal-reached', result)
    }
  }
}
