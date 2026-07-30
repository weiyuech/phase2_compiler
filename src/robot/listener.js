import { WebSocketServer, WebSocket } from 'ws'
import { EventEmitter }    from 'events'

/**
 * RobotListener
 *
 * Events emitted:
 *   'goal-reached'  ({ map_name, path_file, goal_id })  — triggered once when
 *                   heartbeat shows goal_status 'done' (object_status shown in UI but not required)
 *   'heartbeat'     (rawMsg)   — every heartbeat, for status monitoring
 *   'reply'         ({ type, data })  — replies to sent commands
 *                   types: 'map_list' | 'switch_map' | 'path_list' | 'goal'
 *   'connected'     ()
 *   'disconnected'  ()
 */
export class RobotListener extends EventEmitter {
  constructor({ port = 8765, url = null } = {}) {
    super()
    this.port            = port
    this.url             = url
    this.wss             = null
    this._socket         = null   // single-robot assumption
    this._lastTriggered  = null   // prevents duplicate goal-reached for same point
    this._pendingGoal    = null   // the goal we sent; used as authoritative source in trigger
    this._requireNonDone = false  // after sendSetGoal, wait for a non-done heartbeat first
    this.lastMapName     = null
    this.lastMapStatus   = null
    this._lastStatusStr  = ''
    this._reconnectTimer = null
  }

  start() {
    if (this.url) {
      this._connectAsClient()
    } else {
      this.wss = new WebSocketServer({ port: this.port })

      this.wss.on('listening', () => {
        console.log(`[机器人] 等待连接，端口 ${this.port}`)
      })

      // 服务端级别的 'error' 没人监听会变成未捕获异常，把整个后端一起带走。
      // 机器人端口占用只应该让机器人连接失效，播报 / 巡游 / 控制台通道要照常工作。
      this.wss.on('error', (err) => {
        console.error(
          err.code === 'EADDRINUSE'
            ? `[机器人] 端口 ${this.port} 已被占用，机器人监听未启动（其余功能不受影响）`
            : `[机器人] 监听服务错误: ${err.message}`
        )
      })

      this.wss.on('connection', (socket) => {
        console.log('[机器人] 已连接')
        this._socket         = socket
        this._lastTriggered  = null
        this._pendingGoal    = null
        this._requireNonDone = false
        this.lastMapName     = null
        this.lastMapStatus   = null
        this.emit('connected')

        socket.on('message', (raw) => {
          let msg
          try {
            msg = JSON.parse(raw.toString())
          } catch {
            return
          }
          this._handleMessage(msg)
        })

        socket.on('close', () => {
          console.log('[机器人] 连接断开')
          this._socket = null
          this.lastMapName     = null
          this.lastMapStatus   = null
          this.emit('disconnected')
        })

        socket.on('error', (err) => {
          console.error('[机器人] 连接错误:', err.message)
        })
      })
    }
  }

  _connectAsClient() {
    if (this._socket) {
      try { this._socket.close() } catch {}
      this._socket = null
    }
    console.log(`[机器人] 正在连接 WS 服务: ${this.url}`)
    
    let socket
    try {
      socket = new WebSocket(this.url)
    } catch (err) {
      console.log('[机器人] 创建 WebSocket 失败:', err.message)
      this._reconnect()
      return
    }

    socket.on('open', () => {
      console.log('[机器人] 连接成功')
      this._socket         = socket
      this._lastTriggered  = null
      this._pendingGoal    = null
      this._requireNonDone = false
      this.lastMapName     = null
      this.lastMapStatus   = null
      this.emit('connected')
    })

    socket.on('message', (raw) => {
      let msg
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      this._handleMessage(msg)
    })

    socket.on('close', () => {
      console.log('[机器人] 连接断开/关闭')
      const wasConnected = !!this._socket
      this._socket = null
      this.lastMapName     = null
      this.lastMapStatus   = null
      if (wasConnected) {
        this.emit('disconnected')
      }
      this._reconnect()
    })

    socket.on('error', (err) => {
      console.log('[机器人] 连接错误:', err.message)
    })
  }

  _reconnect() {
    if (this._reconnectTimer) return
    console.log('[机器人] 5秒后尝试重新连接...')
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null
      this._connectAsClient()
    }, 5000)
  }

  stop() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer)
      this._reconnectTimer = null
    }
    if (this.wss) this.wss.close()
    if (this._socket && this.url) {
      try { this._socket.close() } catch {}
      this._socket = null
    }
  }

  // ── Commands ───────────────────────────────────────────────────────────────

  sendGetMapList() {
    this._send({ get_map_list: 'all' })
  }

  sendSwitchMap(mapName) {
    this._send({ set_switch_map: mapName })
  }

  sendGetPathList(mapName) {
    this._send({ get_path_list: mapName })
  }

  sendSetGoal({ path_name, goal_id, goal_object }) {
    this._lastTriggered  = null                           // reset so new goal can trigger goal-reached
    this._pendingGoal    = { path_name, goal_id, goal_object } // Store goal_object to check if alignment is needed
    this._requireNonDone = true                           // must see a non-done heartbeat before next trigger
    this._send({ set_goal: { path_name, goal_id, goal_object } })
  }

  /**
   * Returns a Promise that resolves when the heartbeat confirms the robot is on
   * the target map AND map.status === 'ready'. Works for both different-map switches
   * (which go through 'preparing') and same-map no-ops (which stay 'ready').
   */
  waitForMapReady(mapName, timeoutMs = 180000) {
    return new Promise((resolve, reject) => {
      if (this.lastMapName === mapName && this.lastMapStatus === 'ready') {
        resolve()
        return
      }

      const timer = setTimeout(() => {
        this.off('heartbeat', handler)
        reject(new Error('等待地图切换完成超时'))
      }, timeoutMs)

      const handler = (msg) => {
        const name = msg.map?.name
        const status = msg.map?.status
        if (name === mapName && status === 'ready') {
          clearTimeout(timer)
          this.off('heartbeat', handler)
          resolve()
        }
      }
      this.on('heartbeat', handler)
    })
  }

  /**
   * Returns a Promise that resolves with the reply data when a reply of the
   * given type arrives, or rejects on timeout.
   * types: 'map_list' | 'switch_map' | 'path_list' | 'goal'
   */
  waitForReply(type, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('reply', handler)
        reject(new Error(`等待机器人回复超时 (${type})`))
      }, timeoutMs)

      const handler = (reply) => {
        if (reply.type === type) {
          clearTimeout(timer)
          this.off('reply', handler)
          resolve(reply.data)
        }
      }
      this.on('reply', handler)
    })
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  _send(obj) {
    if (!this._socket) {
      console.warn('[机器人] 尚未连接，无法发送指令')
      return
    }
    this._socket.send(JSON.stringify(obj))
  }

  _handleMessage(msg) {
    if ('robot_map_list' in msg) {
      this.emit('reply', { type: 'map_list', data: msg.robot_map_list })
    } else if ('robot_switch_map' in msg) {
      this.emit('reply', { type: 'switch_map', data: msg.robot_switch_map })
    } else if ('robot_path_list' in msg) {
      this.emit('reply', { type: 'path_list', data: msg.robot_path_list })
    } else if ('robot_goal' in msg) {
      this.emit('reply', { type: 'goal', data: msg.robot_goal })
    } else if ('system' in msg && 'task' in msg) {
      this._handleHeartbeat(msg)
    }
  }

  _handleHeartbeat(msg) {
    this.emit('heartbeat', msg)

    const { task, map } = msg
    if (map) {
      this.lastMapName = map.name
      this.lastMapStatus = map.status
    }
    if (!task || !map) return

    // Log status transitions in backend.log to verify robot arrival state
    const currentStatusStr = `goal: ${task.goal_status}, object: ${task.object_status}`
    if (currentStatusStr !== this._lastStatusStr) {
      console.log(`[机器人状态变更] ${currentStatusStr} (地图: ${map.name}, 路径: ${task.path_file || '无'}, 目标点: ${task.goal_id ?? '无'})`)
      this._lastStatusStr = currentStatusStr
    }

    if (task.goal_status !== 'done' && task.goal_status !== 'failed') {
      // Robot is actively navigating (or idle) — safe to accept the next arrival
      this._requireNonDone = false
      return
    }

    if (!this._pendingGoal) return        // no goal was dispatched; ignore idle status state
    if (this._requireNonDone) return      // still seeing stale status from previous goal; skip

    // If object alignment is in progress, wait for it to complete (either 'done' or 'failed')
    // Skip directly if no goal_object was specified for this point (null, undefined, or empty)
    if (this._pendingGoal.goal_object && task.object_status === 'going') {
      return
    }

    // Use the values we SENT (stored in _pendingGoal) rather than what the robot
    // echoes back in path_file/goal_id — at the moment goal_status first becomes
    // 'done' the robot firmware may not have settled those fields yet.
    const { path_name, goal_id } = this._pendingGoal
    const key = `${map.name}/${path_name}/${goal_id}`
    if (key === this._lastTriggered) return

    this._lastTriggered = key
    this.emit('goal-reached', {
      map_name:  map.name,
      path_file: path_name,
      goal_id:   goal_id
    })
  }
}
