<template>
  <section class="stationary-card" aria-label="定点播放">
    <header class="heading">
      <h3>定点播放</h3>
      <span class="status" :class="{ live: active }" role="status">{{ status }}<template v-if="active && iteration"> · 第 {{ iteration }} 轮</template></span>
    </header>
    <div class="group-bar">
      <select v-model="selectedId" aria-label="选择定点" :disabled="locked || !groups.length">
        <option v-if="!groups.length" value="">正在读取定点…</option>
        <option v-for="group in groups" :key="group.id" :value="group.id">{{ group.name }}</option>
      </select>
      <el-button size="small" :disabled="locked || !current || groups.length >= 12" @click="editName(true)">新建</el-button>
      <el-button size="small" :disabled="locked || !current" @click="editName(false)">改名</el-button>
    </div>
    <form v-if="nameAction" class="name-form" @submit.prevent="saveName">
      <input ref="nameInput" v-model="groupName" :aria-label="nameAction === 'new' ? '新定点名称' : '修改定点名称'" maxlength="40" @keydown.esc="nameAction = ''" />
      <el-button native-type="submit" size="small" :disabled="locked || !groupName.trim() || !!nameRequest">保存</el-button>
      <el-button size="small" @click="nameAction = ''">取消</el-button>
    </form>

    <div class="modes" role="group" aria-label="播放方式">
      <button type="button" :aria-pressed="mode === 'tts'" :disabled="locked || !current" @click="edit({ mode: 'tts' })">TTS 改写</button>
      <button type="button" :aria-pressed="mode === 'mp3'" :disabled="locked || !current" @click="edit({ mode: 'mp3' })">MP3 录音 <small>{{ recordings.length }}</small></button>
    </div>

    <template v-if="mode === 'tts'">
      <div class="field-bar">
        <strong>{{ view === 'original' ? '定点原文' : '本轮改写稿' }}</strong>
        <button class="link" :aria-pressed="view === 'rewritten'" @click="view = view === 'original' ? 'rewritten' : 'original'">{{ view === 'original' ? '查看改写稿' : '返回原文' }}</button>
      </div>
      <el-input v-if="view === 'original'" :model-value="values.text || ''" type="textarea" :rows="4" maxlength="100000"
        placeholder="输入本定点的播报资料…" aria-label="定点原文" :readonly="locked || !current"
        @update:model-value="text => edit({ text }, true)" @blur="flush(selectedId)" />
      <el-input v-else :model-value="stateGroupId === selectedId ? rewrittenText : ''" type="textarea" :rows="4" readonly
        placeholder="此处显示本定点最近一轮的改写稿" aria-label="本轮改写稿" />
      <p class="hint">每轮改写后朗读，完整播放的录音会存入本定点。</p>
    </template>
    <template v-else>
      <div class="field-bar">
        <strong>录音池 <span>已选 {{ selectedRecordings.length }} / {{ recordings.length }}</span></strong>
        <div class="links">
          <button class="link" :disabled="locked || !recordings.length" @click="edit({ recordingIds: recordings.map(item => item.id) })">全选</button>
          <button class="link" :disabled="locked || !selectedRecordings.length" @click="edit({ recordingIds: [] })">清空选择</button>
        </div>
      </div>
      <div v-if="recordings.length" class="pool" aria-label="定点录音列表">
        <div v-for="item in pageItems" :key="item.id" class="recording" :class="{ playing: active && playingId === item.id }">
          <label>
            <input type="checkbox" :checked="selectedRecordings.includes(item.id)" :disabled="locked" @change="toggleRecording(item.id, $event.target.checked)" />
            <span class="recording-detail"><span :title="item.title">{{ item.title || '定点录音' }}</span>
              <small>{{ formatTime(item.createdAt) }} · 第 {{ item.iteration }} 轮 · {{ formatBytes(item.bytes) }}</small>
            </span>
          </label>
          <button class="link" :disabled="!canExport" :aria-label="'下载 ' + item.title" @click="download(item)">下载</button>
        </div>
      </div>
      <p v-else class="empty">暂无录音。使用 TTS 完整播放一轮后，可在这里勾选和下载。</p>
      <div v-if="pageCount > 1" class="pages">
        <button class="link" :disabled="page === 1" @click="page--">上一页</button>
        <span>{{ page }} / {{ pageCount }}</span>
        <button class="link" :disabled="page >= pageCount" @click="page++">下一页</button>
      </div>
    </template>

    <div class="options">
      <el-checkbox :model-value="values.loop ?? true" :disabled="locked || !current" @change="loop => edit({ loop })">循环播放</el-checkbox>
      <el-checkbox v-if="mode === 'mp3'" :model-value="values.shuffle === true" :disabled="locked || !current" @change="shuffle => edit({ shuffle })">随机顺序</el-checkbox>
    </div>
    <div class="actions">
      <el-button type="primary" :disabled="!!startReason || active || !!nameAction" @click="start">开始播放</el-button>
      <el-button type="danger" plain :disabled="!canStop" @click="$emit('stop')">停止播放</el-button>
    </div>
    <p v-if="feedback" class="feedback" role="status">{{ feedback }}</p>
  </section>
</template>

<script setup>
import { computed, nextTick, onUnmounted, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'

const props = defineProps({
  groups: { type: Array, default: () => [] }, active: Boolean, pending: Boolean,
  connected: Boolean, status: String, iteration: Number, message: String, blocked: String,
  stateGroupId: String, playingId: String, rewrittenText: String, canStop: Boolean, send: Function,
})
const emit = defineEmits(['start', 'stop'])
const selectedId = ref('')
const current = computed(() => props.groups.find(group => group.id === selectedId.value))
const drafts = reactive({})
const pending = new Map()
const timers = new Map()
const values = computed(() => ({ ...current.value, ...drafts[selectedId.value] }))
const mode = computed(() => values.value.mode || 'tts')
const recordings = computed(() => current.value?.recordings || [])
const selectedRecordings = computed(() => values.value.recordingIds || [])
const locked = computed(() => props.active || props.pending || !props.connected)
const view = ref('original')
const nameAction = ref('')
const groupName = ref('')
const nameInput = ref(null)
const nameRequest = ref('')
const page = ref(1)
const pageCount = computed(() => Math.max(1, Math.ceil(recordings.value.length / 20)))
const pageItems = computed(() => recordings.value.slice((page.value - 1) * 20, page.value * 20))
const canExport = Boolean(window.api?.exportStationaryAudio)
const startReason = computed(() => {
  if (props.blocked) return props.blocked
  if (!current.value) return '正在读取定点资料…'
  if (mode.value === 'mp3' && !selectedRecordings.value.length) return '请先勾选要播放的录音'
  if (mode.value === 'tts' && !values.value.text?.trim()) return '请先输入定点原文'
  return ''
})
const feedback = computed(() => props.active || props.pending ? props.message || props.blocked
  : startReason.value || (props.stateGroupId === selectedId.value ? props.message : ''))

watch([() => props.groups, () => props.active, () => props.stateGroupId], () => {
  if (props.active && props.groups.some(group => group.id === props.stateGroupId)) selectedId.value = props.stateGroupId
  else if (!current.value) selectedId.value = props.groups[0]?.id || ''
  for (const id of Object.keys(drafts)) if (!timers.has(id)) flush(id)
}, { immediate: true })
watch(selectedId, (_next, previous) => {
  if (previous) flush(previous)
  view.value = 'original'
  page.value = 1
  nameAction.value = ''
})
watch(() => props.connected, connected => {
  if (!connected) { pending.clear(); nameRequest.value = '' }
})

function edit(patch, debounce = false) {
  const id = selectedId.value
  if (!id || locked.value) return
  drafts[id] = { ...drafts[id], ...patch }
  clearTimeout(timers.get(id))
  if (debounce) timers.set(id, setTimeout(() => flush(id), 350))
  else flush(id)
}

function flush(id) {
  clearTimeout(timers.get(id))
  timers.delete(id)
  const changes = drafts[id]
  if (!changes || !props.connected || pending.has(id) || props.active) return
  const requestId = crypto.randomUUID()
  if (props.send('UPDATE_STATIONARY_GROUP', { ...changes, groupId: id, requestId })) pending.set(id, { requestId, changes })
}

function saved(result) {
  if (result?.requestId === nameRequest.value) {
    nameRequest.value = ''
    if (result.error) { ElMessage.error(result.error); return }
    nameAction.value = ''
    selectedId.value = result.groupId
    return
  }
  for (const [id, request] of pending) {
    if (request.requestId !== result?.requestId) continue
    pending.delete(id)
    const remaining = { ...drafts[id] }
    for (const [key, value] of Object.entries(request.changes)) {
      if (JSON.stringify(remaining[key]) === JSON.stringify(value)) delete remaining[key]
    }
    if (Object.keys(remaining).length) drafts[id] = remaining
    else delete drafts[id]
    if (result.error) ElMessage.error(result.error)
    flush(id)
    break
  }
}
defineExpose({ saved })

async function editName(create) {
  nameAction.value = create ? 'new' : 'rename'
  groupName.value = create ? nextName() : current.value.name
  await nextTick()
  nameInput.value?.select()
}

function nextName() {
  const names = new Set(props.groups.map(group => group.name))
  let number = 1
  while (names.has('定点' + number)) number++
  return '定点' + number
}

function saveName() {
  if (nameRequest.value || locked.value || !groupName.value.trim()) return
  const requestId = crypto.randomUUID()
  const changes = { name: groupName.value.trim(), requestId }
  if (nameAction.value === 'rename') changes.groupId = selectedId.value
  if (props.send('UPDATE_STATIONARY_GROUP', changes)) nameRequest.value = requestId
}

function toggleRecording(id, checked) {
  const next = new Set(selectedRecordings.value)
  if (checked) next.add(id)
  else next.delete(id)
  edit({ recordingIds: recordings.value.map(item => item.id).filter(item => next.has(item)) })
}

function start() {
  flush(selectedId.value)
  emit('start', { groupId: selectedId.value, text: values.value.text || '', mode: mode.value,
    loop: values.value.loop ?? true, shuffle: values.value.shuffle === true, recordingIds: selectedRecordings.value })
}

async function download(item) {
  try {
    if (await window.api.exportStationaryAudio(selectedId.value, item.id)) ElMessage.success('录音已导出')
  } catch (error) { ElMessage.error('导出失败：' + error.message) }
}
const timeFormat = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
const formatTime = time => timeFormat.format(new Date(time))
const formatBytes = bytes => bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + ' MB' : Math.ceil(bytes / 1024) + ' KB'
onUnmounted(() => { for (const timer of timers.values()) clearTimeout(timer) })
</script>

<style scoped>
.stationary-card { min-width: 0; border: 1px solid var(--border); border-radius: 8px; background: var(--bg2); padding: 18px 20px; }
.heading, .field-bar, .group-bar, .name-form, .options, .links, .actions, .pages { display: flex; align-items: center; gap: 8px; }
.heading, .field-bar { justify-content: space-between; flex-wrap: wrap; }
h3 { color: var(--text); margin: 0; font-size: 14px; font-weight: 600; }
.status { color: var(--text-dim); background: var(--bg3); border-radius: 20px; font-size: 11px; padding: 3px 9px; }
.status.live { color: var(--green); background: rgba(74,222,128,.12); }
.group-bar { margin: 14px 0 10px; }
.group-bar select, .name-form input { appearance: auto; flex: 1; min-width: 66px; height: 29px; border: 1px solid var(--border); background: var(--bg3); color: var(--text); font: inherit; font-size: 12px; border-radius: 5px; padding-inline: 7px; }
.name-form { margin: 0 0 10px; }
button:focus-visible, select:focus-visible, input:focus-visible { outline: 2px solid var(--amber); outline-offset: 2px; }
.group-bar :deep(.el-button), .name-form :deep(.el-button), .actions :deep(.el-button) { margin: 0; }
.modes { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); background: var(--bg3); border-radius: 6px; padding: 3px; gap: 3px; }
.modes button { border: 1px solid transparent; border-radius: 4px; padding: 5px; background: transparent; color: var(--text-dim); font: inherit; font-size: 12px; cursor: pointer; }
.modes button[aria-pressed="true"] { border-color: var(--border); background: var(--bg2); color: var(--text); font-weight: 600; }
.modes small { font-size: 10px; opacity: .8; }
.field-bar { margin: 13px 0 7px; color: var(--text); font-size: 12px; }
.field-bar strong { font-weight: 550; }
.field-bar strong span, .pages { color: var(--text-dim); font-size: 11px; font-weight: 400; }
.link { border: 0; background: none; padding: 3px 0; color: var(--amber); font: inherit; font-size: 11px; cursor: pointer; }
.hint, .feedback, .empty { color: var(--text-dim); font-size: 11px; line-height: 1.5; margin: 7px 0 0; overflow-wrap: anywhere; }
.feedback { margin-top: 8px; }
.empty { background: var(--bg3); border-radius: 5px; padding: 12px; }
.pool { max-height: 155px; overflow: auto; overscroll-behavior: contain; border-block: 1px solid var(--border); }
.recording { display: flex; align-items: center; justify-content: space-between; min-width: 0; gap: 8px; padding: 6px 3px; }
.recording + .recording { border-top: 1px solid var(--border); }
.recording.playing { background: rgba(74,222,128,.08); }
.recording label { flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; cursor: pointer; }
.recording input { accent-color: var(--amber); }
.recording-detail { display: grid; gap: 2px; min-width: 0; color: var(--text); font-size: 12px; }
.recording-detail > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.recording-detail small { color: var(--text-dim); font-size: 10px; }
.pages { justify-content: flex-end; margin-top: 4px; }
.options { flex-wrap: wrap; gap: 12px; margin: 7px 0; }
.options :deep(.el-checkbox) { height: 24px; margin: 0; }
.options :deep(.el-checkbox__label) { font-size: 12px; }
.actions { flex-wrap: wrap; }
button:disabled { cursor: default; }
.link:disabled { color: var(--text-dim); opacity: .55; }
</style>
