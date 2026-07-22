<template>
  <div class="ke-layout">

    <!-- Col 1: Maps -->
    <div class="ke-col">
      <div class="col-header">
        <span class="col-title">地图</span>
        <div style="display: flex; gap: 8px; align-items: center;">
          <el-button link size="small" type="primary" @click="importKb" :disabled="!wsConnected">导入</el-button>
          <button class="col-add-btn" @click="showNewMap = !showNewMap">+</button>
        </div>
      </div>

      <div v-if="showNewMap" class="inline-new">
        <input
          v-model="newMapName" ref="newMapRef"
          class="inline-input" placeholder="新地图名称"
          @keyup.enter="createMap" @keyup.escape="showNewMap = false"
        />
        <button class="inline-ok" @click="createMap">确认</button>
      </div>

      <div class="col-list">
        <div
          v-for="mapName in mapList" :key="mapName"
          class="col-item" :class="{ active: selectedMap === mapName }"
          @click="selectMap(mapName)"
        >
          {{ mapName }}
        </div>
        <div v-if="mapList.length === 0" class="col-empty">暂无地图</div>
      </div>
    </div>

    <!-- Col 2: Paths -->
    <div class="ke-col">
      <div class="col-header">
        <span class="col-title">路径</span>
        <button class="col-add-btn" :disabled="!selectedMap" @click="showNewPath = !showNewPath">+</button>
      </div>

      <div v-if="showNewPath && selectedMap" class="inline-new">
        <input
          v-model="newPathName" ref="newPathRef"
          class="inline-input" placeholder="新路径名称"
          @keyup.enter="createPath" @keyup.escape="showNewPath = false"
        />
        <button class="inline-ok" @click="createPath">确认</button>
      </div>

      <div class="col-list">
        <div
          v-for="pathName in pathList" :key="pathName"
          class="col-item" :class="{ active: selectedPath === pathName }"
          @click="selectPath(pathName)"
        >
          {{ pathName }}
        </div>
        <div v-if="!selectedMap" class="col-empty">← 先选择地图</div>
        <div v-else-if="pathList.length === 0" class="col-empty">暂无路径</div>
      </div>
    </div>

    <!-- Col 3: Points + Edit -->
    <div class="ke-col ke-col-wide">
      <div class="col-header">
        <span class="col-title">
          点位
          <span v-if="selectedMap && selectedPath" class="col-breadcrumb">
            {{ selectedMap }} / {{ selectedPath }}
          </span>
        </span>
        <button class="col-add-btn" :disabled="!selectedPath" @click="openNewPoint">+</button>
      </div>

      <div class="points-area">
        <!-- Point list -->
        <div class="point-list">
          <div
            v-for="pt in pointList" :key="`${pt.goal_id}-${pt.goal_object || ''}`"
            class="point-item" :class="{ active: selectedPoint?.goal_id === pt.goal_id && selectedPoint?.goal_object === pt.goal_object }"
            @click="selectPoint(pt)"
          >
            <span class="point-id mono">{{ pt.goal_object ? `${pt.goal_id}—${pt.goal_object}` : pt.goal_id }}</span>
            <span class="point-preview">{{ pt.body ? pt.body.slice(0, 60) + (pt.body.length > 60 ? '…' : '') : '(无正文)' }}</span>
            <span v-if="pt.mp3_file" class="point-mp3-badge">MP3</span>
          </div>
          <div v-if="!selectedPath" class="col-empty">← 先选择路径</div>
          <div v-else-if="pointList.length === 0" class="col-empty">暂无点位，点击 + 新建</div>
        </div>

        <!-- Edit panel -->
        <div v-if="editMode !== 'none'" class="edit-panel">
          <div class="edit-panel-header">
            <span class="edit-panel-title">
              {{ editMode === 'new' ? '新建点位' : (editForm.goal_object ? `编辑 ${editForm.goal_id} — ${editForm.goal_object}` : `编辑 goal_id: ${editForm.goal_id}（通用）`) }}
            </span>
            <button class="panel-close" @click="closeEdit">✕</button>
          </div>

          <div class="edit-panel-body">
            <div class="form-row-2">
              <div class="field-row">
                <label class="field-label">目标点 ID</label>
                <el-input-number
                  v-model="editForm.goal_id" :min="1" style="width:140px"
                  :disabled="editMode === 'edit'"
                />
              </div>
              <div class="field-row">
                <label class="field-label">目标对象（COCO 类名）</label>
                <el-input
                  v-model="editForm.goal_object"
                  placeholder="留空=通用，car / bicycle / person"
                  :readonly="editMode === 'edit'"
                />
              </div>
            </div>

            <div class="field-row">
              <label class="field-label">正文（供 LLM 改写）</label>
              <el-input
                v-model="editForm.body"
                type="textarea" :rows="6"
                placeholder="输入点位讲解内容，大模型会基于此内容改写成口播稿..."
              />
            </div>



            <!-- Upload Multiple Audio Files Section (Exactly like BarrageEditor) -->
            <div v-if="editMode === 'edit'" class="field-row" style="margin-top: 20px;">
              <label class="field-label">MP3 语音包多音频管理 (支持上传多个，到达点位随机播放)</label>
              <div class="audio-management-box">
                <div class="audio-list-scroller">
                  <div v-for="file in cruisingAudioFiles" :key="file" class="audio-item">
                    <span class="audio-name">🎵 {{ file }}</span>
                    <el-button
                      type="danger" circle size="small"
                      @click="deleteCruisingAudioFile(file)"
                      class="audio-delete-btn"
                    >✕</el-button>
                  </div>
                  <div v-if="cruisingAudioFiles.length === 0" class="audio-empty">暂无点位专属音频，请点击下方上传</div>
                </div>
                <div class="audio-upload-bar" style="margin-top: 10px;">
                  <el-button type="primary" plain size="small" @click="uploadCruisingAudioFiles">
                    上传音频文件 (.mp3)
                  </el-button>
                </div>
              </div>
            </div>
          </div>

          <div class="edit-panel-footer">
            <el-button
              v-if="editMode === 'edit'"
              type="danger" plain size="small"
              @click="deletePoint"
            >删除此点位</el-button>
            <div style="flex:1" />
            <el-button size="small" @click="closeEdit">取消</el-button>
            <el-button type="primary" size="small" :disabled="!wsConnected" @click="savePoint">
              {{ editMode === 'new' ? '创建' : '保存' }}
            </el-button>
          </div>
        </div>
      </div>
    </div>

  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick, onUnmounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'

const props = defineProps({ wsRef: Object })

// ── State ─────────────────────────────────────────────────────────────────────

const tree          = ref({})   // { mapName: { pathName: [{ goal_id, goal_object, body, mp3_file }] } }
const selectedMap   = ref(null)
const selectedPath  = ref(null)
const selectedPoint = ref(null)
const editMode      = ref('none')  // none | edit | new
const editForm      = ref({ goal_id: 1, goal_object: '', body: '' })
const cruisingAudioFiles = ref([])

const showNewMap  = ref(false)
const showNewPath = ref(false)
const newMapName  = ref('')
const newPathName = ref('')
const newMapRef   = ref(null)
const newPathRef  = ref(null)

const wsConnected = computed(() => !!props.wsRef && props.wsRef.readyState === 1)

const mapList  = computed(() => Object.keys(tree.value).sort())
const pathList = computed(() => selectedMap.value ? Object.keys(tree.value[selectedMap.value] || {}).sort() : [])
const pointList = computed(() => {
  if (!selectedMap.value || !selectedPath.value) return []
  return (tree.value[selectedMap.value]?.[selectedPath.value] || [])
    .slice().sort((a, b) => {
      const diff = Number(a.goal_id) - Number(b.goal_id)
      if (diff !== 0) return diff
      if (!a.goal_object && b.goal_object) return -1  // generic first
      if (a.goal_object && !b.goal_object) return 1
      return (a.goal_object || '').localeCompare(b.goal_object || '')
    })
})

// ── Selection ─────────────────────────────────────────────────────────────────

function selectMap(mapName) {
  if (selectedMap.value === mapName) return
  selectedMap.value   = mapName
  selectedPath.value  = null
  selectedPoint.value = null
  closeEdit()
}

function selectPath(pathName) {
  if (selectedPath.value === pathName) return
  selectedPath.value  = pathName
  selectedPoint.value = null
  closeEdit()
}

function selectPoint(pt) {
  selectedPoint.value = pt
  editForm.value = { goal_id: pt.goal_id, goal_object: pt.goal_object || '', body: pt.body || '' }
  editMode.value = 'edit'
  fetchCruisingAudioFiles()
}

// ── New map / path ────────────────────────────────────────────────────────────

watch(showNewMap,  (v) => { if (v) { newMapName.value  = ''; nextTick(() => newMapRef.value?.focus()) } })
watch(showNewPath, (v) => { if (v) { newPathName.value = ''; nextTick(() => newPathRef.value?.focus()) } })

function createMap() {
  const name = newMapName.value.trim()
  if (!name) return
  if (tree.value[name]) { ElMessage.warning('地图已存在'); return }
  tree.value[name] = {}
  showNewMap.value = false
  selectMap(name)
}

function createPath() {
  const name = newPathName.value.trim()
  if (!name || !selectedMap.value) return
  if (tree.value[selectedMap.value][name]) { ElMessage.warning('路径已存在'); return }
  tree.value[selectedMap.value][name] = []
  showNewPath.value = false
  selectPath(name)
}

// ── Point edit ────────────────────────────────────────────────────────────────

function openNewPoint() {
  selectedPoint.value = null
  cruisingAudioFiles.value = []
  const existingIds = pointList.value.map(p => Number(p.goal_id))
  const nextId = existingIds.length > 0 ? Math.max(...existingIds) + 1 : 1
  editForm.value = { goal_id: nextId, goal_object: '', body: '' }
  editMode.value = 'new'
}

function closeEdit() {
  editMode.value      = 'none'
  selectedPoint.value = null
  cruisingAudioFiles.value = []
}



async function importKb() {
  try {
    const filePath = await window.api.selectJsonFile()
    if (filePath) {
      send('IMPORT_KB', { filePath })
    }
  } catch (err) {
    ElMessage.error('选择导入文件失败')
  }
}

function fetchCruisingAudioFiles() {
  if (!selectedMap.value || !selectedPath.value || !selectedPoint.value) return
  send('GET_CRUISING_AUDIO_FILES', {
    map_name: selectedMap.value,
    path_name: selectedPath.value,
    goal_id: selectedPoint.value.goal_id
  })
}

async function uploadCruisingAudioFiles() {
  if (!selectedMap.value || !selectedPath.value || !selectedPoint.value) return
  const res = await window.api.selectMultipleMp3Files()
  if (res && res.length > 0) {
    send('UPLOAD_CRUISING_AUDIO', {
      map_name: selectedMap.value,
      path_name: selectedPath.value,
      goal_id: selectedPoint.value.goal_id,
      filePaths: res
    })
  }
}

async function deleteCruisingAudioFile(filename) {
  if (!selectedMap.value || !selectedPath.value || !selectedPoint.value) return
  try {
    await ElMessageBox.confirm(`确定要删除音频文件 "${filename}" 吗？`, '确认删除', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    })
    send('DELETE_CRUISING_AUDIO', {
      map_name: selectedMap.value,
      path_name: selectedPath.value,
      goal_id: selectedPoint.value.goal_id,
      filename
    })
  } catch { /* cancel */ }
}

function savePoint() {
  if (!selectedMap.value || !selectedPath.value) return
  const { goal_id, goal_object, body } = editForm.value

  send('SAVE_KB_ENTRY', {
    map_name:    selectedMap.value,
    path_name:   selectedPath.value,
    goal_id:     Number(goal_id),
    goal_object: goal_object || null,
    body:        body        || null,
  })
}

async function deletePoint() {
  try {
    await ElMessageBox.confirm(
      `确认删除 ${selectedMap.value}/${selectedPath.value}/${editForm.value.goal_id}？此操作不可撤销。`,
      '删除确认', { type: 'warning' }
    )
  } catch { return }

  send('DELETE_KB_ENTRY', {
    map_name:    selectedMap.value,
    path_name:   selectedPath.value,
    goal_id:     Number(editForm.value.goal_id),
    goal_object: editForm.value.goal_object || null
  })
}

// ── Tree update helpers ───────────────────────────────────────────────────────

function applyEntrySaved(map_name, path_name, goal_id, goal_object) {
  const { body } = editForm.value
  const obj = goal_object || null
  if (!tree.value[map_name])             tree.value[map_name] = {}
  if (!tree.value[map_name][path_name])  tree.value[map_name][path_name] = []
  const list  = tree.value[map_name][path_name]
  const idx   = list.findIndex(p => Number(p.goal_id) === Number(goal_id) && (p.goal_object || null) === obj)
  const entry = { goal_id: Number(goal_id), goal_object: obj, body: body || null }
  if (idx >= 0) list[idx] = entry
  else          list.push(entry)
  ElMessage.success('已保存')
  closeEdit()
}

function applyEntryDeleted(map_name, path_name, goal_id, goal_object) {
  const list = tree.value[map_name]?.[path_name]
  if (!list) return
  const obj = goal_object || null
  const idx = list.findIndex(p => Number(p.goal_id) === Number(goal_id) && (p.goal_object || null) === obj)
  if (idx >= 0) list.splice(idx, 1)
  ElMessage.success('已删除')
  closeEdit()
}

// ── WebSocket ─────────────────────────────────────────────────────────────────

function send(type, data = {}) {
  props.wsRef?.send(JSON.stringify({ type, data }))
}

function handleMessage(raw) {
  try {
    const { type, data } = JSON.parse(raw)
    switch (type) {
      case 'KB_LIST':
        tree.value = data.tree || {}
        break
      case 'KB_ENTRY_SAVED':
        applyEntrySaved(data.map_name, data.path_name, data.goal_id, data.goal_object)
        break
      case 'KB_ENTRY_DELETED':
        applyEntryDeleted(data.map_name, data.path_name, data.goal_id, data.goal_object)
        break
      case 'CRUISING_AUDIO_FILES':
        if (data.map_name === selectedMap.value &&
            data.path_name === selectedPath.value &&
            Number(data.goal_id) === Number(selectedPoint.value?.goal_id)) {
          cruisingAudioFiles.value = data.files || []
        }
        break
      case 'CRUISING_AUDIO_FILES_UPDATED':
        if (data.map_name === selectedMap.value &&
            data.path_name === selectedPath.value &&
            Number(data.goal_id) === Number(selectedPoint.value?.goal_id)) {
          cruisingAudioFiles.value = data.files || []
        }
        break
      case 'KB_IMPORT_RESULT':
        if (data.ok) {
          ElMessage.success(`导入成功：新增 ${data.addedCount} 个点位，跳过 ${data.skippedCount} 个已存在点位。`)
        } else {
          ElMessage.error(`导入失败：${data.error}`)
        }
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
    send('GET_KB_LIST')
  }
}, { immediate: true })

function onMsg(e) { handleMessage(e.data) }
onUnmounted(() => { currentSocket?.removeEventListener('message', onMsg) })
</script>

<style scoped>
.ke-layout { display: flex; height: 100%; overflow: hidden; }

.ke-col { display: flex; flex-direction: column; width: 200px; min-width: 160px; border-right: 1px solid var(--border); overflow: hidden; }
.ke-col-wide { flex: 1; width: auto; border-right: none; }

.col-header { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-bottom: 1px solid var(--border); background: var(--bg2); flex-shrink: 0; }
.col-title { font-size: 11px; font-weight: 600; color: var(--text-dim); letter-spacing: .08em; text-transform: uppercase; display: flex; align-items: center; gap: 8px; }
.col-breadcrumb { font-size: 10px; color: var(--cyan); font-weight: 400; text-transform: none; letter-spacing: 0; font-family: var(--font-mono); }
.col-add-btn { background: none; border: 1px solid var(--border); color: var(--text-dim); width: 22px; height: 22px; border-radius: 4px; cursor: pointer; font-size: 14px; line-height: 1; display: flex; align-items: center; justify-content: center; }
.col-add-btn:hover:not(:disabled) { border-color: var(--green); color: var(--green); }
.col-add-btn:disabled { opacity: .3; cursor: default; }

.inline-new { display: flex; gap: 4px; padding: 8px 10px; background: var(--bg2); border-bottom: 1px solid var(--border); flex-shrink: 0; }
.inline-input { flex: 1; background: var(--bg3); border: 1px solid var(--border); color: var(--text); font-size: 12px; padding: 4px 8px; border-radius: 4px; outline: none; min-width: 0; }
.inline-input:focus { border-color: var(--cyan); }
.inline-ok { background: none; border: 1px solid var(--cyan); color: var(--cyan); font-size: 11px; padding: 3px 8px; border-radius: 4px; cursor: pointer; white-space: nowrap; }

.col-list { flex: 1; overflow-y: auto; padding: 6px 0; }
.col-item { padding: 8px 14px; font-size: 13px; color: var(--text-dim); cursor: pointer; font-family: var(--font-mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.col-item:hover  { background: var(--bg3); color: var(--text); }
.col-item.active { background: rgba(34,211,238,.1); color: var(--cyan); }
.col-empty { padding: 20px 14px; font-size: 12px; color: var(--text-dim); text-align: center; line-height: 1.6; }

.points-area  { display: flex; flex-direction: column; flex: 1; overflow: hidden; }

.point-list { flex: 1; overflow-y: auto; min-height: 0; padding: 6px 0; }
.point-item { display: flex; align-items: center; gap: 12px; padding: 9px 16px; cursor: pointer; border-left: 2px solid transparent; }
.point-item:hover  { background: var(--bg3); }
.point-item.active { background: rgba(34,211,238,.06); border-left-color: var(--cyan); }
.point-id      { font-family: var(--font-mono); font-size: 12px; color: var(--text-dim); min-width: 28px; max-width: 90px; flex-shrink: 0; }
.point-preview { font-size: 12px; color: var(--text-dim); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.point-item.active .point-preview { color: var(--text); }
.point-mp3-badge { font-size: 10px; font-weight: 600; color: #a78bfa; background: rgba(167,139,250,.12); padding: 1px 5px; border-radius: 3px; flex-shrink: 0; }

.edit-panel { flex-shrink: 0; border-top: 1px solid var(--border); background: var(--bg2); display: flex; flex-direction: column; max-height: 55%; }
.edit-panel-header { display: flex; align-items: center; justify-content: space-between; padding: 10px 16px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
.edit-panel-title  { font-size: 12px; font-weight: 600; color: var(--text); }
.panel-close { background: none; border: none; color: var(--text-dim); cursor: pointer; font-size: 14px; padding: 2px 4px; }
.panel-close:hover { color: var(--text); }
.edit-panel-body { flex: 1; overflow-y: auto; padding: 14px 16px; display: flex; flex-direction: column; gap: 14px; }
.edit-panel-footer { display: flex; align-items: center; gap: 8px; padding: 10px 16px; border-top: 1px solid var(--border); flex-shrink: 0; }
.form-row-2  { display: grid; grid-template-columns: 140px 1fr; gap: 12px; align-items: start; }
.field-row { display: flex; flex-direction: column; gap: 6px; }
.field-label { font-size: 11px; color: var(--text-dim); letter-spacing: .04em; }
.mp3-row { display: flex; gap: 8px; }
.mp3-row .el-input { flex: 1; }

.audio-management-box {
  background: var(--bg3);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 12px;
}
.audio-list-scroller {
  max-height: 150px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.audio-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 6px 12px;
}
.audio-name {
  font-size: 12px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.audio-delete-btn {
  padding: 2px !important;
  min-height: 20px !important;
  width: 20px !important;
  height: 20px !important;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px !important;
}
.audio-empty {
  font-size: 12px;
  color: var(--text-dim);
  text-align: center;
  padding: 15px 0;
}
</style>
