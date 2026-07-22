<template>
  <div class="cache-layout">
    <div class="cache-header">
      <div class="cache-title">语音下载库</div>
      <div class="cache-space-info">
        <span class="space-label">存储空间已用：{{ formatSize(totalSize) }} / 1.0 GB</span>
        <div class="space-progress-bar">
          <div class="space-progress" :class="{ warning: totalSize > 900 * 1024 * 1024 }" :style="{ width: spacePercentage + '%' }"></div>
        </div>
      </div>
    </div>

    <!-- Space Limit Warning Banner -->
    <div class="cache-warning-banner">
      ⚠ 语音包下载存储空间上限为 1G，请及时清理或导出到您的电脑。
    </div>

    <div v-if="!wsConnected" class="no-ws-banner">
      ⚠ 未连接到后端，请先启动后端服务
    </div>

    <!-- Cached Audio Table -->
    <div class="cache-table-wrap">
      <el-table :data="cacheList" style="width: 100%" height="100%" class="cache-table" size="small">
        <el-table-column prop="text" label="文本内容" min-width="300">
          <template #default="scope">
            <el-tooltip :content="scope.row.text" placement="top" :enterable="false">
              <span class="text-preview">{{ scope.row.text }}</span>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column prop="size" label="音频大小" width="100">
          <template #default="scope">
            {{ formatSize(scope.row.sizeBytes) }}
          </template>
        </el-table-column>
        <el-table-column prop="createdAt" label="生成时间" width="160">
          <template #default="scope">
            {{ formatTime(scope.row.createdAt) }}
          </template>
        </el-table-column>
        <el-table-column label="操作" width="220" fixed="right">
          <template #default="scope">
            <div class="action-btns">
              <el-button
                size="small"
                :type="playingHash === scope.row.hash ? 'success' : 'default'"
                plain
                @click="playAudio(scope.row)"
              >
                {{ playingHash === scope.row.hash ? '播放中...' : '播放' }}
              </el-button>
              <el-button
                size="small"
                type="primary"
                plain
                @click="exportAudio(scope.row)"
              >
                导出
              </el-button>
              <el-button
                size="small"
                type="danger"
                plain
                @click="deleteAudio(scope.row)"
              >
                删除
              </el-button>
            </div>
          </template>
        </el-table-column>
      </el-table>
      <div v-if="wsConnected && cacheList.length === 0" class="cache-empty">
        暂无已下载的语音数据，当系统正常播报或回复弹幕时，会自动收集并下载到此库中。
      </div>
    </div>

    <!-- Hidden audio element for preview -->
    <audio ref="audioPlayer" @ended="onAudioEnded" style="display: none;"></audio>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'

const props = defineProps({ wsRef: Object })

const cacheList = ref([])
const totalSize = ref(0)
const playingHash = ref(null)
const audioPlayer = ref(null)

const wsConnected = computed(() => !!props.wsRef && props.wsRef.readyState === 1)

const spacePercentage = computed(() => {
  const max = 1024 * 1024 * 1024 // 1GB
  const pct = (totalSize.value / max) * 100
  return Math.min(Math.max(pct, 0), 100)
})

// Listen to WebSocket messages
function handleWsMessage(e) {
  try {
    const msg = JSON.parse(e.data)
    const { type, data } = msg
    if (type === 'TTS_CACHE_LIST') {
      cacheList.value = data.items || []
      totalSize.value = data.totalSize || 0
    } else if (type === 'TTS_CACHE_PREVIEW') {
      if (data.base64) {
        playBase64(data.hash, data.base64)
      }
    } else if (type === 'TTS_CACHE_DELETED') {
      ElMessage.success('已删除语音缓存')
      fetchCacheList()
    } else if (type === 'TTS_HARVESTED') {
      // Background auto-refresh if a new voice was harvested
      fetchCacheList()
    }
  } catch (err) {
    // Ignore message parse errors
  }
}

// Watch connection state
watch(wsConnected, (val) => {
  if (val) {
    props.wsRef.addEventListener('message', handleWsMessage)
    fetchCacheList()
  }
}, { immediate: true })

onUnmounted(() => {
  if (props.wsRef) {
    props.wsRef.removeEventListener('message', handleWsMessage)
  }
  stopAudio()
})

function fetchCacheList() {
  if (!wsConnected.value) return
  send('GET_TTS_CACHE_LIST', {})
}

function send(type, data) {
  if (props.wsRef && props.wsRef.readyState === 1) {
    props.wsRef.send(JSON.stringify({ type, data }))
  }
}

function formatSize(bytes) {
  if (bytes === 0) return '0 KB'
  const k = 1024
  const sizes = ['Bytes', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  const num = (bytes / Math.pow(k, i)).toFixed(1)
  // Clean up display for standard Chinese users
  return `${num} ${sizes[i]}`
}

function formatTime(timestamp) {
  if (!timestamp) return '-'
  const date = new Date(timestamp)
  return date.toLocaleString('zh-CN', { hour12: false })
}

// Playing cached audio preview via base64 data url
async function playAudio(row) {
  if (playingHash.value === row.hash) {
    stopAudio()
    return
  }
  stopAudio()
  playingHash.value = row.hash
  send('PREVIEW_TTS_CACHE', { hash: row.hash })
}

function playBase64(hash, base64) {
  if (playingHash.value !== hash) return
  if (audioPlayer.value) {
    audioPlayer.value.src = 'data:audio/mp3;base64,' + base64
    audioPlayer.value.play().catch(err => {
      ElMessage.error('音频播放失败: ' + err.message)
      playingHash.value = null
    })
  }
}

function stopAudio() {
  if (audioPlayer.value) {
    audioPlayer.value.pause()
    audioPlayer.value.src = ''
  }
  playingHash.value = null
}

function onAudioEnded() {
  playingHash.value = null
}

async function exportAudio(row) {
  if (!window.api || !window.api.exportTtsAudio) {
    ElMessage.error('当前环境不支持导出文件')
    return
  }
  
  // Format a friendly default filename based on the text (up to 15 chars)
  const safeText = row.text.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '_').slice(0, 15)
  const defaultFilename = `${safeText || '语音'}.mp3`
  
  try {
    const success = await window.api.exportTtsAudio(row.hash, defaultFilename)
    if (success) {
      ElMessage.success('音频导出成功')
    }
  } catch (err) {
    ElMessage.error('导出失败: ' + err.message)
  }
}

async function deleteAudio(row) {
  try {
    await ElMessageBox.confirm('确定要删除这组语音及文本文件吗？', '确认删除', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    })
    send('DELETE_TTS_CACHE_ENTRY', { hash: row.hash })
  } catch {
    // Cancelled
  }
}
</script>

<style scoped>
.cache-layout {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 16px;
  gap: 12px;
}

.cache-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.cache-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text);
}

.cache-space-info {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
}

.space-label {
  font-size: 11px;
  color: var(--text-dim);
}

.space-progress-bar {
  width: 180px;
  height: 4px;
  background: var(--bg3);
  border-radius: 2px;
  overflow: hidden;
}

.space-progress {
  height: 100%;
  background: var(--green);
  border-radius: 2px;
}

.space-progress.warning {
  background: var(--red);
}

.cache-warning-banner {
  padding: 8px 12px;
  background: rgba(245, 158, 11, 0.1);
  border: 1px solid rgba(245, 158, 11, 0.2);
  border-radius: 4px;
  color: var(--amber);
  font-size: 12px;
}

.no-ws-banner {
  padding: 8px 12px;
  background: rgba(248, 113, 113, 0.1);
  border: 1px solid rgba(248, 113, 113, 0.2);
  border-radius: 4px;
  color: var(--red);
  font-size: 12px;
}

.cache-table-wrap {
  flex: 1;
  min-height: 0;
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
  position: relative;
}

.cache-table {
  background: transparent !important;
}

:deep(.el-table) {
  --el-table-bg-color: transparent !important;
  --el-table-tr-bg-color: transparent !important;
  --el-table-header-bg-color: var(--bg3) !important;
  --el-table-border-color: var(--border) !important;
  --el-table-text-color: var(--text) !important;
  --el-table-row-hover-bg-color: var(--bg3) !important;
}

.text-preview {
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.action-btns {
  display: flex;
  gap: 8px;
}

.cache-empty {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  color: var(--text-dim);
  font-size: 12px;
  text-align: center;
  pointer-events: none;
}
</style>
