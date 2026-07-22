<template>
  <div class="controls-layout">
    <div class="controls-grid">

      <!-- Tour control card -->
      <div class="control-card big tour-card">
        <div class="card-title">巡游控制</div>
        <div class="card-desc">开始巡游后机器人将按清单依次前往各点位，到达后自动播报，播完自动前往下一个。</div>
        <div class="btn-row">
          <el-button
            v-if="tourStatus === 'idle' || tourStatus === 'finished'"
            type="primary" size="large" :disabled="!wsConnected"
            @click="send('START_TOUR')"
          >▶  开始巡游</el-button>

          <el-button
            v-if="tourStatus === 'running'"
            type="warning" size="large" :disabled="!wsConnected"
            @click="send('PAUSE_TOUR')"
          >⏸  暂停巡游</el-button>

          <el-button
            v-if="tourStatus === 'paused'"
            type="primary" size="large" :disabled="!wsConnected"
            @click="send('RESUME_TOUR')"
          >▶  继续巡游</el-button>

          <el-button
            v-if="tourStatus === 'running' || tourStatus === 'paused'"
            type="danger" size="large" :disabled="!wsConnected"
            @click="send('STOP_TOUR')"
          >⏹  停止巡游</el-button>

          <el-button
            v-if="tourStatus === 'running' || tourStatus === 'paused'"
            size="large" :disabled="!wsConnected"
            @click="send('SKIP_POINT')"
          >⏭  跳过点位</el-button>
        </div>
        <div class="status-pill" :class="tourStatusClass">{{ tourStatusLabel }}</div>
      </div>

      <!-- Pause broadcast card -->
      <div class="control-card">
        <div class="card-title">播报控制</div>
        <div class="card-desc">暂停时机器人停止当前队列中的新播报，正在播放的语音会完成后停止。</div>
        <div class="btn-row">
          <el-button
            :type="isPaused ? 'primary' : 'danger'"
            size="large" :disabled="!wsConnected"
            @click="togglePause"
          >
            {{ isPaused ? '▶  恢复播报' : '⏸  暂停播报' }}
          </el-button>
        </div>
        <div class="status-pill" :class="isPaused ? 'paused' : 'running'">
          {{ isPaused ? '已暂停' : '运行中' }}
        </div>
      </div>

      <!-- Barrage OCR card -->
      <div class="control-card">
        <div class="card-title">弹幕识别</div>
        <div class="card-desc">开启弹幕识别，自动截取弹幕区域并进行OCR。开启时会弹出透明遮罩层让你框选区域。</div>
        
        <div style="display: flex; align-items: center; justify-content: space-between;">
          <span style="font-size: 13px; color: var(--text);">启用弹幕识别</span>
          <div style="display: flex; align-items: center; gap: 8px;">
            <span v-if="barrageEnabled" :style="{ fontSize: '11px', color: ocrReady ? 'var(--green)' : 'var(--amber)' }">
              {{ ocrStatusMsg }}
            </span>
            <el-switch v-model="barrageEnabled" @change="onBarrageToggle" active-color="#f59e0b" inactive-color="#30363d" />
          </div>
        </div>

        <div v-if="barrageEnabled && barrageRegion" class="hint" style="margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border);">
          当前截取区域: X:{{ barrageRegion.x }} Y:{{ barrageRegion.y }} W:{{ barrageRegion.width }} H:{{ barrageRegion.height }}
        </div>

        <div v-if="barrageEnabled && currentCapturedText" class="hint" style="margin-top: 8px; color: var(--amber);">
          当前截取文本: {{ currentCapturedText }}
        </div>
 
        <div style="margin-top: 12px; display: flex; align-items: center; justify-content: space-between;">
          <span style="font-size: 13px; color: var(--text);">播报冷却时间 (秒)</span>
          <el-input-number
            v-model="barrageCooldown"
            :min="0"
            :max="3000"
            :precision="0"
            :step="1"
            size="small"
            controls-position="right"
            style="width: 100px;"
            @change="onCooldownChange"
          />
        </div>

        <div style="margin-top: 14px;">
          <el-button 
            type="primary" 
            plain 
            size="small" 
            style="width: 100%;" 
            @click="downloadBarrageLog"
          >
            下载识别日志 (.txt)
          </el-button>
        </div>
      </div>

      <div class="control-card">
        <div class="card-title">手动播报测试</div>
        <div class="card-desc">直接发送一段文本让机器人播报，用于测试语音和音频链路</div>
        <el-input v-model="testText" placeholder="输入测试文本..." type="textarea" :rows="3" />
        <div class="btn-row" style="margin-top:10px">
          <el-button type="primary" :disabled="!wsConnected || !testText.trim()" @click="sendTestSpeech">
            发送播报
          </el-button>
        </div>
      </div>

      <div v-if="!wsConnected" class="no-ws-banner">
        ⚠ 未连接到后端，应用启动后稍等片刻将自动连接
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onUnmounted, reactive } from 'vue'
import { ElMessage } from 'element-plus'

const props = defineProps({ wsRef: Object })

// --- State ---
const isPaused   = ref(false)
const testText   = ref('')
const tourStatus = ref('idle')   // idle | running | paused | finished

const ocrReady = ref(true) // Backend handles this now
const ocrStatusMsg = ref('处理中')
const barrageEnabled = ref(false)
const barrageRegion = ref(null)
const currentCapturedText = ref('')
const barrageCooldown = ref(0)

// --- WebSocket ---
const wsConnected = computed(() => !!props.wsRef && props.wsRef.readyState === 1)

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
      case 'TOUR_STARTED':  tourStatus.value = 'running';  break
      case 'TOUR_PAUSED':   tourStatus.value = 'paused';   break
      case 'TOUR_RESUMED':  tourStatus.value = 'running';  break
      case 'TOUR_STOPPED':  tourStatus.value = 'idle';     break
      case 'TOUR_FINISHED': tourStatus.value = 'finished'; break
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

    }
  } catch { /* ignore */ }
}

let currentSocket = null
watch(() => props.wsRef, (socket) => {
  if (currentSocket) currentSocket.removeEventListener('message', onMsg)
  const realSocket = socket?.value || socket
  if (realSocket) {
    currentSocket = realSocket
    realSocket.addEventListener('message', onMsg)
    if (realSocket.readyState === 1) {
      send('GET_BARRAGE_CONFIG')
    } else {
      realSocket.addEventListener('open', () => {
        send('GET_BARRAGE_CONFIG')
      }, { once: true })
    }
  }
}, { immediate: true })

function onMsg(e) { handleMessage(e.data) }
onUnmounted(() => { currentSocket?.removeEventListener('message', onMsg) })

// --- Actions ---
function onBarrageToggle(val) {
  if (val) {
    window.api.openBarrageOverlay()
  } else {
    barrageRegion.value = null
    currentCapturedText.value = ''
    send('BARRAGE_STOP')
    ElMessage.info('弹幕识别已关闭')
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

function togglePause() {
  if (isPaused.value) {
    send('RESUME'); isPaused.value = false; ElMessage.success('播报已恢复')
  } else {
    send('PAUSE');  isPaused.value = true;  ElMessage.warning('播报已暂停')
  }
}

function sendTestSpeech() {
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

// Global hook for results (in case App.vue logic needs to share state)
if (window.api && window.api.onBarrageRegionSelected) {
  window.api.onBarrageRegionSelected((rect) => {
    if (rect) {
      console.log('--- OCR TRIGGER: Confirm Clicked ---')
      barrageRegion.value = rect
      ElMessage.success('已选中弹幕区域，开始截取...')
      // Signal already handled by App.vue, but we update UI state here
    } else {
      barrageEnabled.value = false
      barrageRegion.value = null
      currentCapturedText.value = ''
    }
  })
}

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
.controls-layout { height: 100%; padding: 16px; overflow-y: auto; }
.controls-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 12px; align-content: start;
}
.control-card { background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; padding: 18px 20px; }
.control-card.big { grid-column: span 2; display: flex; flex-direction: column; }
.tour-card { border-color: rgba(74,222,128,.2); }
.card-title { font-size: 13px; font-weight: 600; color: var(--amber); letter-spacing: .05em; margin-bottom: 8px; }
.tour-card .card-title { color: var(--green); }
.card-desc  { font-size: 12px; color: var(--text-dim); line-height: 1.5; margin-bottom: 16px; }
.btn-row    { display: flex; gap: 8px; flex-wrap: wrap; }
.slider-row { padding: 8px 0 4px; }
.hint       { font-size: 11px; color: var(--text-dim); margin-top: 4px; font-family: var(--font-mono); }
.status-pill { display: inline-block; margin-top: 14px; font-size: 11px; font-weight: 600; letter-spacing: .08em; padding: 3px 12px; border-radius: 20px; }
.status-pill.running  { background: rgba(74,222,128,.15);  color: var(--green);    border: 1px solid rgba(74,222,128,.3); }
.status-pill.paused   { background: rgba(245,158,11,.15);  color: var(--amber);    border: 1px solid rgba(245,158,11,.3); }
.status-pill.dim      { background: var(--bg3);            color: var(--text-dim); border: 1px solid var(--border); }
.no-ws-banner { grid-column: 1/-1; background: rgba(245,158,11,.08); border: 1px solid var(--amber-dim); border-radius: 8px; padding: 14px 18px; color: var(--amber); font-size: 13px; }
</style>
