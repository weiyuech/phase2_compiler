<template>
  <div class="audio-diagnostics">
    <div class="panel-header">音频诊断</div>
    <div class="diagnostics-body">
      <p class="intro">自动记录机器人连接、点位确认和音频时序，无需手动开启。出现问题后点击顶部“导出诊断日志”即可；故障前的近期记录会自动保留。</p>
      <div class="status" :class="{ warning: !connected || snapshot?.storage?.status === 'error' }">
        {{ statusText }}
        <span v-if="snapshot?.storage?.errorCode">（{{ snapshot.storage.errorCode }}）</span>
      </div>
      <p class="cadence" :class="{ warning: cadenceSlow }">{{ cadenceText }}</p>

      <div class="metrics">
        <div><span>已发送音频包</span><strong>{{ snapshot?.totals?.frames ?? '—' }}</strong></div>
        <div><span>累计最大发送间隔</span><strong>{{ milliseconds(snapshot?.totals?.maxGapMs) }}</strong></div>
        <div><span>最近 P99 间隔</span><strong>{{ milliseconds(snapshot?.lastSummary?.p99GapMs) }}</strong></div>
        <div><span>超过 50 ms 间隔</span><strong>{{ snapshot?.totals?.late50Count ?? '—' }}</strong></div>
        <div><span>最大发送积压</span><strong>{{ kilobytes(snapshot?.totals?.maxBufferedBytes) }}</strong></div>
        <div><span>诊断记录丢弃数</span><strong>{{ snapshot?.storage?.droppedRecords ?? '—' }}</strong></div>
        <div><span>最近发送速度</span><strong>{{ sendRate(snapshot?.lastSummary?.sendRateRatio) }}</strong></div>
        <div><span>最近发送音频时长</span><strong>{{ milliseconds(snapshot?.lastSummary?.audioDurationMs) }}</strong></div>
        <div><span>最近连续帧累计延后</span><strong>{{ milliseconds(snapshot?.lastSummary?.sendLagMs) }}</strong></div>
      </div>
      <p class="note">这里记录电脑向机器人发送音频的时序。机器人是否收到、何时播放及实际声音是否卡顿，目前没有回传确认；发送正常不代表实际播放正常。</p>
      <p class="note">发送速度 1.00× 表示与音频时长一致，按同一会话内连续帧计算，排除已记录的暂停和切换。最近统计通常约 1 秒；累计最大值不代表当前状态。</p>

      <div class="actions">
        <el-button :disabled="!connected" @click="markGlitch">刚才卡顿</el-button>
        <el-button type="primary" :loading="exporting" @click="exportReport">导出诊断日志</el-button>
      </div>
      <el-checkbox v-model="includeBackendLogs">同时包含原始后台日志</el-checkbox>
      <p class="note">默认导出已包含机器人连接与点位故障记录，无需勾选。原始后台日志仅用于进一步排查，可能包含业务文字。</p>

    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'

const props = defineProps({ wsRef: Object })
const snapshot = ref(null)
const snapshotReceivedAt = ref(null)
const observedAt = ref(performance.now())
const connected = ref(false)
const includeBackendLogs = ref(false)
const exporting = ref(false)
let socket = null
let poll = null

const statusText = computed(() => {
  if (!connected.value) return '后台未连接 · 可导出已有记录'
  if (snapshot.value?.storage?.status === 'error') return '诊断写入异常 · 音频播放不受诊断写入阻塞'
  if (!snapshot.value) return '正在读取自动诊断状态…'
  if (snapshot.value?.storage?.status === 'initializing') return '正在初始化自动诊断记录…'
  return '自动滚动记录中'
})
const milliseconds = value => Number.isFinite(value) ? `${value.toFixed(1)} ms` : '—'
const kilobytes = value => Number.isFinite(value) ? `${(value / 1024).toFixed(1)} KB` : '—'
const sendRate = value => Number.isFinite(value) ? `${value.toFixed(2)}×` : '—'
const summaryAgeMs = computed(() => {
  const capturedAt = snapshot.value?.lastSummary?.capturedAt
  const backendObservedAt = snapshot.value?.capturedAt
  if (!Number.isFinite(capturedAt) || !Number.isFinite(backendObservedAt) || backendObservedAt < capturedAt) return null
  // Keep aging a sample even if the backend stalls with its socket still open.
  // Monotonic local elapsed time also avoids comparing two machines' clocks.
  const localElapsed = snapshotReceivedAt.value === null ? 0 : Math.max(0, observedAt.value - snapshotReceivedAt.value)
  return backendObservedAt - capturedAt + localElapsed
})
const cadenceSlow = computed(() => {
  const summary = snapshot.value?.lastSummary
  return connected.value && summaryAgeMs.value !== null && summaryAgeMs.value <= 3000
    && summary?.cadenceSamples >= 10 && summary?.activeSendMs >= 200
    && Number.isFinite(summary?.sendRateRatio) && summary.sendRateRatio < 0.90
})
const cadenceText = computed(() => {
  if (!snapshot.value?.lastSummary) return '尚无发送统计。'
  if (!connected.value) return '后台已断开，以下保留上次发送统计。'
  if (summaryAgeMs.value === null) return '以下为最近一次发送统计，未提供采样时间。'
  if (summaryAgeMs.value > 3000) return `最近统计距今 ${Math.floor(summaryAgeMs.value / 1000)} 秒，尚未收到更新的发送样本。`
  if (cadenceSlow.value) return '最近一段电脑端发送偏慢。机器人缓冲可能吸收这段延迟，不能据此判定实际声音卡顿。'
  return '以下为最近一次发送统计，不能据此确认机器人实际播放效果。'
})
function requestSnapshot() {
  observedAt.value = performance.now()
  connected.value = socket?.readyState === WebSocket.OPEN
  if (connected.value) {
    try { socket.send(JSON.stringify({ type: 'GET_AUDIO_DIAGNOSTICS' })) } catch { connected.value = false }
  }
}
function onMessage(event) {
  try {
    const message = JSON.parse(event.data)
    if (message.type === 'AUDIO_DIAGNOSTICS') {
      snapshotReceivedAt.value = performance.now()
      observedAt.value = snapshotReceivedAt.value
      snapshot.value = message.data?.snapshot || message.data
    }
  } catch { /* ignore unrelated messages */ }
}
function onClose() { connected.value = false }
function detach() {
  clearInterval(poll)
  socket?.removeEventListener('message', onMessage)
  socket?.removeEventListener('open', requestSnapshot)
  socket?.removeEventListener('close', onClose)
}
watch(() => props.wsRef, value => {
  detach()
  socket = value || null
  socket?.addEventListener('message', onMessage)
  socket?.addEventListener('open', requestSnapshot)
  socket?.addEventListener('close', onClose)
  requestSnapshot()
  poll = setInterval(requestSnapshot, 2000)
}, { immediate: true })
function markGlitch() {
  if (socket?.readyState !== WebSocket.OPEN) { ElMessage.error('后台未连接，仍可直接导出已有记录'); return }
  try {
    socket.send(JSON.stringify({ type: 'MARK_AUDIO_GLITCH' }))
    ElMessage.success('已发送卡顿时间标记')
  } catch { ElMessage.error('后台未连接，仍可直接导出已有记录') }
}
async function exportReport() {
  if (!window.api?.exportDiagnostics) { ElMessage.error('请在桌面客户端中导出诊断文件'); return }
  exporting.value = true
  try {
    const result = await window.api.exportDiagnostics({ includeBackendLogs: includeBackendLogs.value })
    if (result?.ok) ElMessage.success('诊断文件已保存，文件夹已打开')
    else if (result?.error !== '已取消') ElMessage.error(result?.error || '导出失败')
  } catch { ElMessage.error('导出失败，请稍后重试') }
  finally { exporting.value = false }
}
onBeforeUnmount(detach)
</script>

<style scoped>
.audio-diagnostics { min-width: 0; }
.panel-header { padding: 20px 24px; font-size: 16px; font-weight: 600; border-bottom: 1px solid var(--border); }
.diagnostics-body { padding: 20px 24px; max-width: 850px; }
.intro { margin: 0 0 16px; font-size: 13px; line-height: 1.7; }
.status { color: var(--green); font-size: 13px; margin-bottom: 16px; }
.warning { color: var(--amber); }
.cadence { margin: 0 0 16px; font-size: 13px; line-height: 1.7; }
.diagnostics-body :deep(.el-checkbox__label) { color: var(--text-dim); }
.metrics { display: grid; grid-template-columns: repeat(3, minmax(120px, 1fr)); gap: 10px; }
.metrics > div { background: var(--bg2); border: 1px solid var(--border); border-radius: 6px; padding: 12px; }
.metrics span { display: block; font-size: 11px; color: var(--text-dim); }
.metrics strong { display: block; margin-top: 8px; font-size: 18px; font-family: var(--font-mono); }
.note { font-size: 12px; line-height: 1.7; color: var(--text-dim); }
.actions { display: flex; gap: 10px; margin: 18px 0 12px; }
@media (max-width: 800px) { .metrics { grid-template-columns: repeat(2, minmax(110px, 1fr)); } }
</style>
