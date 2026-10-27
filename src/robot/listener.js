import { WebSocketServer, WebSocket } from 'ws'
import { EventEmitter }    from 'events'
import { GoalTracker, GoalError } from './goal-tracker.js'
import { AUDIO_SEND_POLICY } from './audio-send-policy.js'

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
  constructor({ port = 8765, host, url = null, ackTimeoutMs, arrivalTimeoutMs, diagnostics } = {}) {
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
    this._audioPressure = null
    this._audioResetTimer = null
    this._audioFailure = null
    this.diagnostics = diagnostics
    this._diagnosticAttemptId = 0
    this._diagnosticConnection = null
    this._lastHeartbeatDiagnosticKey = null
    this._lastHeartbeatDiagnosticAt = null
    this._diagnosticHeartbeatCount = 0
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
      diagnostics: { event: (type, fields) => this._diagnostic(type, fields) },
    })
  }

  _newDiagnosticConnection(direction) {
    const connection = { attemptId: ++this._diagnosticAttemptId, direction,
      startedAt: performance.now(), openedAt: null }
    this._diagnosticConnection = connection
    this._diagnostic('robot-connection-attempt', {}, connection)
    return connection
  }

  _diagnostic(type, fields = {}, connection = this._diagnosticConnection) {
    // Deliberately omit URLs, socket close reasons, raw messages and error.message.
    // Diagnostics cannot alter connection, timer, or navigation behavior.
    try {
      const now = performance.now()
      this.diagnostics?.event?.(type, {
        attemptId: connection?.attemptId ?? 0,
        direction: connection?.direction ?? (this.url ? 'client' : 'server'),
        generation: this.connectionGeneration,
        opened: connection?.openedAt != null,
        elapsedMs: connection ? Math.round(now - connection.startedAt) : 0,
        uptimeMs: connection?.openedAt == null ? null : Math.round(now - connection.openedAt),
        heartbeatAgeMs: this.lastHeartbeatAt == null ? null : Math.round(now - this.lastHeartbeatAt),
        stage: connection?.openedAt == null ? 'connect' : 'socket',
        ...fields,
      })?.catch?.(() => {})
    } catch {}
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
        this._diagnostic('robot-connection-error', { errorCode: err.code, stage: 'listen', reason: 'socket-error' })
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
        const connection = this._newDiagnosticConnection('server')
        this._socket         = socket
        this.connectionGeneration++
        connection.openedAt = performance.now()
        this._diagnostic('robot-connection-open', {}, connection)
        // Replacement retires the old transport completely; graceful close
        // could otherwise flush stale PCM after the new connection takes over.
        if (oldSocket) { try { oldSocket.terminate() } catch {} }
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

        socket.on('close', (code) => {
          if (this._socket !== socket) return
          console.log('[机器人] 连接断开')
          this._socket = null
          this.connectionGeneration++
          this._diagnostic('robot-connection-close', { closeCode: code, reason: 'closed' }, connection)
          this._resetRobotState()
          this.emit('disconnected')
        })

        socket.on('error', (err) => {
          this._diagnostic('robot-connection-error', { errorCode: err.code, reason: 'socket-error' }, connection)
          console.error('[机器人] 连接错误:', err.message)
        })
      })
    }
  }

  _connectAsClient() {
    if (this._stopped) return
    if (this._socket) {
      try { this._socket.terminate() } catch {}
      this._socket = null
    }
    console.log(`[机器人] 正在连接 WS 服务: ${this.url}`)
    const connection = this._newDiagnosticConnection('client')
    
    let socket
    try {
      socket = new WebSocket(this.url)
    } catch (err) {
      this._diagnostic('robot-connection-error', { errorCode: err.code, reason: 'connect-error' }, connection)
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
      connection.openedAt = performance.now()
      this._diagnostic('robot-connection-open', {}, connection)
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

    socket.on('close', (code) => {
      if (this._socket !== socket) return
      console.log('[机器人] 连接断开/关闭')
      const wasConnected = !!this._socket
      this._socket = null
      this.connectionGeneration++
      this._diagnostic('robot-connection-close', { closeCode: code, reason: 'closed' }, connection)
      this._resetRobotState()
      if (wasConnected) {
        this.emit('disconnected')
      }
      this._reconnect()
    })

    socket.on('error', (err) => {
      this._diagnostic('robot-connection-error', { errorCode: err.code,
        reason: connection.openedAt == null ? 'connect-error' : 'socket-error' }, connection)
      console.log('[机器人] 连接错误:', err.message)
    })
  }

  _reconnect() {
    if (this._stopped || this._reconnectTimer) return
    console.log('[机器人] 5秒后尝试重新连接...')
    this._diagnostic('robot-connection-retry', { retryDelayMs: 5000, reason: 'retry' })
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null
      this._connectAsClient()
    }, 5000)
  }

  stop() {
    this._stopped = true
    this._diagnostic('robot-connection-stopped', { stage: 'stopped', reason: 'stopped' })
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
      try { socket.terminate() } catch {}
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
    if (!this.isConnected()) {
      const error = new GoalError('ROBOT_DISCONNECTED', '机器人未连接，未发送目标点')
      this._goals.recordRejectedStart(item, error)
      throw error
    }
    return this._goals.start(item, options)
  }

  cancelPendingGoal() {
    this._goals.cancel()
  }

  _resetRobotState() {
    this._clearAudioSendState()
    this._goals.cancel(new GoalError('ROBOT_DISCONNECTED', '机器人连接已断开，目标点等待已取消'))
    this.lastMapName = null
    this.lastMapStatus = null
    this.lastHeartbeatAt = null
    this._lastStatusStr = ''
    this._lastHeartbeatDiagnosticKey = null
    this._lastHeartbeatDiagnosticAt = null
    this._diagnosticHeartbeatCount = 0
  }

  _bufferedAudioBytes(socket = this._socket) {
    const bytes = socket?.bufferedAmount
    return Number.isFinite(bytes) && bytes > 0 ? bytes : 0
  }

  _clearAudioPressure() {
    if (this._audioPressure?.timer != null) clearTimeout(this._audioPressure.timer)
    this._audioPressure = null
  }

  _clearAudioSendState() {
    this._clearAudioPressure()
    if (this._audioResetTimer != null) clearTimeout(this._audioResetTimer)
    this._audioResetTimer = null
    this._audioFailure = null
  }

  _audioFlow(state, { bufferedBytes, waitMs = 0, errorCode } = {}) {
    const reason = state === 'waiting' ? 'audio-backpressure' : state === 'recovered' ? 'audio-drained'
      : errorCode === 'AUDIO_BACKLOG' ? 'audio-hard-limit' : 'audio-timeout'
    const fields = { bufferedBytes, waitMs, errorCode, direction: this.url ? 'client' : 'server',
      highWaterBytes: AUDIO_SEND_POLICY.highWaterBytes, lowWaterBytes: AUDIO_SEND_POLICY.lowWaterBytes,
      hardLimitBytes: AUDIO_SEND_POLICY.hardLimitBytes }
    this._diagnostic('robot-audio-backpressure', { ...fields, stage: 'audio', reason })
    // UI/diagnostic notification must never prevent the drain watchdog or
    // the reset timer from being installed.
    try { this.emit('audio-flow', { ...fields, state }) } catch {
      console.warn('[机器人] 音频发送状态通知失败，连接保护继续执行')
    }
  }

  _failAudioSend(socket, code, bufferedBytes, waitMs = 0) {
    if (this._audioFailure?.socket === socket) return this._audioFailure.error
    const message = code === 'AUDIO_BACKLOG'
      ? `机器人音频发送积压超过安全上限 (${bufferedBytes} bytes)，正在重置连接`
      : `机器人音频发送持续拥堵 ${Math.round(waitMs / 1000)} 秒，正在清理旧连接；连接恢复后请重新播放`
    const error = Object.assign(new Error(message), { code, bufferedAmount: bufferedBytes, waitMs })
    this._clearAudioPressure()
    this._audioFailure = { socket, error }
    this._audioFlow('reset', { bufferedBytes, waitMs, errorCode: code })
    // Let the current send fail with its original cause before invalidating all
    // shared-socket users. Quarantine this socket immediately in the meantime.
    this._audioResetTimer = setTimeout(() => {
      this._audioResetTimer = null
      if (this._stopped || this._socket !== socket || this._audioFailure?.socket !== socket) return
      this._socket = null
      this.connectionGeneration++
      this._diagnostic('robot-connection-close', { reason: code === 'AUDIO_BACKLOG' ? 'audio-hard-limit' : 'audio-timeout', errorCode: code })
      this._resetRobotState()
      // A graceful close can queue behind the blocked audio. Termination drops
      // local pending writes; it cannot retract audio already at the robot.
      try { socket.terminate() } catch {}
      try { this.emit('disconnected') } catch {
        console.warn('[机器人] 连接重置通知失败，旧连接已关闭，重连保护继续执行')
      } finally {
        if (this.url) this._reconnect()
      }
    }, 0)
    return error
  }

  _checkAudioPressure() {
    const pressure = this._audioPressure
    if (!pressure) return
    const { socket } = pressure
    if (this._stopped || socket !== this._socket || socket.readyState !== WebSocket.OPEN) {
      this._clearAudioPressure()
      return
    }
    const bufferedBytes = this._bufferedAudioBytes(socket)
    const waitMs = performance.now() - pressure.startedAt
    if (bufferedBytes > AUDIO_SEND_POLICY.hardLimitBytes) {
      this._failAudioSend(socket, 'AUDIO_BACKLOG', bufferedBytes, waitMs)
      return
    }
    if (bufferedBytes <= pressure.resumeBytes) {
      this._clearAudioPressure()
      if (pressure.announced) this._audioFlow('recovered', { bufferedBytes, waitMs })
      return
    }
    if (waitMs >= AUDIO_SEND_POLICY.stallTimeoutMs) {
      this._failAudioSend(socket, 'AUDIO_SEND_TIMEOUT', bufferedBytes, waitMs)
      return
    }
    if (!pressure.announced && waitMs >= AUDIO_SEND_POLICY.drainNoticeMs) {
      pressure.announced = true
      this._audioFlow('waiting', { bufferedBytes, waitMs })
    }
    if (pressure.timer == null) {
      pressure.timer = setTimeout(() => {
        pressure.timer = null
        this._checkAudioPressure()
      }, AUDIO_SEND_POLICY.pollMs)
      pressure.timer.unref?.()
    }
  }

  /** Poll before taking PCM from the reader. Waiting never consumes a frame or
   * advances seq. State belongs to the connection, so stop/retry cannot evade
   * its timeout or inherit an unlimited queue. drain waits for local writes only. */
  getAudioSendState({ generation, drain = false } = {}) {
    const socket = this._socket
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('机器人 WebSocket 未连接，无法发送音频')
    if (generation !== undefined && generation !== this.connectionGeneration) throw new Error('机器人连接已更换，拒绝旧音频帧')
    if (this._audioFailure?.socket === socket) throw this._audioFailure.error
    const bufferedBytes = this._bufferedAudioBytes(socket)
    if (bufferedBytes > AUDIO_SEND_POLICY.hardLimitBytes) throw this._failAudioSend(socket, 'AUDIO_BACKLOG', bufferedBytes)
    if (!this._audioPressure && (bufferedBytes >= AUDIO_SEND_POLICY.highWaterBytes || (drain && bufferedBytes > 0))) {
      const announced = bufferedBytes >= AUDIO_SEND_POLICY.highWaterBytes
      this._audioPressure = { socket, startedAt: performance.now(), timer: null,
        resumeBytes: drain ? 0 : AUDIO_SEND_POLICY.lowWaterBytes, announced }
      if (announced) this._audioFlow('waiting', { bufferedBytes })
    } else if (drain && this._audioPressure) this._audioPressure.resumeBytes = 0
    this._checkAudioPressure()
    if (this._audioFailure?.socket === socket) throw this._audioFailure.error
    return { writable: !this._audioPressure, bufferedBytes, retryAfterMs: AUDIO_SEND_POLICY.pollMs }
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
    if (this._audioFailure?.socket === socket) throw this._audioFailure.error
    const payload = JSON.stringify({
      audio: {
        type:   'pcm',
        sample: '16',
        seq,
        data: pcmChunk.toString('base64'),
      }
    })
    const payloadBytes = Buffer.byteLength(payload)
    const bufferedBytes = this._bufferedAudioBytes(socket)
    if (bufferedBytes + payloadBytes > AUDIO_SEND_POLICY.hardLimitBytes) {
      throw this._failAudioSend(socket, 'AUDIO_BACKLOG', bufferedBytes)
    }
    const startedAt = performance.now()
    const connectionGeneration = this.connectionGeneration
    // Avoid compression work for tiny real-time frames. Callback measures local
    // socket write completion only, not receiver arrival or audible playback.
    socket.send(payload, { compress: false }, err => {
      try {
        onComplete?.(err || null, {
          writeMs: performance.now() - startedAt,
          bufferedAmount: socket.bufferedAmount || 0,
          payloadBytes, connectionGeneration,
          staleConnection: socket !== this._socket,
        })
      } catch { /* Diagnostic consumers must never break robot I/O. */ }
    })
    // Arm the independent drain watchdog even if this was the last frame or
    // the user immediately stops/pauses the narration.
    if (this._socket === socket && this._bufferedAudioBytes(socket) >= AUDIO_SEND_POLICY.highWaterBytes) {
      this.getAudioSendState({ generation: connectionGeneration })
    }
  }

  isConnected() {
    return !!this._socket && this._socket.readyState === WebSocket.OPEN
      && this._audioFailure?.socket !== this._socket
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
    if (!this.isConnected()) {
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
    this._diagnosticHeartbeatCount++
    try {
      const fields = {
        receivedMap: map?.name, receivedPath: task?.path_file,
        receivedGoalId: task?.goal_id, receivedObject: task?.goal_object,
        mapStatus: map?.status, goalStatus: task?.goal_status, objectStatus: task?.object_status,
      }
      const key = JSON.stringify(fields)
      if (key !== this._lastHeartbeatDiagnosticKey || performance.now() - this._lastHeartbeatDiagnosticAt >= 10000) {
        const reason = key !== this._lastHeartbeatDiagnosticKey ? 'changed' : 'periodic'
        this._lastHeartbeatDiagnosticKey = key
        this._lastHeartbeatDiagnosticAt = performance.now()
        this._diagnostic('robot-heartbeat', { ...fields, heartbeatCount: this._diagnosticHeartbeatCount, reason })
      }
    } catch { /* Malformed diagnostic values cannot interrupt heartbeat handling. */ }
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
