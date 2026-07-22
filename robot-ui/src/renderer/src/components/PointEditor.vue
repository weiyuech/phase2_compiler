<template>
  <div class="pe-layout">

    <!-- Phase 1: Preparation card -->
    <div class="phase-card" :class="mapReady ? 'ready' : 'pending'">
      <div class="phase-label">阶段一 · 准备</div>
      <div class="phase-body">
        <el-select
          v-model="selectedMapForSwitch"
          filterable allow-create
          placeholder="选择今日直播地图"
          style="width:220px"
          :disabled="!wsConnected || mapSwitching"
        >
          <el-option
            v-for="opt in mapOptions"
            :key="opt.name"
            :value="opt.name"
            :label="opt.name"
          >
            <span>{{ opt.name }}</span>
            <span v-if="opt.warning" class="opt-warn">⚠ {{ opt.warning }}</span>
          </el-option>
        </el-select>

        <el-button
          :disabled="!wsConnected || !selectedMapForSwitch || mapSwitching"
          :loading="mapSwitching"
          @click="doSelectMap"
        >切换地图</el-button>

        <span class="phase-status" :class="mapReady ? 'ok' : 'dim'">
          {{ mapSwitching ? '切换中...' : mapReady ? `✓ 已就绪：${currentMapName}` : '未就绪' }}
        </span>
      </div>
    </div>

    <!-- Header -->
    <div class="pe-header">
      <div class="pe-title">
        巡游清单
        <span class="pe-count">{{ items.length }} 个点位</span>
      </div>
      <div class="pe-actions">
        <span v-if="isDirty" class="dirty-badge">● 未提交</span>
        <el-button :disabled="!wsConnected" @click="submitList" type="primary">提交清单</el-button>
      </div>
    </div>

    <!-- No connection -->
    <div v-if="!wsConnected" class="no-ws-banner">
      ⚠ 未连接到后端，请先启动后端服务
    </div>

    <!-- List -->
    <div class="pe-list-wrap">
      <div v-if="items.length === 0" class="pe-empty">
        清单为空，点击下方"添加点位"开始配置
      </div>

      <div
        v-for="(item, i) in items" :key="i"
        class="pe-row"
        :class="{ 'drag-over': dragOverIndex === i && dragIndex !== i }"
        draggable="true"
        @dragstart="onDragStart(i)"
        @dragover.prevent="onDragOver(i)"
        @drop="onDrop(i)"
        @dragend="onDragEnd"
      >
        <div class="pe-drag">⠿</div>
        <div class="pe-index">{{ i + 1 }}</div>

        <div class="pe-cell cell-map">
          <span>{{ item.map_name }}</span>
          <span v-if="mapWarning(item.map_name)" class="warn-dot" :title="mapWarning(item.map_name)">⚠</span>
        </div>
        <div class="pe-cell cell-path">
          <span>{{ item.path_name }}</span>
          <span v-if="pathWarning(item.path_name)" class="warn-dot" :title="pathWarning(item.path_name)">⚠</span>
        </div>
        <div class="pe-cell cell-id mono">{{ item.goal_id }}</div>
        <div class="pe-cell cell-obj">{{ item.goal_object }}</div>
        <div class="pe-cell cell-mode">
          <span class="mode-badge" :class="item.play_mode">{{ item.play_mode }}</span>
        </div>

        <div class="pe-row-btns">
          <button class="row-btn" @click="openEdit(i)">编辑</button>
          <button class="row-btn danger" @click="removeItem(i)">删除</button>
        </div>
      </div>
    </div>

    <!-- Footer -->
    <div class="pe-footer">
      <el-button @click="openAdd">+ 添加点位</el-button>
    </div>

    <!-- Add / Edit dialog -->
    <el-dialog
      v-model="dialogVisible"
      :title="editingIndex >= 0 ? '编辑点位' : '添加点位'"
      width="500px"
    >
      <el-form :model="form" label-position="top" class="dialog-form">

        <el-form-item label="地图">
          <el-select
            v-model="form.map_name"
            filterable allow-create
            placeholder="选择或输入地图名"
            style="width:100%"
          >
            <el-option
              v-for="opt in mapOptions"
              :key="opt.name"
              :value="opt.name"
              :label="opt.name"
            >
              <span class="opt-name">{{ opt.name }}</span>
              <span v-if="opt.warning" class="opt-warn">⚠ {{ opt.warning }}</span>
            </el-option>
          </el-select>
          <div v-if="form.map_name && mapWarning(form.map_name)" class="field-warn">
            ⚠ {{ mapWarning(form.map_name) }}
          </div>
        </el-form-item>

        <el-form-item label="路径">
          <el-select
            v-model="form.path_name"
            filterable allow-create
            :placeholder="mapReady ? '选择或输入路径名' : '请先完成阶段一切换地图'"
            style="width:100%"
          >
            <el-option
              v-for="opt in pathOptions"
              :key="opt.name"
              :value="opt.name"
              :label="opt.name"
            >
              <span class="opt-name">{{ opt.name }}</span>
              <span v-if="opt.warning" class="opt-warn">⚠ {{ opt.warning }}</span>
            </el-option>
          </el-select>
          <div v-if="form.path_name && pathWarning(form.path_name)" class="field-warn">
            ⚠ {{ pathWarning(form.path_name) }}
          </div>
          <div v-if="!mapReady" class="field-warn">请先在顶部完成地图切换</div>
        </el-form-item>

        <div class="form-row-2">
          <el-form-item label="目标点 ID">
            <el-input-number v-model="form.goal_id" :min="1" style="width:100%" />
          </el-form-item>
          <el-form-item label="目标对象（COCO 类名）">
            <el-input v-model="form.goal_object" placeholder="car / bicycle / person / bottle" />
          </el-form-item>
        </div>

        <el-form-item label="播报模式">
          <el-select v-model="form.play_mode" style="width:100%">
            <el-option value="tts" label="TTS — 大模型改写后合成播报" />
            <el-option value="mp3" label="MP3 — 直接播放知识库录音文件" />
          </el-select>
        </el-form-item>

      </el-form>

      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="confirmDialog">确认</el-button>
      </template>
    </el-dialog>

  </div>
</template>

<script setup>
import { ref, computed, watch, onUnmounted } from 'vue'
import { ElMessage } from 'element-plus'

const props = defineProps({ wsRef: Object })

// ── Phase 1 state ─────────────────────────────────────────────────────────────

const selectedMapForSwitch = ref('')
const mapSwitching         = ref(false)
const mapReady             = ref(false)
const currentMapName       = ref('')
const robotPaths           = ref([])   // paths from robot for current map
const kbPaths              = ref([])   // paths from KB for current map

// ── Tour list state ───────────────────────────────────────────────────────────

const items        = ref([])
const kbMaps       = ref([])
const robotMaps    = ref([])
const isDirty      = ref(false)

const dragIndex     = ref(-1)
const dragOverIndex = ref(-1)

const dialogVisible = ref(false)
const editingIndex  = ref(-1)
const form          = ref(emptyForm())

const wsConnected = computed(() => !!props.wsRef && props.wsRef.readyState === 1)

// ── Map options (Phase 1 + dialog) ────────────────────────────────────────────

const mapOptions = computed(() => {
  const kbSet    = new Set(kbMaps.value)
  const robotSet = new Set(robotMaps.value)
  const all      = new Set([...kbMaps.value, ...robotMaps.value])
  return [...all].map(name => {
    const warning = kbSet.has(name) && !robotSet.has(name) ? '机器人无此地图'
                  : !kbSet.has(name) && robotSet.has(name) ? '知识库无内容'
                  : null
    return { name, warning }
  })
})

function mapWarning(name) {
  return mapOptions.value.find(o => o.name === name)?.warning ?? null
}

// ── Path options (dialog, populated after Phase 1) ────────────────────────────

const pathOptions = computed(() => {
  const robotSet = new Set(robotPaths.value)
  const kbSet    = new Set(kbPaths.value)
  const all      = new Set([...robotPaths.value, ...kbPaths.value])
  return [...all].map(name => {
    const warning = kbSet.has(name) && !robotSet.has(name) ? '机器人无此路径'
                  : !kbSet.has(name) && robotSet.has(name) ? '知识库无内容'
                  : null
    return { name, warning }
  })
})

function pathWarning(name) {
  return pathOptions.value.find(o => o.name === name)?.warning ?? null
}

// ── Phase 1 action ────────────────────────────────────────────────────────────

function doSelectMap() {
  if (!selectedMapForSwitch.value) return
  mapSwitching.value = true
  mapReady.value     = false
  send('SELECT_MAP', { map_name: selectedMapForSwitch.value })
}

// ── List actions ──────────────────────────────────────────────────────────────

function submitList() {
  send('SET_TOUR_LIST', { items: items.value })
  isDirty.value = false
  ElMessage.success('已提交巡游清单')
}

function removeItem(i) {
  items.value.splice(i, 1)
  isDirty.value = true
}

function openAdd() {
  editingIndex.value = -1
  form.value = emptyForm()
  // Pre-fill map with current ready map
  if (currentMapName.value) form.value.map_name = currentMapName.value
  dialogVisible.value = true
}

function openEdit(i) {
  editingIndex.value = i
  form.value = { ...items.value[i] }
  dialogVisible.value = true
}

function confirmDialog() {
  if (!form.value.map_name.trim() || !form.value.path_name.trim() || !form.value.goal_id) {
    ElMessage.warning('地图、路径、目标点 ID 均为必填项')
    return
  }
  const item = {
    ...form.value,
    map_name:    form.value.map_name.trim(),
    path_name:   form.value.path_name.trim(),
    goal_object: form.value.goal_object && form.value.goal_object.trim() ? form.value.goal_object.trim() : null
  }
  if (editingIndex.value >= 0) {
    items.value[editingIndex.value] = item
  } else {
    items.value.push(item)
  }
  isDirty.value = true
  dialogVisible.value = false
}

// ── Drag & drop ───────────────────────────────────────────────────────────────

function onDragStart(i) { dragIndex.value = i }
function onDragOver(i)  { dragOverIndex.value = i }
function onDragEnd()    { dragIndex.value = -1; dragOverIndex.value = -1 }

function onDrop(i) {
  if (dragIndex.value < 0 || dragIndex.value === i) { onDragEnd(); return }
  const from  = dragIndex.value
  const moved = items.value.splice(from, 1)[0]
  items.value.splice(from < i ? i - 1 : i, 0, moved)
  isDirty.value = true
  onDragEnd()
}

// ── WebSocket ─────────────────────────────────────────────────────────────────

function send(type, data = {}) {
  props.wsRef?.send(JSON.stringify({ type, data }))
}

function handleMessage(raw) {
  try {
    const { type, data } = JSON.parse(raw)
    switch (type) {
      case 'TOUR_LIST':
      case 'TOUR_LIST_CHANGED':
        items.value   = data.items || []
        isDirty.value = false
        break
      case 'KB_MAPS':
        kbMaps.value = data.maps || []
        break
      case 'MAP_LIST':
        robotMaps.value = data.maps || []
        break
      case 'MAP_SWITCHING':
        mapSwitching.value = true
        mapReady.value     = false
        break
      case 'MAP_SWITCHED':
        mapSwitching.value = false
        mapReady.value     = true
        currentMapName.value = data.map_name
        robotPaths.value   = []   // clear until PATH_LIST arrives
        kbPaths.value      = []
        // Fetch KB paths for this map
        send('GET_KB_PATHS', { map_name: data.map_name })
        break
      case 'PATH_LIST':
        robotPaths.value = data.paths || []
        break
      case 'KB_PATHS':
        kbPaths.value = data.paths || []
        break
      case 'KB_ENTRY_SAVED':
      case 'KB_ENTRY_DELETED':
        send('GET_KB_MAPS')
        if (currentMapName.value && data.map_name === currentMapName.value) {
          send('GET_KB_PATHS', { map_name: currentMapName.value })
        }
        break
      case 'ERROR':
        // If map switching was in progress, reset state
        if (mapSwitching.value) mapSwitching.value = false
        break
    }
  } catch { /* ignore */ }
}

let currentSocket = null
watch(() => props.wsRef, (socket) => {
  if (currentSocket) currentSocket.removeEventListener('message', onMsg)
  if (socket) {
    currentSocket = socket
    socket.addEventListener('message', onMsg)
    send('GET_TOUR_LIST')
    send('GET_KB_MAPS')
  }
}, { immediate: true })

function onMsg(e) { handleMessage(e.data) }
onUnmounted(() => { currentSocket?.removeEventListener('message', onMsg) })

// ── Helpers ───────────────────────────────────────────────────────────────────

function emptyForm() {
  return { map_name: '', path_name: '', goal_id: 1, goal_object: '', play_mode: 'tts' }
}
</script>

<style scoped>
.pe-layout { display: flex; flex-direction: column; height: 100%; overflow: hidden; }

/* Phase 1 card */
.phase-card {
  flex-shrink: 0; display: flex; align-items: center; gap: 16px;
  padding: 12px 20px; border-bottom: 1px solid var(--border);
  background: var(--bg2);
}
.phase-card.ready   { border-left: 3px solid var(--green); }
.phase-card.pending { border-left: 3px solid var(--border); }
.phase-label { font-size: 10px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; color: var(--text-dim); flex-shrink: 0; }
.phase-body  { display: flex; align-items: center; gap: 10px; flex: 1; }
.phase-status { font-size: 12px; font-family: var(--font-mono); }
.phase-status.ok  { color: var(--green); }
.phase-status.dim { color: var(--text-dim); }

.pe-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 20px; border-bottom: 1px solid var(--border);
  background: var(--bg2); flex-shrink: 0;
}
.pe-title   { font-size: 14px; font-weight: 600; color: var(--text); display: flex; align-items: center; gap: 10px; }
.pe-count   { font-size: 11px; background: var(--bg3); color: var(--text-dim); padding: 2px 8px; border-radius: 10px; font-weight: 400; }
.pe-actions { display: flex; align-items: center; gap: 10px; }
.dirty-badge { font-size: 11px; color: var(--amber); font-weight: 600; }

.no-ws-banner { flex-shrink: 0; margin: 10px 20px 0; background: rgba(245,158,11,.08); border: 1px solid var(--amber-dim); border-radius: 6px; padding: 10px 16px; color: var(--amber); font-size: 13px; }

.pe-list-wrap { flex: 1; overflow-y: auto; padding: 12px 20px; display: flex; flex-direction: column; gap: 6px; }
.pe-empty { text-align: center; color: var(--text-dim); font-size: 13px; padding: 40px; }

.pe-row {
  display: flex; align-items: center; gap: 10px;
  background: var(--bg2); border: 1px solid var(--border); border-radius: 6px;
  padding: 10px 14px; cursor: default; user-select: none;
  transition: border-color .15s;
}
.pe-row:hover     { border-color: var(--text-dim); }
.pe-row.drag-over { border-color: var(--cyan); background: rgba(34,211,238,.06); }

.pe-drag  { color: var(--text-dim); cursor: grab; font-size: 14px; flex-shrink: 0; }
.pe-drag:active { cursor: grabbing; }
.pe-index { font-size: 11px; color: var(--text-dim); font-family: var(--font-mono); width: 20px; text-align: right; flex-shrink: 0; }

.pe-cell { font-size: 13px; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cell-map  { flex: 2; display: flex; align-items: center; gap: 4px; }
.cell-path { flex: 2; display: flex; align-items: center; gap: 4px; }
.cell-id   { flex: 0 0 40px; font-family: var(--font-mono); color: var(--text-dim); }
.cell-obj  { flex: 2; color: var(--text-dim); }
.cell-mode { flex: 0 0 50px; }

.warn-dot { color: var(--amber); font-size: 12px; flex-shrink: 0; cursor: help; }

.mode-badge { font-size: 10px; font-weight: 600; letter-spacing: .04em; padding: 2px 6px; border-radius: 3px; }
.mode-badge.tts { background: rgba(34,211,238,.12); color: var(--cyan); }
.mode-badge.mp3 { background: rgba(167,139,250,.12); color: #a78bfa; }

.pe-row-btns { margin-left: auto; display: flex; gap: 6px; flex-shrink: 0; }
.row-btn { background: none; border: 1px solid var(--border); color: var(--text-dim); font-size: 11px; padding: 2px 8px; border-radius: 4px; cursor: pointer; }
.row-btn:hover { border-color: var(--text-dim); color: var(--text); }
.row-btn.danger:hover { border-color: var(--red); color: var(--red); }

.pe-footer { flex-shrink: 0; padding: 12px 20px; border-top: 1px solid var(--border); background: var(--bg2); }

/* Dialog */
.dialog-form { padding: 4px 0; }
.form-row-2  { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.opt-name    { flex: 1; }
.opt-warn    { font-size: 11px; color: var(--amber); margin-left: 8px; }
.field-warn  { font-size: 11px; color: var(--amber); margin-top: 4px; }
</style>
