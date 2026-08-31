import { WebSocketServer, WebSocket } from 'ws'
import { EventEmitter }    from 'events'
import { GoalTracker, GoalError } from './goal-tracker.js'

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
  constructor({ port = 8765, host, url = null, ackTimeoutMs, arrivalTimeoutMs } = {}) {
    super()
    this.port            = port
    this.host            = host
    this.url             = url
    this.wss             = null
    this._socket         = null   // single-robot assumption
    this.connectionGeneration = 0 // Audio jobs must not cross socket replacement.
    this.lastMapName     = null
    this.lastMapStatus   = null
    this.lastHeartbeatAt = null
    this._lastStatusStr  = ''
    this._reconnectTimer = null
    this._stopped        = false
    this._goals = new GoalTracker({
      send: obj => this._send(obj),
      emit: (event, data) => {
        console.log(`[机器人] ${event === 'goal-accepted' ? '目标已确认' : '导航已到达'}: ${data.map_name}/${data.path_name || data.path_file}/${data.goal_id}`)
        this.emit(event, data)
      },
      getMapState: () => ({
        name: this.lastMapName, status: this.lastMapStatus,
        ageMs: this.lastHeartbeatAt == null ? Infinity : performance.now() - this.lastHeartbeatAt,
      }),
      ackTimeoutMs, arrivalTimeoutMs,
    })
  }

  start() {
    this._stopped = false
    if (this.url) {
      this._connectAsClient()
    } else {
      this.wss = new WebSocketServer({ port: this.port, host: this.host })

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
        const oldSocket = this._socket
        this._resetRobotState()
        this._socket         = socket
        this.connectionGeneration++
        if (oldSocket) oldSocket.close()
        this.emit('connected')

        socket.on('message', (raw) => {
          if (this._socket !== socket) return
          let msg
          try {
            msg = JSON.parse(raw.toString())
          } catch {
            return
          }
          this._handleMessage(msg)
        })

        socket.on('close', () => {
          if (this._socket !== socket) return
          console.log('[机器人] 连接断开')
          this._socket = null
          this.connectionGeneration++
          this._resetRobotState()
          this.emit('disconnected')
        })

        socket.on('error', (err) => {
          console.error('[机器人] 连接错误:', err.message)
        })
      })
    }
  }

  _connectAsClient() {
    if (this._stopped) return
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
    this._socket = socket

    socket.on('open', () => {
      if (this._stopped || this._socket !== socket) return
      console.log('[机器人] 连接成功')
      this._resetRobotState()
      this.connectionGeneration++
      this.emit('connected')
    })

    socket.on('message', (raw) => {
      if (this._socket !== socket) return
      let msg
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      this._handleMessage(msg)
    })

    socket.on('close', () => {
      if (this._socket !== socket) return
      console.log('[机器人] 连接断开/关闭')
      const wasConnected = !!this._socket
      this._socket = null
      this.connectionGeneration++
      this._resetRobotState()
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
    if (this._stopped || this._reconnectTimer) return
    console.log('[机器人] 5秒后尝试重新连接...')
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null
      this._connectAsClient()
    }, 5000)
  }

  stop() {
    this._stopped = true
    this._resetRobotState()
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer)
      this._reconnectTimer = null
    }
    if (this.wss) this.wss.close()
    if (this._socket) {
      const socket = this._socket
      this._socket = null
      this.connectionGeneration++
      try { socket.close() } catch {}
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

  // Resolves only on a correlated navigation arrival; rejects on refusal,
  // failure, timeout or cancellation. No physical stop command is implied.
  sendSetGoal(item, options) {
    if (!this.isConnected()) throw new GoalError('ROBOT_DISCONNECTED', '机器人未连接，未发送目标点')
    return this._goals.start(item, options)
  }

  cancelPendingGoal() {
    this._goals.cancel()
  }

  _resetRobotState() {
    this._goals.cancel(new GoalError('ROBOT_DISCONNECTED', '机器人连接已断开，目标点等待已取消'))
    this.lastMapName = null
    this.lastMapStatus = null
    this.lastHeartbeatAt = null
    this._lastStatusStr = ''
  }

  /**
   * Send one real-time PCM frame to the robot speaker.
   * PCM format is fixed by the robot protocol: 16 kHz, mono, S16_LE.
   */
  sendAudioFrame(pcmChunk, seq, { generation, onComplete } = {}) {
    if (!Buffer.isBuffer(pcmChunk) || pcmChunk.length === 0) {
      throw new TypeError('audio PCM frame must be a non-empty Buffer')
    }
    if (!Number.isInteger(seq) || seq < 1) {
      throw new TypeError('audio sequence number must be a positive integer')
    }
    const socket = this._socket
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('机器人 WebSocket 未连接，无法发送音频')
    }
    if (generation !== undefined && generation !== this.connectionGeneration) {
      throw new Error('机器人连接已更换，拒绝旧音频帧')
    }
    // Never let network buffering silently turn live audio into a many-second
    // delayed queue. Normal traffic is only about 46 KB/s including base64/JSON.
    if (socket.bufferedAmount > 256 * 1024) {
      throw Object.assign(new Error(`机器人音频发送积压过大 (${socket.bufferedAmount} bytes)`), {
        code: 'AUDIO_BACKLOG', bufferedAmount: socket.bufferedAmount,
      })
    }
    const payload = JSON.stringify({
      audio: {
        type:   'pcm',
        sample: '16',
        seq,
        data: pcmChunk.toString('base64'),
      }
    })
    const startedAt = performance.now()
    const connectionGeneration = this.connectionGeneration
    // Avoid compression work for tiny real-time frames. Callback measures local
    // socket write completion only, not receiver arrival or audible playback.
    socket.send(payload, { compress: false }, err => {
      try {
        onComplete?.(err || null, {
          writeMs: performance.now() - startedAt,
          bufferedAmount: socket.bufferedAmount || 0,
          payloadBytes: Buffer.byteLength(payload), connectionGeneration,
          staleConnection: socket !== this._socket,
        })
      } catch { /* Diagnostic consumers must never break robot I/O. */ }
    })
  }

  isConnected() {
    return !!this._socket && this._socket.readyState === WebSocket.OPEN
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
        } else if (name === mapName && (status === 'failed' || status === 'faild')) {
          clearTimeout(timer)
          this.off('heartbeat', handler)
          reject(new Error(`地图定位失败: ${mapName}`))
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
    if (!this._socket || this._socket.readyState !== WebSocket.OPEN) {
      console.warn('[机器人] 尚未连接，无法发送指令')
      return false
    }
    this._socket.send(JSON.stringify(obj))
    return true
  }

  _handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return
    if ('robot_map_list' in msg) {
      this.emit('reply', { type: 'map_list', data: msg.robot_map_list })
    } else if ('robot_switch_map' in msg) {
      this.emit('reply', { type: 'switch_map', data: msg.robot_switch_map })
    } else if ('robot_path_list' in msg) {
      this.emit('reply', { type: 'path_list', data: msg.robot_path_list })
    } else if ('robot_goal' in msg) {
      this._goals.handleReply(msg.robot_goal)
      this.emit('reply', { type: 'goal', data: msg.robot_goal })
    } else if ('system' in msg && 'task' in msg) {
      this._handleHeartbeat(msg)
    }
  }

  _handleHeartbeat(msg) {
    const { task, map } = msg
    if (map) {
      this.lastMapName = map.name
      this.lastMapStatus = map.status
      this.lastHeartbeatAt = performance.now()
    }
    this.emit('heartbeat', msg)
    this._goals.handleHeartbeat(msg)
    if (!task || !map) return

    // Log status transitions in backend.log to verify robot arrival state
    const currentStatusStr = `${map.name}/${task.path_file}/${task.goal_id}: goal: ${task.goal_status}, object: ${task.object_status}`
    if (currentStatusStr !== this._lastStatusStr) {
      console.log(`[机器人状态变更] ${currentStatusStr} (地图: ${map.name}, 路径: ${task.path_file || '无'}, 目标点: ${task.goal_id ?? '无'})`)
      this._lastStatusStr = currentStatusStr
    }
  }
}
