<template>
  <div class="controls-layout">
    <div class="controls-toolbar">
      <section class="tour-control" aria-label="巡游控制">
        <div class="control-heading">
          <div class="card-title">巡游控制</div>
          <div class="status-pill" :class="tourStatusClass">
            {{ tourStatusLabel }}
            <span v-if="(tourStatus === 'running' || tourStatus === 'paused') && repeatCount > 1">
              · 第 {{ currentIteration }} / {{ repeatCount }} 轮
            </span>
          </div>
        </div>
        <div class="btn-row">
          <template v-if="tourStatus === 'idle' || tourStatus === 'finished'">
            <el-button type="primary" :disabled="!wsConnected" @click="startTour">▶ 开始巡游</el-button>
            <div class="repeat-input">
              <span class="repeat-label">循环</span>
              <el-input-number
                v-model="repeatCount" :min="1" :max="999" :precision="0" :step="1"
                size="default" controls-position="right" aria-label="巡游循环次数"
              />
              <span class="repeat-label">次</span>
            </div>
          </template>
          <el-button v-if="tourStatus === 'running'" type="warning" :disabled="!wsConnected" @click="send('PAUSE_TOUR')">⏸ 暂停巡游</el-button>
          <el-button v-if="tourStatus === 'paused'" type="primary" :disabled="!wsConnected" @click="send('RESUME_TOUR')">▶ 继续巡游</el-button>
          <el-button v-if="tourStatus === 'running' || tourStatus === 'paused'" type="danger" :disabled="!wsConnected" @click="send('STOP_TOUR')">⏹ 停止巡游</el-button>
          <el-button v-if="tourStatus === 'running' || tourStatus === 'paused'" :disabled="!wsConnected" @click="send('SKIP_POINT')">⏭ 跳过点位</el-button>
        </div>
      </section>

      <section class="broadcast-control" aria-label="播报控制">
        <div class="control-heading">
          <div class="card-title">播报控制</div>
        </div>
        <div class="btn-row">
          <el-button :type="isPaused ? 'primary' : 'danger'" :disabled="!wsConnected" @click="togglePause">
            {{ isPaused ? '▶ 恢复播报' : '⏸ 暂停播报' }}
          </el-button>
        </div>
      </section>
    </div>

    <div class="controls-grid">
      <section class="control-card transit-card" aria-label="过渡音频">
        <TransitAudioSettings :ws-ref="props.wsRef" />
      </section>

      <div class="controls-side">
        <section class="control-card barrage-card" aria-label="弹幕识别">
          <div class="control-heading">
            <div class="card-title">弹幕识别</div>
            <label class="header-switch">
              <span>启用</span>
              <el-switch
                v-model="barrageEnabled"
                size="small"
                aria-label="启用弹幕识别"
                :disabled="!canCaptureBarrage"
                @change="onBarrageToggle"
              />
            </label>
          </div>
          <p v-if="barrageEnabled" class="ocr-status" :class="{ ready: ocrReady }">{{ ocrStatusMsg }}</p>
          <div class="control-field">
            <span>播报冷却</span>
            <div class="cooldown-input">
              <el-input-number
                v-model="barrageCooldown" :min="0" :max="3000" :precision="0" :step="1"
                size="small" controls-position="right" aria-label="播报冷却时间"
                @change="onCooldownChange"
              />
              <span>秒</span>
            </div>
          </div>
          <div v-if="barrageEnabled && barrageRegion" class="hint">
            当前截取区域: X:{{ barrageRegion.x }} Y:{{ barrageRegion.y }} W:{{ barrageRegion.width }} H:{{ barrageRegion.height }}
          </div>
          <div v-if="barrageEnabled && currentCapturedText" class="hint captured-text">
            当前截取文本: {{ currentCapturedText }}
          </div>
          <div class="card-footer">
            <el-button text size="small" class="log-download" @click="downloadBarrageLog">下载识别日志 (.txt)</el-button>
          </div>
        </section>

        <section class="control-card test-card" aria-label="手动播报测试">
          <div class="control-heading"><div class="card-title">手动播报测试</div></div>
          <el-input v-model="testText" placeholder="输入测试文本..." type="textarea" :rows="3" />
          <div class="btn-row test-actions">
            <el-button :disabled="!canTestSpeech" @click="sendTestSpeech">发送播报</el-button>
          </div>
          <p v-if="tourIsActive" class="hint">请先停止巡游，再进行手动播报测试</p>
        </section>
      </div>
    </div>

    <div v-if="!wsConnected" class="no-ws-banner">
      <div>⚠ 未连接到后端，应用启动后稍等片刻将自动连接</div>
      <div style="margin-top: 8px; font-weight: normal;">
        如果一直连不上，请点下面的按钮导出诊断日志，并把生成的文件发给技术支持
      </div>
      <el-button size="small" plain style="margin-top: 8px;" @click="exportDiagnostics">导出诊断日志 (.txt)</el-button>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onUnmounted, reactive } from 'vue'
import { ElMessage } from 'element-plus'
import TransitAudioSettings from './TransitAudioSettings.vue'

const props = defineProps({ wsRef: Object })

// --- State ---
const isPaused   = ref(false)
const testText   = ref('')
const tourStatus = ref('idle')   // idle | running | paused | finished
const tourStateKnown = ref(false)
const tourIsActive = computed(() => tourStatus.value === 'running' || tourStatus.value === 'paused')

const barrageEnabled = ref(false)
const barrageRegion = ref(null)
const barrageStartPending = ref(false)
const ownsBarrageCapture = ref(false)
const ocrReady = computed(() => barrageEnabled.value && Boolean(barrageRegion.value) && !barrageStartPending.value)
const ocrStatusMsg = computed(() => {
  if (barrageStartPending.value) return '正在启动'
  if (barrageRegion.value) return '识别中'
  return '请选择识别区域'
})
const currentCapturedText = ref('')
const barrageCooldown = ref(0)
const repeatCount = ref(1)  // How many full passes through the tour list
const currentIteration = ref(0)
const canCaptureBarrage = Boolean(
  window.api?.openBarrageOverlay &&
  window.api?.getScreenSourceId &&
  window.api?.onBarrageRegionSelected
)

// --- WebSocket ---
const wsConnected = ref(false)
const canTestSpeech = computed(() => wsConnected.value && tourStateKnown.value && !tourIsActive.value && !!testText.value.trim())

function send(type, data = {}) {
  const socket = props.wsRef?.value || props.wsRef;
  if (!socket || socket.readyState !== 1) {
    console.error('[WebSocket Error] Socket not ready. State:', socket?.readyState, 'Type:', type);
    return;
  }
  console.log('[WebSocket Send]', type, data);
  socket.send(JSON.stringify({ type, data }));
}

function handleMessage(raw) {
  try {
    const { type, data } = JSON.parse(raw)
    switch (type) {
      case 'TOUR_STATE':
        if (typeof data?.running !== 'boolean' || typeof data?.paused !== 'boolean') break
        tourStatus.value = data.running ? (data.paused ? 'paused' : 'running') : 'idle'
        if (typeof data.repeatCount === 'number') repeatCount.value = data.repeatCount
        if (typeof data.currentIteration === 'number') currentIteration.value = data.currentIteration
        tourStateKnown.value = true
        break
      case 'TOUR_STARTED':
        tourStatus.value = 'running'
        if (data && typeof data.repeatCount === 'number') repeatCount.value = data.repeatCount
        currentIteration.value = 1
        break
      case 'TOUR_ITERATION':
        if (data && typeof data.currentIteration === 'number') currentIteration.value = data.currentIteration
        if (data && typeof data.repeatCount === 'number') repeatCount.value = data.repeatCount
        break
      case 'TOUR_PAUSED':   tourStatus.value = 'paused';   break
      case 'TOUR_RESUMED':  tourStatus.value = 'running';  break
      case 'TOUR_STOPPED':  tourStatus.value = 'idle';     currentIteration.value = 0; break
      case 'TOUR_FINISHED': tourStatus.value = 'finished'; currentIteration.value = 0; break
      case 'STATUS':
        if (data.paused !== undefined) isPaused.value = data.paused
        break
      case 'BARRAGE_CONFIG':
        if (data && data.cooldown !== undefined) {
          barrageCooldown.value = data.cooldown
        }
        break
      case 'BARRAGE_CONFIG_SAVED':
        if (data && data.cooldown !== undefined) {
          barrageCooldown.value = data.cooldown
        }
        break
      case 'BARRAGE_CURRENT_TEXT':
        currentCapturedText.value = data.text || ''
        break
      case 'BARRAGE_START':
        barrageEnabled.value = true
        barrageRegion.value = data || null
        barrageStartPending.value = false
        break
      case 'BARRAGE_STOP':
        barrageEnabled.value = false
        barrageRegion.value = null
        barrageStartPending.value = false
        ownsBarrageCapture.value = false
        currentCapturedText.value = ''
        break
      case 'ERROR':
        if (/OCR|弹幕识别/.test(data?.message || '')) {
          barrageStartPending.value = false
          ElMessage.error(data.message)
        }
        break

    }
  } catch { /* ignore */ }
}

let currentSocket = null
function detachSocket() {
  currentSocket?.removeEventListener('message', onMsg)
  currentSocket?.removeEventListener('open', onSocketOpen)
  currentSocket?.removeEventListener('close', onSocketClose)
}
function onSocketOpen() {
  wsConnected.value = currentSocket?.readyState === 1
  if (!wsConnected.value) return
  tourStateKnown.value = false
  send('GET_TOUR_STATE')
  send('GET_BARRAGE_CONFIG')
  // The backend process does not persist the selected screen rectangle. If it
  // restarted while this renderer/capture survived, restore the active OCR
  // session through the normal authoritative START echo.
  if (canCaptureBarrage && ownsBarrageCapture.value && barrageEnabled.value && barrageRegion.value) {
    send('BARRAGE_START', barrageRegion.value)
  }
}
function onSocketClose() {
  wsConnected.value = false
  tourStateKnown.value = false
}
watch(() => props.wsRef?.value || props.wsRef, (socket) => {
  detachSocket()
  currentSocket = socket || null
  wsConnected.value = false
  tourStateKnown.value = false
  if (!currentSocket) return
  currentSocket.addEventListener('message', onMsg)
  currentSocket.addEventListener('close', onSocketClose)
  if (currentSocket.readyState === 1) onSocketOpen()
  else currentSocket.addEventListener('open', onSocketOpen, { once: true })
}, { immediate: true })

function onMsg(e) { handleMessage(e.data) }

// --- Actions ---
async function onBarrageToggle(val) {
  if (!canCaptureBarrage) {
    // A browser may mirror an active native session. It must not turn that
    // shared session off, nor start a capture it cannot own.
    barrageEnabled.value = Boolean(barrageRegion.value)
    if (val) ElMessage.warning('浏览器预览无法截取屏幕，请在 Electron 窗口使用弹幕识别')
    return
  }
  if (val) {
    barrageStartPending.value = false
    try {
      await window.api.openBarrageOverlay()
    } catch (error) {
      barrageEnabled.value = false
      ownsBarrageCapture.value = false
      ElMessage.error(`无法打开弹幕选区：${error?.message || error}`)
    }
  } else {
    barrageStartPending.value = false
    barrageRegion.value = null
    currentCapturedText.value = ''
    send('BARRAGE_STOP')
    ElMessage.info('弹幕识别已关闭')
  }
}

async function exportDiagnostics() {
  const res = await window.api?.exportDiagnostics?.()
  if (res?.ok) {
    ElMessage.success({ message: `已保存到桌面，请发给技术支持：\n${res.path}`, duration: 8000 })
  } else if (res?.error && res.error !== '已取消') {
    ElMessage.error(`导出失败: ${res.error}`)
  }
}

async function downloadBarrageLog() {
  if (!window.api) return
  try {
    const res = await window.api.downloadBarrageLog()
    if (res.ok) {
      ElMessage.success('日志下载成功')
    } else {
      ElMessage.warning(res.error || '下载失败')
    }
  } catch (err) {
    ElMessage.error(`下载失败: ${err.message}`)
  }
}

function startTour() {
  const n = Math.max(1, Math.floor(Number(repeatCount.value)) || 1)
  currentIteration.value = 1
  send('START_TOUR', { repeatCount: n })
}

function togglePause() {
  if (isPaused.value) {
    send('RESUME'); isPaused.value = false; ElMessage.success('播报已恢复')
  } else {
    send('PAUSE');  isPaused.value = true;  ElMessage.warning('播报已暂停')
  }
}

function sendTestSpeech() {
  if (tourIsActive.value) {
    ElMessage.warning('请先停止巡游，再进行手动播报测试')
    return
  }
  if (!canTestSpeech.value) return
  send('TEST_SPEECH', { text: testText.value.trim() })
  ElMessage.info('已发送测试播报')
  testText.value = ''
}

function onCooldownChange(val) {
  if (val === null || val === undefined || isNaN(val)) {
    ElMessage.error('请输入有效的冷却时间')
    return
  }
  
  const num = parseInt(val, 10)
  if (num < 0 || num > 3000) {
    ElMessage.error('冷却时间必须在 0 到 3000 秒之间')
    return
  }

  send('SET_BARRAGE_CONFIG', {
    cooldown: num
  })
}

let removeBarrageRegionListener = null
// Global hook for results (in case App.vue logic needs to share state)
if (window.api && window.api.onBarrageRegionSelected) {
  removeBarrageRegionListener = window.api.onBarrageRegionSelected((rect) => {
    if (rect) {
      console.log('--- OCR TRIGGER: Confirm Clicked ---')
      ownsBarrageCapture.value = true
      barrageRegion.value = rect
      barrageStartPending.value = true
      ElMessage.info('弹幕区域已选中，正在启动识别…')
      // LiveMonitor owns capture/start; this card waits for backend confirmation.
    } else {
      ownsBarrageCapture.value = false
      barrageStartPending.value = false
      barrageEnabled.value = false
      barrageRegion.value = null
      currentCapturedText.value = ''
    }
  })
}

onUnmounted(() => {
  detachSocket()
  removeBarrageRegionListener?.()
  removeBarrageRegionListener = null
})

// --- Computed ---
const tourStatusLabel = computed(() => ({
  idle:     '待机',
  running:  '巡游中',
  paused:   '已暂停',
  finished: '已完成',
}[tourStatus.value] ?? '—'))

const tourStatusClass = computed(() => ({
  idle:     'dim',
  running:  'running',
  paused:   'paused',
  finished: 'dim',
}[tourStatus.value]))

</script>

<style scoped>
.controls-layout {
  height: 100%;
  padding: 16px;
  overflow-y: auto;
  container: broadcast-controls / inline-size;
  --control-columns: minmax(0, 1.65fr) minmax(0, 1fr);
}
.controls-toolbar {
  display: grid;
  grid-template-columns: var(--control-columns);
  column-gap: 14px;
  margin-bottom: 14px;
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: 8px;
}
.tour-control, .broadcast-control { min-width: 0; padding: 16px 20px; }
.broadcast-control { border-left: 1px solid var(--border); }
.controls-grid { display: grid; grid-template-columns: var(--control-columns); gap: 14px; align-items: start; }
.controls-side { display: grid; gap: 14px; min-width: 0; }
.control-card { min-width: 0; background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; padding: 18px 20px; }
.control-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
.card-title { font-size: 13px; font-weight: 600; color: var(--text); letter-spacing: .03em; }
.btn-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.btn-row :deep(.el-button + .el-button) { margin-left: 0; }
.repeat-input, .cooldown-input { display: flex; align-items: center; gap: 8px; }
.repeat-input { margin-left: 4px; }
.repeat-input :deep(.el-input-number) { width: 88px; }
.cooldown-input :deep(.el-input-number) { width: 80px; }
.repeat-label, .header-switch, .control-field { font-size: 12px; color: var(--text-dim); }
.header-switch { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.header-switch :deep(.el-switch) { --el-switch-on-color: var(--amber); }
.control-field { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
.ocr-status { font-size: 11px; color: var(--amber); margin: -4px 0 12px; }
.ocr-status.ready { color: var(--green); }
.hint { font-size: 11px; color: var(--text-dim); margin-top: 12px; overflow-wrap: anywhere; }
.captured-text { color: var(--amber); }
.card-footer { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--border); }
.log-download { padding: 0; min-height: 24px; height: auto; color: var(--text-dim); }
.test-actions { margin-top: 12px; }
.status-pill { display: inline-flex; flex-wrap: wrap; font-size: 11px; padding: 2px 9px; border-radius: 20px; }
.status-pill.running { background: rgba(74,222,128,.12); color: var(--green); }
.status-pill.paused { background: rgba(245,158,11,.12); color: var(--amber); }
.status-pill.dim { background: var(--bg3); color: var(--text-dim); }
.no-ws-banner { margin-top: 14px; background: rgba(245,158,11,.08); border: 1px solid var(--amber-dim); border-radius: 8px; padding: 14px 18px; color: var(--amber); font-size: 13px; }
@container broadcast-controls (max-width: 760px) {
  .controls-toolbar, .controls-grid { grid-template-columns: minmax(0, 1fr); }
  .broadcast-control { border-left: 0; border-top: 1px solid var(--border); }
}
</style>
