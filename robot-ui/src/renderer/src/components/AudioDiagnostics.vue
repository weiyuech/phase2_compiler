<template>
  <div class="audio-diagnostics">
    <div class="panel-header">音频诊断</div>
    <div class="diagnostics-body">
      <p class="intro">自动记录机器人连接、点位确认和音频时序，无需手动开启。出现问题后点击顶部“导出诊断日志”即可；故障前的近期记录会自动保留。</p>
      <div class="status" :class="{ warning: !connected || snapshot?.storage?.status === 'error' }">
        {{ statusText }}
        <span v-if="snapshot?.storage?.errorCode">（{{ snapshot.storage.errorCode }}）</span>
      </div>

      <div class="metrics">
        <div><span>已发送音频包</span><strong>{{ snapshot?.totals?.frames ?? '—' }}</strong></div>
        <div><span>最大发送间隔</span><strong>{{ milliseconds(snapshot?.totals?.maxGapMs) }}</strong></div>
        <div><span>最近 P99 间隔</span><strong>{{ milliseconds(snapshot?.lastSummary?.p99GapMs) }}</strong></div>
        <div><span>超过 50 ms 间隔</span><strong>{{ snapshot?.totals?.late50Count ?? '—' }}</strong></div>
        <div><span>最大发送积压</span><strong>{{ kilobytes(snapshot?.totals?.maxBufferedBytes) }}</strong></div>
        <div><span>诊断记录丢弃数</span><strong>{{ snapshot?.storage?.droppedRecords ?? '—' }}</strong></div>
      </div>
      <p class="note">包间隔仅反映机器人发送时序，详细事件保留在日志中。</p>

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
function requestSnapshot() {
  connected.value = socket?.readyState === WebSocket.OPEN
  if (connected.value) {
    try { socket.send(JSON.stringify({ type: 'GET_AUDIO_DIAGNOSTICS' })) } catch { connected.value = false }
  }
}
function onMessage(event) {
  try {
    const message = JSON.parse(event.data)
    if (message.type === 'AUDIO_DIAGNOSTICS') snapshot.value = message.data?.snapshot || message.data
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
.diagnostics-body :deep(.el-checkbox__label) { color: var(--text-dim); }
.metrics { display: grid; grid-template-columns: repeat(3, minmax(120px, 1fr)); gap: 10px; }
.metrics > div { background: var(--bg2); border: 1px solid var(--border); border-radius: 6px; padding: 12px; }
.metrics span { display: block; font-size: 11px; color: var(--text-dim); }
.metrics strong { display: block; margin-top: 8px; font-size: 18px; font-family: var(--font-mono); }
.note { font-size: 12px; line-height: 1.7; color: var(--text-dim); }
.actions { display: flex; gap: 10px; margin: 18px 0 12px; }
@media (max-width: 800px) { .metrics { grid-template-columns: repeat(2, minmax(110px, 1fr)); } }
</style>
