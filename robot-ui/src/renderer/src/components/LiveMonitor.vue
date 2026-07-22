<template>
  <div class="monitor-layout">

    <!-- Top status cards -->
    <div class="status-row">
      <div class="stat-card">
        <div class="stat-label">机器人</div>
        <div class="stat-value" :class="robotConnected ? 'green' : 'red'">
          {{ robotConnected ? '已连接' : '未连接' }}
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-label">电量</div>
        <div class="stat-value mono" :class="batteryClass">{{ battery !== null ? battery + '%' : '—' }}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">巡游状态</div>
        <div class="stat-value" :class="tourStatusClass">{{ tourStatusLabel }}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">当前点位</div>
        <div class="stat-value mono">{{ currentPoint || '—' }}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Ducking</div>
        <div class="stat-value" :class="!duckerEnabled ? 'dim' : (ducking ? 'amber' : 'dim')">
          {{ !duckerEnabled ? '未启用' : (ducking ? '▼ 助播讲话中' : '正常') }}
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-label">已播报次数</div>
        <div class="stat-value mono">{{ broadcastCount }}</div>
      </div>
    </div>

    <!-- Robot task status cards -->
    <div class="status-row" v-if="robotConnected">
      <div class="stat-card">
        <div class="stat-label">地图状态</div>
        <div class="stat-value" :class="mapStatusClass">{{ mapStatusLabel }}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">导航状态</div>
        <div class="stat-value" :class="navGoalStatusClass">{{ navGoalStatusLabel }}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">对准状态</div>
        <div class="stat-value" :class="objStatusClass">{{ objStatusLabel }}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">剩余时间</div>
        <div class="stat-value mono" :class="remainTime !== null ? '' : 'dim'">
          {{ remainTime !== null ? remainTime + 's' : '—' }}
        </div>
      </div>
    </div>

    <!-- Ducker control panel -->
    <div class="ducker-panel">
      <div class="ducker-header">
        <span class="ducker-title">🎤 助播降噪（Ducking）</span>
        <div class="ducker-toggle-wrap">
          <span class="ducker-status-label" :class="duckerStatusClass">{{ duckerStatusLabel }}</span>
          <el-switch v-model="duckerEnabled" @change="onDuckerToggle" />
        </div>
      </div>
      <div class="ducker-body" v-if="duckerEnabled">
        <div class="ducker-level">
          <span class="level-text">麦克风</span>
          <div class="level-bar">
            <div class="level-fill" :style="{ transform: 'scaleX(' + levelBarScale + ')', transformOrigin: 'left center', background: ducking ? 'var(--amber)' : 'var(--cyan)' }"></div>
          </div>
          <span class="level-db mono">{{ currentDbDisplay }}</span>
        </div>
        <div class="ducker-config">
          <span class="param-label">静音阈值 (dB)</span>
          <el-input-number v-model="noiseDb" size="small" :step="1" :min="-60" :max="0" style="width: 100px" />
          <span class="param-label">判定时长 (s)</span>
          <el-input-number v-model="duckDuration" size="small" :step="0.1" :precision="1" :min="0.1" :max="5" style="width: 100px" />
          <span class="param-label">触发帧数</span>
          <el-input-number v-model="holdFrames" size="small" :step="1" :min="1" :max="30" :precision="0" style="width: 80px" />
          <el-button size="small" @click="saveDuckerConfig">保存</el-button>
          <span v-if="duckerConfigSaved" class="ok-text">已保存</span>
        </div>
      </div>
    </div>

    <!-- Tunnel URL panel
    <div class="tunnel-panel" :class="tunnelUrl ? 'tunnel-active' : 'tunnel-inactive'">
      <span class="tunnel-label">🌐 机器人连接地址（ngrok）</span>
      <template v-if="tunnelUrl">
        <span class="tunnel-url mono">{{ tunnelUrl }}</span>
        <el-button size="small" plain @click="copyTunnelUrl">{{ tunnelCopied ? '已复制 ✓' : '复制' }}</el-button>
      </template>
      <span v-else class="tunnel-hint">未启用（在设置 → API 密钥中填写 NGROK_AUTHTOKEN 后重启）</span>
    </div>
    -->

    <!-- Current speech banner -->
    <div class="current-speech" v-if="currentText">
      <div class="current-label">▶ 正在播报</div>
      <div class="current-text">{{ currentText }}</div>
    </div>

    <!-- Goal check failed alert -->
    <div class="alert-banner" v-if="goalCheckFailed">
      <span class="alert-icon">⚠</span>
      <span class="alert-msg">{{ goalCheckFailed.message }}</span>
      <div class="alert-actions">
        <el-button size="small" type="primary" @click="retryGoal">重试</el-button>
        <el-button size="small"               @click="skipGoal">跳过</el-button>
      </div>
    </div>

    <!-- Log -->
    <div class="log-header">
      <span class="log-title">事件日志</span>
      <button class="clear-btn" @click="logs = []">清空</button>
    </div>
    <div class="log-area" ref="logRef">
      <div v-for="(entry, i) in logs" :key="i" class="log-entry" :class="entry.type">
        <span class="log-time">{{ entry.time }}</span>
        <span class="log-tag">{{ tagFor(entry.type) }}</span>
        <span class="log-msg">{{ entry.message }}</span>
      </div>
      <div v-if="logs.length === 0" class="log-empty">
        等待后端连接中... 请先启动后端服务
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, nextTick, computed, onMounted, onUnmounted } from 'vue'

const props = defineProps({ wsRef: Object })
const emit  = defineEmits(['send'])

const logRef          = ref(null)
const logs            = ref([])
const broadcastCount  = ref(0)
const robotConnected  = ref(false)
const battery         = ref(null)
const ducking         = ref(false)
const currentPoint    = ref('')
const currentText     = ref('')
const tourStatus      = ref('idle')   // idle | running | paused | finished
const goalCheckFailed = ref(null)     // { message, map_name, path_name, goal_id } | null
const tunnelUrl       = ref(null)     // ngrok wss:// URL | null
const mapStatus       = ref(null)     // ready | preparing | failed | null
const navGoalStatus   = ref(null)     // going | done | failed | null
const objStatus       = ref(null)     // going | done | failed | null
const remainTime      = ref(null)     // seconds | null
const barrageRegion   = ref(null)     // { x, y, width, height } | null
let barrageTimer      = null
let videoStream       = null
let videoEl           = null
let canvasEl          = null

// ── Ducker state ──────────────────────────────────────────────────────────────
const duckerEnabled     = ref(false)
const duckerState       = ref('idle')  // idle | running | no-permission
const currentDb         = ref(-Infinity)
const noiseDb           = ref(-30)
const duckDuration      = ref(1.0)
const duckerConfigSaved = ref(false)

let _audioCtx    = null
let _analyser    = null
let _stream      = null
let _animId      = null
let _speakLocal  = false   // local speaking state for hysteresis
let _silTimer    = null
let _holdCount   = 0
const holdFrames       = ref(1)   // 音量超阈值需连续几帧才触发 DUCK_START（1帧≈16ms）

const duckerStatusLabel = computed(() => {
  if (!duckerEnabled.value)           return '已关闭'
  if (duckerState.value === 'no-permission') return '⚠ 无麦克风权限'
  if (duckerState.value === 'running') return ducking.value ? '助播讲话中' : '监听中'
  return '启动中...'
})

const duckerStatusClass = computed(() => {
  if (!duckerEnabled.value)           return 'dim'
  if (duckerState.value === 'no-permission') return 'red'
  if (duckerState.value === 'running') return ducking.value ? 'amber' : 'green'
  return 'dim'
})

const levelBarWidth = computed(() => {
  if (duckerState.value !== 'running') return '0%'
  // Map dB range [-60, 0] → [0%, 100%]
  const pct = Math.max(0, Math.min(100, (currentDb.value + 60) / 60 * 100))
  return pct + '%'
})

const levelBarScale = computed(() => {
  if (duckerState.value !== 'running') return 0
  const scale = Math.max(0, Math.min(1, (currentDb.value + 60) / 60))
  return scale
})

const currentDbDisplay = computed(() => {
  if (duckerState.value !== 'running') return ''
  return isFinite(currentDb.value) ? currentDb.value.toFixed(0) + ' dB' : '-∞'
})

async function loadDuckerConfig() {
  if (!window.api) return
  try {
    const res = await window.api.readPublicEnv()
    if (res.ok) {
      if (res.env.DUCK_NOISE_DB)    noiseDb.value    = parseFloat(res.env.DUCK_NOISE_DB)
      if (res.env.DUCK_DURATION)    duckDuration.value = parseFloat(res.env.DUCK_DURATION)
      if (res.env.DUCK_HOLD_FRAMES) holdFrames.value = parseInt(res.env.DUCK_HOLD_FRAMES)
    }
  } catch {}
}

async function saveDuckerConfig() {
  if (!window.api) return
  try {
    await window.api.writePublicEnv({
      DUCK_NOISE_DB:    String(noiseDb.value),
      DUCK_DURATION:    String(duckDuration.value),
      DUCK_HOLD_FRAMES: String(holdFrames.value),
    })
    duckerConfigSaved.value = true
    setTimeout(() => { duckerConfigSaved.value = false }, 2000)
  } catch {}
}

async function onDuckerToggle(enabled) {
  localStorage.setItem('duckerEnabled', enabled ? '1' : '0')
  if (enabled) {
    await startMicMonitor()
  } else {
    // Must capture state BEFORE stopMicMonitor() resets _speakLocal
    const needDuckEnd = _speakLocal || !!_silTimer || ducking.value
    stopMicMonitor()
    if (needDuckEnd) {
      send('DUCK_END')
      ducking.value = false  // reset locally in case WS is not connected
    }
  }
}

async function startMicMonitor() {
  duckerState.value = 'idle'
  try {
    _stream   = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: false
    })
    _audioCtx = new AudioContext()
    _analyser = _audioCtx.createAnalyser()
    _analyser.fftSize = 512
    _audioCtx.createMediaStreamSource(_stream).connect(_analyser)
    duckerState.value = 'running'

    const buf = new Float32Array(_analyser.frequencyBinCount)
    let lastTick = 0
    function tick(now) {
      if (!_analyser) return
      _animId = requestAnimationFrame(tick)

      // Throttle logic to ~20Hz (every 50ms) to save CPU
      if (now - lastTick < 50) return
      lastTick = now

      _analyser.getFloatTimeDomainData(buf)
      const rms = Math.sqrt(buf.reduce((s, v) => s + v * v, 0) / buf.length)
      currentDb.value = rms > 0 ? 20 * Math.log10(rms) : -Infinity

      if (currentDb.value > noiseDb.value) {
        _holdCount++
        if (_silTimer !== null) { clearTimeout(_silTimer); _silTimer = null }
        if (_holdCount >= holdFrames.value && !_speakLocal) {
          _speakLocal = true
          send('DUCK_START')
        }
      } else {
        _holdCount = 0
        if (_speakLocal && _silTimer === null) {
          _silTimer = setTimeout(() => {
            _silTimer = null
            _speakLocal = false
            send('DUCK_END')
          }, duckDuration.value * 1000)
        }
      }
    }
    _animId = requestAnimationFrame(tick)
  } catch (err) {
    duckerState.value = 'no-permission'
    addLog('duck', `麦克风权限被拒绝: ${err.message}`)
  }
}

function stopMicMonitor() {
  cancelAnimationFrame(_animId)
  _animId = null
  clearTimeout(_silTimer)
  _silTimer = null
  _speakLocal = false
  _holdCount = 0
  currentDb.value = -Infinity
  if (_analyser) { _analyser.disconnect(); _analyser = null }
  if (_audioCtx)  { _audioCtx.close().catch(() => {}); _audioCtx = null }
  if (_stream)    { _stream.getTracks().forEach(t => t.stop()); _stream = null }
  duckerState.value = 'idle'
}

// ── Computed (existing) ───────────────────────────────────────────────────────

const tourStatusLabel = computed(() => ({
  idle:     '待机',
  running:  '巡游中',
  paused:   '已暂停',
  finished: '已完成',
}[tourStatus.value] ?? '—'))

const tourStatusClass = computed(() => ({
  idle:     'dim',
  running:  'green',
  paused:   'amber',
  finished: 'dim',
}[tourStatus.value]))

const mapStatusLabel = computed(() =>
  ({ ready: '就绪', preparing: '加载中', failed: '失败' }[mapStatus.value] ?? '—'))
const mapStatusClass = computed(() =>
  ({ ready: 'green', preparing: 'amber', failed: 'red' }[mapStatus.value] ?? 'dim'))

const navGoalStatusLabel = computed(() =>
  ({ going: '前往中', done: '已到达', failed: '失败' }[navGoalStatus.value] ?? '—'))
const navGoalStatusClass = computed(() =>
  ({ going: 'amber', done: 'green', failed: 'red' }[navGoalStatus.value] ?? 'dim'))

const objStatusLabel = computed(() =>
  ({ going: '对准中', done: '已对准', failed: '失败' }[objStatus.value] ?? '—'))
const objStatusClass = computed(() =>
  ({ going: 'amber', done: 'green', failed: 'red' }[objStatus.value] ?? 'dim'))

const batteryClass = computed(() => {
  if (battery.value === null) return 'dim'
  if (battery.value > 50) return 'green'
  if (battery.value > 20) return 'amber'
  return 'red'
})

// ── Helpers ───────────────────────────────────────────────────────────────────

function addLog(type, message) {
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  logs.value.push({ type, time, message })
  if (logs.value.length > 500) logs.value.shift()
  nextTick(() => { if (logRef.value) logRef.value.scrollTop = logRef.value.scrollHeight })
}

function tagFor(type) {
  return {
    speech:  'TTS',
    mp3:     'MP3',
    point:   '点位',
    duck:    'DUCK',
    error:   '错误',
    info:    '信息',
    system:  '系统',
    tour:    '巡游',
    robot:   '机器人',
    barrage: '弹幕',
  }[type] || type.toUpperCase()
}

function send(type, data = {}) {
  props.wsRef?.send(JSON.stringify({ type, data }))
}

function retryGoal()  { goalCheckFailed.value = null; send('RESUME_TOUR') }
function skipGoal()   { goalCheckFailed.value = null; send('SKIP_POINT') }

const tunnelCopied = ref(false)
function copyTunnelUrl() {
  if (!tunnelUrl.value) return
  navigator.clipboard.writeText(tunnelUrl.value)
  tunnelCopied.value = true
  setTimeout(() => { tunnelCopied.value = false }, 2000)
}

// ── WS message handler ────────────────────────────────────────────────────────

function handleMessage(raw) {
  try {
    const { type, data } = JSON.parse(raw)
    switch (type) {

      case 'ROBOT_CONNECTED':
        robotConnected.value = true
        addLog('robot', '机器人已连接')
        break
      case 'ROBOT_DISCONNECTED':
        robotConnected.value = false
        battery.value = null
        mapStatus.value = null
        navGoalStatus.value = null
        objStatus.value = null
        remainTime.value = null
        tourStatus.value = 'idle'
        addLog('robot', '机器人已断线')
        break

      case 'HEARTBEAT': {
        if (data.system?.battery !== undefined) battery.value = data.system.battery

        // map status — log only on change
        const newMapStatus = data.map?.status ?? null
        if (newMapStatus !== mapStatus.value) {
          const labels = { ready: '地图就绪', preparing: '地图加载中', failed: '地图加载失败' }
          if (newMapStatus) addLog('robot', `地图状态: ${labels[newMapStatus] ?? newMapStatus}`)
          mapStatus.value = newMapStatus
        }

        // task goal_status — log only on change
        const newNavGoal = data.task?.goal_status ?? null
        if (newNavGoal !== navGoalStatus.value) {
          const labels = { going: '前往目标点中', done: '已到达目标点', failed: '导航失败' }
          if (newNavGoal) addLog('robot', `导航状态: ${labels[newNavGoal] ?? newNavGoal}`)
          navGoalStatus.value = newNavGoal
        }

        // task object_status — log only on change
        const newObj = data.task?.object_status ?? null
        if (newObj !== objStatus.value) {
          const labels = { going: '对准目标中', done: '已对准目标', failed: '对准失败' }
          if (newObj) addLog('robot', `对准状态: ${labels[newObj] ?? newObj}`)
          objStatus.value = newObj
        }

        // remain time — silent update
        if (data.task?.task_remain_time !== undefined) remainTime.value = data.task.task_remain_time
        break
      }

      case 'MAP_LIST':
        addLog('robot', `地图列表: ${data.maps?.join(', ')}`)
        break
      case 'MAP_SWITCHING':
        addLog('tour', `正在切换地图: ${data.map_name}...`)
        break
      case 'MAP_SWITCHED':
        addLog('tour', `地图已就绪: ${data.map_name}`)
        break
      case 'PATH_LIST':
        addLog('tour', `路径列表 (${data.map_name}): ${data.paths?.join(', ')}`)
        break

      case 'TOUR_STARTED':
        tourStatus.value = 'running'
        goalCheckFailed.value = null
        addLog('tour', '巡游已开始')
        break
      case 'TOUR_PAUSED':
        tourStatus.value = 'paused'
        addLog('tour', '巡游已暂停')
        break
      case 'TOUR_RESUMED':
        tourStatus.value = 'running'
        addLog('tour', '巡游已恢复')
        break
      case 'TOUR_STOPPED':
        tourStatus.value = 'idle'
        currentPoint.value = ''
        addLog('tour', '巡游已停止')
        break
      case 'TOUR_FINISHED':
        tourStatus.value = 'finished'
        addLog('tour', '巡游已完成 ✓')
        break

      case 'GOAL_SENT':
        addLog('tour', `前往点位: ${data.map_name} / ${data.path_name} / ${data.goal_id}`)
        break

      case 'GOAL_CHECK_FAILED':
        goalCheckFailed.value = data
        addLog('error', data.message)
        break

      case 'POINT_ARRIVED':
        currentPoint.value = `${data.map_name} / ${data.path_file} / ${data.goal_id}`
        addLog('point', `到达点位: ${currentPoint.value}`)
        break

      case 'SPEECH_START':
        currentText.value = data.text || `[MP3] ${data.mp3_file || ''}`
        broadcastCount.value++
        addLog(data.mp3_file ? 'mp3' : 'speech', currentText.value)
        break
      case 'SPEECH_END':
        currentText.value = ''
        break

      case 'DUCK_START':
        ducking.value = true
        addLog('duck', '助播开麦 — 播报已中断')
        break
      case 'DUCK_END':
        ducking.value = false
        addLog('duck', '助播结束 — 恢复监听')
        break

      case 'BARRAGE_START':
        barrageRegion.value = data
        addLog('system', `弹幕追踪已启动: ${data.width}x${data.height}`)
        startBarrageLoop()
        break
      
      case 'BARRAGE_STOP':
        barrageRegion.value = null
        addLog('system', '弹幕追踪已停止')
        stopBarrageLoop()
        break

      case 'REQUEST_BARRAGE_CAPTURE': {
        // Ignored, the UI now pushes automatically using the hot stream
        break
      }

      case 'ERROR':
        addLog('error', data.message)
        break

      case 'BARRAGE_LOG':
        addLog('barrage', data.text)
        break

      case 'TUNNEL_URL':
        tunnelUrl.value = data.url ? data.url.replace(/^https?:\/\//, 'wss://') : null
        if (tunnelUrl.value) addLog('system', `ngrok 隧道已就绪: ${tunnelUrl.value}`)
        break

      case 'STATUS':
        break

      default:
        if (type.startsWith('BARRAGE_') || type === 'REQUEST_BARRAGE_CAPTURE') break
        addLog('info', `[${type}] ${JSON.stringify(data)}`)
    }
  } catch { addLog('error', `无法解析消息: ${raw}`) }
}

async function startBarrageLoop() {
  if (barrageTimer) clearInterval(barrageTimer)
  
  try {
    send('LOG_MESSAGE', 'Requesting screen source ID...')
    const sourceId = await window.api.getScreenSourceId()
    send('LOG_MESSAGE', `Got screen source ID: ${sourceId}`)
    if (!sourceId) throw new Error('Cannot find screen source')

    // Hot stream connection
    send('LOG_MESSAGE', 'Requesting getUserMedia...')
    videoStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId } }
    })
    
    send('LOG_MESSAGE', 'Got videoStream, setting up video element...')
    videoEl = document.createElement('video')
    videoEl.srcObject = videoStream
    await videoEl.play()
    
    canvasEl = document.createElement('canvas')
    canvasEl.width = barrageRegion.value.width
    canvasEl.height = barrageRegion.value.height

    console.log('[Phase 2] Hot video stream ready. Starting 1000ms loop.')
    send('LOG_MESSAGE', 'Hot stream ready. Starting interval.')

    barrageTimer = setInterval(() => {
      if (!barrageRegion.value || !videoEl || !props.wsRef || props.wsRef.readyState !== 1) return

      const ctx = canvasEl.getContext('2d')
      const scaleX = videoEl.videoWidth / window.screen.width
      const scaleY = videoEl.videoHeight / window.screen.height

      const sx = barrageRegion.value.x * scaleX
      const sy = barrageRegion.value.y * scaleY
      const sw = barrageRegion.value.width * scaleX
      const sh = barrageRegion.value.height * scaleY

      // Instant hardware-accelerated crop
      ctx.drawImage(videoEl, sx, sy, sw, sh, 0, 0, barrageRegion.value.width, barrageRegion.value.height)
      
      // Convert to binary PNG blob and send
      canvasEl.toBlob((blob) => {
        if (blob && props.wsRef.readyState === 1) {
          props.wsRef.send(blob)
        }
      }, 'image/png')
    }, 1000) // 1 second interval to prevent piling up
  } catch (err) {
    addLog('error', `弹幕流启动失败: ${err.message}`)
    console.error('[Phase 2]', err)
    send('LOG_MESSAGE', `Stream error: ${err.message}`)
  }
}

function stopBarrageLoop() {
  if (barrageTimer) clearInterval(barrageTimer)
  barrageTimer = null
  if (videoStream) {
    videoStream.getTracks().forEach(t => t.stop())
    videoStream = null
  }
  videoEl = null
  canvasEl = null
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

onMounted(async () => {
  await loadDuckerConfig()
  const saved = localStorage.getItem('duckerEnabled')
  if (saved === '1') {
    duckerEnabled.value = true
    await startMicMonitor()
  }

  // Handle OCR region selection
  if (window.api && window.api.onBarrageRegionSelected) {
    window.api.onBarrageRegionSelected((rect) => {
      if (rect) {
        barrageRegion.value = rect
        send('BARRAGE_START', rect)
        startBarrageLoop() // Trigger immediately, don't wait for backend echo
      } else {
        barrageRegion.value = null
        send('BARRAGE_STOP')
        stopBarrageLoop()
      }
    })
  }
})

let currentSocket = null
watch(() => props.wsRef, (socket) => {
  if (currentSocket) currentSocket.removeEventListener('message', onMsg)
  if (socket) {
    currentSocket = socket
    socket.addEventListener('message', onMsg)
    addLog('system', '已连接到后端')
  }
}, { immediate: true })

function onMsg(e) { handleMessage(e.data) }

onUnmounted(() => {
  currentSocket?.removeEventListener('message', onMsg)
  stopMicMonitor()
})
</script>

<style scoped>
.monitor-layout { display: flex; flex-direction: column; height: 100%; padding: 16px; gap: 12px; overflow: hidden; }

.status-row { display: flex; gap: 12px; flex-shrink: 0; flex-wrap: wrap; }
.stat-card { flex: 1; min-width: 100px; background: var(--bg2); border: 1px solid var(--border); border-radius: 6px; padding: 12px 16px; }
.stat-label { font-size: 11px; color: var(--text-dim); letter-spacing: .08em; text-transform: uppercase; margin-bottom: 6px; }
.stat-value { font-size: 16px; font-weight: 600; }
.stat-value.mono  { font-family: var(--font-mono); }
.stat-value.green { color: var(--green); }
.stat-value.red   { color: var(--red); }
.stat-value.amber { color: var(--amber); }
.stat-value.dim   { color: var(--text-dim); }

/* ── Ducker panel ── */
.ducker-panel {
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: 6px;
  flex-shrink: 0;
  overflow: hidden;
}
.ducker-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
}
.ducker-title { font-size: 12px; font-weight: 600; letter-spacing: .05em; }
.ducker-toggle-wrap { display: flex; align-items: center; gap: 10px; }
.ducker-status-label { font-size: 12px; }
.ducker-status-label.green { color: var(--green); }
.ducker-status-label.amber { color: var(--amber); }
.ducker-status-label.red   { color: var(--red); }
.ducker-status-label.dim   { color: var(--text-dim); }

.ducker-body { display: flex; flex-direction: column; gap: 10px; padding: 12px 16px; }

.ducker-level { display: flex; align-items: center; gap: 10px; }
.level-text { font-size: 12px; color: var(--text-dim); flex-shrink: 0; min-width: 44px; }
.level-bar { flex: 1; height: 6px; background: var(--bg3); border-radius: 3px; overflow: hidden; }
.level-fill { height: 100%; border-radius: 3px; width: 100%; }
.level-db { font-size: 11px; color: var(--text-dim); font-family: var(--font-mono); flex-shrink: 0; min-width: 52px; text-align: right; }

.ducker-config { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.param-label { font-size: 12px; color: var(--text-dim); }
.ok-text { font-size: 12px; color: var(--green); }

.tunnel-panel { display: flex; align-items: center; gap: 12px; border-radius: 6px; padding: 8px 14px; flex-shrink: 0; border: 1px solid var(--border); background: var(--bg2); flex-wrap: wrap; }
.tunnel-active  { border-color: rgba(74,222,128,.35); }
.tunnel-label { font-size: 11px; color: var(--text-dim); letter-spacing: .05em; flex-shrink: 0; }
.tunnel-url   { font-size: 12px; color: var(--green); flex: 1; word-break: break-all; }
.tunnel-hint  { font-size: 12px; color: var(--text-dim); }

.current-speech { background: var(--bg2); border: 1px solid var(--amber-dim); border-left: 3px solid var(--amber); border-radius: 6px; padding: 12px 16px; flex-shrink: 0; animation: pulse-border 2s ease-in-out infinite; }
@keyframes pulse-border { 0%,100% { border-left-color: var(--amber); } 50% { border-left-color: var(--amber-dim); } }
.current-label { font-size: 11px; color: var(--amber); letter-spacing: .08em; margin-bottom: 6px; }
.current-text  { font-size: 15px; line-height: 1.6; color: var(--text); }

.alert-banner { display: flex; align-items: center; gap: 12px; background: rgba(248,113,113,.08); border: 1px solid rgba(248,113,113,.4); border-radius: 6px; padding: 10px 16px; flex-shrink: 0; }
.alert-icon   { color: var(--red); font-size: 16px; flex-shrink: 0; }
.alert-msg    { color: var(--red); font-size: 13px; flex: 1; }
.alert-actions { display: flex; gap: 6px; flex-shrink: 0; }

.log-header { display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; }
.log-title  { font-size: 11px; color: var(--text-dim); letter-spacing: .08em; text-transform: uppercase; }
.clear-btn  { background: none; border: 1px solid var(--border); color: var(--text-dim); font-size: 11px; padding: 2px 10px; border-radius: 4px; cursor: pointer; }
.clear-btn:hover { border-color: var(--text-dim); color: var(--text); }

.log-area { flex: 1; overflow-y: auto; background: var(--bg2); border: 1px solid var(--border); border-radius: 6px; padding: 8px 0; font-family: var(--font-mono); font-size: 12px; }
.log-entry { display: flex; gap: 10px; align-items: baseline; padding: 3px 14px; border-left: 2px solid transparent; }
.log-entry:hover  { background: var(--bg3); }
.log-entry.speech, .log-entry.mp3 { border-left-color: var(--cyan); }
.log-entry.duck   { border-left-color: var(--amber); }
.log-entry.error  { border-left-color: var(--red); }
.log-entry.system { border-left-color: var(--text-dim); }
.log-entry.point  { border-left-color: var(--green); }
.log-entry.tour   { border-left-color: var(--cyan); }
.log-entry.robot  { border-left-color: var(--text-dim); }
.log-time { color: var(--text-dim); font-size: 11px; flex-shrink: 0; }
.log-tag  { font-size: 10px; font-weight: 600; letter-spacing: .05em; padding: 1px 6px; border-radius: 3px; flex-shrink: 0; background: var(--bg3); color: var(--text-dim); }
.log-entry.speech .log-tag, .log-entry.mp3 .log-tag { color: var(--cyan); }
.log-entry.duck   .log-tag { color: var(--amber); }
.log-entry.error  .log-tag { color: var(--red); }
.log-entry.point  .log-tag { color: var(--green); }
.log-entry.tour   .log-tag { color: var(--cyan); }
.log-msg { color: var(--text); flex: 1; word-break: break-all; white-space: pre-wrap; }
.log-empty { padding: 24px; color: var(--text-dim); text-align: center; }
</style>
