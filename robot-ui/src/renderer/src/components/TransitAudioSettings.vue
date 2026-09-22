<template>
  <div class="transit-settings">
    <div class="panel-header">
      <span>过渡音频</span>
      <label class="header-switch">
        <span>启用</span>
        <el-switch v-model="transitConfig.enabled" size="small" aria-label="启用过渡音频" />
      </label>
    </div>
    <div class="panel-body">
      <div v-if="configLoadError" role="alert">
        <p class="param-hint">{{ configLoadError }}</p>
        <el-button size="small" @click="loadTransitConfig(props.wsRef)">重新加载</el-button>
      </div>
      <p v-else-if="!props.wsRef || props.wsRef.readyState !== 1" class="param-hint" role="status">后端未连接，连接后会自动加载过渡音频设置。</p>
      <p v-else-if="!configLoaded" class="param-hint" role="status">正在加载过渡音频设置；未收到回复时将自动重试。</p>
      <p v-else-if="!transitConfig.enabled" class="param-hint">过渡音频未启用。填写播报文字或添加音频文件后，开启并保存。</p>
      <div class="params-grid">
        <span class="param-label">音频类型</span>
        <el-radio-group v-model="transitConfig.type" size="small">
          <el-radio-button value="tts">TTS 文字</el-radio-button>
          <el-radio-button value="mp3">音频文件</el-radio-button>
        </el-radio-group>

        <template v-if="transitConfig.type === 'tts'">
          <span class="param-label field-top">播报文字</span>
          <div class="field-content">
            <el-input
              v-model="transitConfig.text" type="textarea" :rows="3"
              placeholder="例：正在前往下一个展区，请稍候……" class="transit-input"
            />
            <p class="param-hint">每次启动时改写一次并合成，循环播放。凭据和音色使用“系统设置 → 过渡音频与手动播报”。</p>
          </div>
        </template>

        <template v-else>
          <span class="param-label">播放方式</span>
          <el-radio-group v-model="transitConfig.mp3_mode" size="small">
            <el-radio-button value="repeat">单曲循环</el-radio-button>
            <el-radio-button value="shuffle">随机轮播</el-radio-button>
          </el-radio-group>

          <span class="param-label field-top">共享素材池</span>
          <div class="transit-pool">
            <el-button size="small" @click="pickTransitMp3">添加音频（可多选）</el-button>
            <p v-if="!transitConfig.mp3_files.length" class="param-hint">尚未添加音频</p>
            <div v-for="file in transitConfig.mp3_files" :key="file" class="transit-pool-file">
              <span class="transit-file-name" :title="file">{{ transitFileName(file) }}</span>
              <el-button size="small" text type="danger" @click="removeTransitMp3(file)">移除</el-button>
            </div>
            <p class="param-hint">支持 MP3 / WAV / OGG / M4A；移除不删除原文件。</p>
          </div>

          <template v-if="transitConfig.mp3_mode === 'repeat'">
            <span class="param-label">循环文件</span>
            <el-select v-model="transitConfig.mp3_file" size="small" placeholder="请先添加音频" class="transit-input">
              <el-option v-for="file in transitConfig.mp3_files" :key="file" :label="transitFileName(file)" :value="file" />
            </el-select>
          </template>
        </template>
      </div>

      <div class="row-actions">
        <el-button type="primary" plain :loading="savingTransit" @click="saveTransitConfig">保存</el-button>
        <span v-if="transitSavedOk" class="ok-text">已保存，下次启动过渡音频时生效</span>
        <span v-else class="save-hint">下次启动过渡音频时生效</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, watch } from 'vue'
import { ElMessage } from 'element-plus'

const props = defineProps({ wsRef: Object })

// ── 过渡音频 ─────────────────────────────────────────────────────────────────
const transitConfig  = reactive({ enabled: false, type: 'tts', text: '', mp3_file: '', mp3_files: [], mp3_mode: 'repeat' })
const savingTransit  = ref(false)
const transitSavedOk = ref(false)
const configLoaded = ref(false)
const configLoadError = ref('')
let transitSaveTimer = null
let transitSaveCleanup = null
let transitLoadCleanup = null
let loadedSocket = null
let applyingConfig = false
let draftRevision = 0
let draftDirty = false

watch(transitConfig, () => {
  if (applyingConfig) return
  draftRevision++
  draftDirty = true
  transitSavedOk.value = false
}, { deep: true, flush: 'sync' })

function normalizeTransitConfig(config = {}) {
  const candidates = Array.isArray(config.mp3_files) ? config.mp3_files : [config.mp3_file]
  const files = [...new Set(candidates.filter(file => typeof file === 'string' && /\.(mp3|wav|ogg|m4a)$/i.test(file.trim())).map(file => file.trim()))]
  return {
    enabled: config.enabled === true,
    type: config.type === 'mp3' ? 'mp3' : 'tts',
    text: typeof config.text === 'string' ? config.text : '',
    mp3_files: files,
    mp3_file: files.includes(config.mp3_file) ? config.mp3_file : (files[0] || ''),
    mp3_mode: config.mp3_mode === 'shuffle' ? 'shuffle' : 'repeat',
  }
}

function applyTransitConfig(config) {
  applyingConfig = true
  try {
    Object.assign(transitConfig, normalizeTransitConfig(config))
    draftDirty = false
  } finally {
    applyingConfig = false
  }
}

function transitFileName(file) {
  return file.split(/[\\/]/).pop() || file
}

function removeTransitMp3(file) {
  transitConfig.mp3_files = transitConfig.mp3_files.filter(item => item !== file)
  if (transitConfig.mp3_file === file) transitConfig.mp3_file = transitConfig.mp3_files[0] || ''
  transitSavedOk.value = false
}

function loadTransitConfig(ws, attempt = 0) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  transitLoadCleanup?.()
  if (attempt >= 5) {
    configLoadError.value = '过渡音频设置加载超时。请重新加载；若仍失败，请重启后端或导出诊断日志。未保存的内容已保留。'
    return
  }
  configLoadError.value = ''
  const revision = draftRevision
  let retryTimer
  const handler = event => {
    try {
      const msg = JSON.parse(event.data)
      if (msg.type !== 'TRANSIT_CONFIG') return
      loadedSocket = ws
      configLoaded.value = true
      // A late/reconnected response must not replace the operator's draft.
      if (!draftDirty && draftRevision === revision) applyTransitConfig(msg.data)
      transitLoadCleanup?.()
    } catch { /* ignore unrelated malformed messages */ }
  }
  transitLoadCleanup = () => {
    clearTimeout(retryTimer)
    ws.removeEventListener('message', handler)
    transitLoadCleanup = null
  }
  ws.addEventListener('message', handler)
  try {
    retryTimer = setTimeout(() => loadTransitConfig(ws, attempt + 1), 2000)
    ws.send(JSON.stringify({ type: 'GET_TRANSIT_CONFIG' }))
  } catch {
    transitLoadCleanup?.()
    configLoadError.value = '过渡音频设置请求发送失败，请检查后端连接并重新加载。'
  }
}

async function pickTransitMp3() {
  if (!window.api?.selectMultipleMp3Files) {
    ElMessage.error('请在桌面客户端中选择本地音频文件')
    return
  }
  try {
    const selected = await window.api.selectMultipleMp3Files()
    if (!Array.isArray(selected)) return
    const files = selected.filter(file => typeof file === 'string' && /\.(mp3|wav|ogg|m4a)$/i.test(file))
    if (files.length !== selected.length) ElMessage.warning('过渡素材池支持 MP3 / WAV / OGG / M4A，已忽略其他格式')
    transitConfig.mp3_files = [...new Set([...transitConfig.mp3_files, ...files])]
    if (!transitConfig.mp3_files.includes(transitConfig.mp3_file)) transitConfig.mp3_file = transitConfig.mp3_files[0] || ''
    transitSavedOk.value = false
  } catch (err) {
    ElMessage.error(`选择音频失败：${err.message}`)
  }
}

async function saveTransitConfig() {
  const ws = props.wsRef
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    ElMessage.error('未连接后端')
    return
  }
  // GET and SET share a reply type. Finish loading before sending a save.
  if (loadedSocket !== ws) {
    ElMessage.error('过渡音频设置尚未加载，请稍后重试')
    return
  }
  if (transitConfig.enabled && transitConfig.type === 'mp3' && !transitConfig.mp3_files.length) {
    ElMessage.error('请至少添加一个音频文件，或关闭过渡音频')
    return
  }
  if (transitConfig.enabled && transitConfig.type === 'tts' && !transitConfig.text.trim()) {
    ElMessage.error('请输入过渡播报文字，或关闭过渡音频')
    return
  }
  transitLoadCleanup?.()
  transitSaveCleanup?.()
  const submitted = normalizeTransitConfig(transitConfig)
  const revision = draftRevision
  savingTransit.value = true
  transitSavedOk.value = false
  const handleSaved = event => {
    try {
      const msg = JSON.parse(event.data)
      if (msg.type !== 'TRANSIT_CONFIG') return
      transitSaveCleanup?.()
      if (draftRevision === revision) {
        applyTransitConfig(msg.data)
        transitSavedOk.value = true
      }
    } catch { /* ignore unrelated malformed messages */ }
  }
  transitSaveCleanup = () => {
    clearTimeout(transitSaveTimer)
    ws.removeEventListener('message', handleSaved)
    savingTransit.value = false
    transitSaveCleanup = null
  }
  ws.addEventListener('message', handleSaved)
  transitSaveTimer = setTimeout(() => {
    transitSaveCleanup?.()
    ElMessage.error('保存过渡音频设置超时，请检查后端连接')
  }, 5000)
  try {
    ws.send(JSON.stringify({ type: 'SET_TRANSIT_CONFIG', data: submitted }))
  } catch (err) {
    transitSaveCleanup?.()
    ElMessage.error(`发送过渡音频设置失败：${err.message}`)
  }
}

// App.vue supplies the socket after it opens; the card stays mounted across navigation.
watch(() => props.wsRef, (ws, _previous, onCleanup) => {
  transitLoadCleanup?.()
  transitSaveCleanup?.()
  loadedSocket = null
  configLoaded.value = false
  configLoadError.value = ''
  transitSavedOk.value = false
  if (!ws) return
  const onOpen = () => loadTransitConfig(ws)
  const onClose = () => {
    transitLoadCleanup?.()
    transitSaveCleanup?.()
    loadedSocket = null
    configLoaded.value = false
    configLoadError.value = ''
    transitSavedOk.value = false
  }
  ws.addEventListener('close', onClose)
  if (ws.readyState === WebSocket.OPEN) onOpen()
  else ws.addEventListener('open', onOpen, { once: true })
  onCleanup(() => {
    ws.removeEventListener('open', onOpen)
    ws.removeEventListener('close', onClose)
    transitLoadCleanup?.()
    transitSaveCleanup?.()
  })
}, { immediate: true })
</script>

<style scoped>
.transit-settings { min-width: 0; container: transit-form / inline-size; }
.panel-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 16px; font-size: 13px; font-weight: 600; color: var(--text); letter-spacing: .03em; }
.header-switch { display: flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 400; color: var(--text-dim); cursor: pointer; }
.header-switch :deep(.el-switch) { --el-switch-on-color: var(--amber); }
.panel-body, .field-content { min-width: 0; }
.params-grid { display: grid; grid-template-columns: 88px minmax(0, 1fr); gap: 12px 10px; align-items: center; }
.param-label { font-size: 12px; color: var(--text-dim); }
.field-top { align-self: start; padding-top: 6px; }
.transit-input { width: 100%; min-width: 0; }
.param-hint { margin-top: 6px; font-size: 11px; color: var(--text-dim); line-height: 1.5; }
.transit-pool { min-width: 0; }
.transit-pool-file { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
.transit-file-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.row-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--border); }
.ok-text, .save-hint { font-size: 12px; }
.ok-text { color: var(--green); }
.save-hint { color: var(--text-dim); }
@container transit-form (max-width: 360px) {
  .params-grid { grid-template-columns: minmax(0, 1fr); gap: 8px; }
  .param-label { margin-top: 4px; }
}
</style>
