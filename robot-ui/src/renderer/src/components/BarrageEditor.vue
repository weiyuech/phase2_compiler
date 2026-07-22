<template>
  <div class="ke-layout">

    <!-- Header for Global Config -->
    <div class="barrage-header">
      <div class="header-row">
        <div class="mode-selector" style="display: inline-flex; align-items: center; flex-wrap: wrap; gap: 10px;">
          <span class="mode-label">弹幕回复模式：</span>
          <el-radio-group v-model="globalMode" size="small" @change="saveGlobalMode">
            <el-radio-button value="mp3">MP3 语音包模式</el-radio-button>
            <el-radio-button value="llm-strict">智能精准回答模式</el-radio-button>
            <el-radio-button value="llm-context">智能常规互动模式</el-radio-button>
          </el-radio-group>
          <span class="mode-label" style="margin-left: 15px;">回复策略：</span>
          <el-radio-group v-model="replyStrategy" size="small" @change="saveGlobalMode">
            <el-radio-button value="all">全部回复</el-radio-button>
            <el-radio-button value="priority">优先回复</el-radio-button>
            <el-radio-button value="random">随机回复</el-radio-button>
          </el-radio-group>
          <span v-if="modeSavedOk" class="ok-text" style="margin-left: 10px;">已保存</span>
        </div>

        <div v-if="globalMode !== 'mp3'" class="universal-doc-selector">
          <span class="mode-label">通用背景文档：</span>
          <div class="doc-row" style="display: inline-flex; align-items: center;">
            <el-input v-model="globalDocName" placeholder="未上传文档 (使用默认背景)..." size="small" style="width: 220px;" disabled />
            <el-button size="small" style="margin-left: 8px;" @click="pickGlobalDocFile">选择并上传 (.txt/.docx)</el-button>
          </div>
        </div>
      </div>
    </div>

    <div class="ke-body">
      <!-- Col 1: Concepts -->
      <div class="ke-col" style="min-width: 200px; max-width: 250px;">
        <div class="col-header">
          <span class="col-title">弹幕概念</span>
          <button class="col-add-btn" @click="showNewConcept = !showNewConcept">+</button>
        </div>

        <div v-if="showNewConcept" class="inline-new">
          <input
            v-model="newConceptName" ref="newConceptRef"
            class="inline-input" placeholder="新概念名称 (如: 价格)"
            @keyup.enter="createConcept" @keyup.escape="showNewConcept = false"
          />
          <button class="inline-ok" @click="createConcept">确认</button>
        </div>

        <div class="col-list">
          <div
            v-for="name in conceptList" :key="name"
            class="col-item" :class="{ active: selectedConcept === name }"
            @click="selectConcept(name)"
          >
            {{ name }}
          </div>
          <div v-if="conceptList.length === 0" class="col-empty">暂无概念，点击 + 新建</div>
        </div>
      </div>

      <!-- Col 2: Edit panel -->
      <div class="ke-col ke-col-wide">
        <div v-if="selectedConcept" class="edit-panel">
          <div class="edit-panel-header">
            <span class="edit-panel-title">编辑概念：{{ selectedConcept }}</span>
          </div>

          <div class="edit-panel-body">
            <div class="field-row">
              <label class="field-label">触发关键词 (逗号分隔)</label>
              <el-input
                v-model="editForm.keywords"
                placeholder="例如: 多少钱, how much, 要多少, 价格"
              />
              <p class="panel-note">识别到这些词之一时，将触发此概念的回复。若留空，默认以概念名称本身进行匹配。</p>
            </div>

            <div class="field-row" style="margin-top: 16px; flex-direction: row; align-items: center; justify-content: space-between;">
              <div>
                <label class="field-label">设为优先回复</label>
                <p class="panel-note" style="margin-top: 2px;">开启后，若在“优先回复模式”下，仅播报标为优先的概念。</p>
              </div>
              <el-switch v-model="editForm.priority" />
            </div>

            <!-- Upload Audio Files Section -->
            <div class="field-row" style="margin-top: 20px;">
              <label class="field-label">MP3 语音包文件管理 (支持上传多个，随机播放)</label>
              <div class="audio-management-box">
                <div class="audio-list-scroller">
                  <div v-for="file in audioFiles" :key="file" class="audio-item">
                    <span class="audio-name">🎵 {{ file }}</span>
                    <el-button
                      type="danger" circle size="small"
                      @click="deleteAudioFile(file)"
                      class="audio-delete-btn"
                    >✕</el-button>
                  </div>
                  <div v-if="audioFiles.length === 0" class="audio-empty">暂无音频文件，请点击下方上传</div>
                </div>
                <div class="audio-upload-bar" style="margin-top: 10px;">
                  <el-button type="primary" plain size="small" @click="uploadAudioFiles">
                    上传音频文件 (.mp3)
                  </el-button>
                </div>
              </div>
            </div>

            <div class="field-row" style="margin-top: 20px;">
              <p v-if="globalMode !== 'mp3'" class="panel-note" style="color: var(--cyan); font-weight: 500;">
                提示：当前处于 LLM 模式，系统在回答时会自动引用顶部上传的“通用背景文档”。
              </p>
              <p v-else class="panel-note" style="color: var(--amber); font-weight: 500;">
                提示：当前处于 MP3 语音包模式，系统不会读取文档。系统会从上方列表中随机挑选一个 MP3 播放。
              </p>
            </div>
          </div>

          <div class="edit-panel-footer">
            <el-button
              type="danger" plain size="small"
              @click="deleteConcept"
            >删除此概念</el-button>
            <div style="flex:1" />
            <span v-if="conceptSavedOk" class="ok-text" style="margin-right: 15px;">已保存</span>
            <el-button type="primary" size="small" :disabled="!wsConnected" @click="saveConcept">
              保存
            </el-button>
          </div>
        </div>
        <div v-else class="col-empty" style="margin-top: 40px; text-align: center;">
          ← 请在左侧选择或新建一个弹幕概念
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'

const props = defineProps({ wsRef: Object })

const wsConnected = ref(false)
const globalMode = ref('llm-strict')
const globalDocName = ref('')
const globalDocPath = ref('')
const globalPriorityMode = ref(false)
const globalRandomReply = ref(false)
const modeSavedOk = ref(false)

const replyStrategy = computed({
  get() {
    if (globalPriorityMode.value) return 'priority'
    if (globalRandomReply.value) return 'random'
    return 'all'
  },
  set(val) {
    if (val === 'priority') {
      globalPriorityMode.value = true
      globalRandomReply.value = false
    } else if (val === 'random') {
      globalPriorityMode.value = false
      globalRandomReply.value = true
    } else {
      globalPriorityMode.value = false
      globalRandomReply.value = false
    }
  }
})

const conceptList = ref([])
const conceptsMap = ref({}) // name -> { keywords: [] }

const selectedConcept = ref(null)
const showNewConcept = ref(false)
const newConceptName = ref('')
const newConceptRef = ref(null)

const editForm = ref({ keywords: '', priority: false })
const conceptSavedOk = ref(false)
const audioFiles = ref([])

function send(type, data) {
  if (props.wsRef?.readyState === WebSocket.OPEN) {
    props.wsRef.send(JSON.stringify({ type, data }))
  }
}

watch(() => props.wsRef, (ws) => {
  if (!ws) { wsConnected.value = false; return }
  wsConnected.value = ws.readyState === WebSocket.OPEN
  
  const onMsg = (e) => {
    try {
      const msg = JSON.parse(e.data)
      if (msg.type === 'BARRAGE_CONFIG') {
        globalMode.value = msg.data.mode || 'llm-strict'
        globalDocName.value = msg.data.document_name || ''
        globalDocPath.value = ''
        globalPriorityMode.value = msg.data.priority_mode || false
        globalRandomReply.value = msg.data.random_reply || false
      }
      else if (msg.type === 'BARRAGE_CONCEPTS') {
        conceptsMap.value = msg.data
        conceptList.value = Object.keys(msg.data).sort()
        if (selectedConcept.value && !conceptList.value.includes(selectedConcept.value)) {
          selectedConcept.value = null
        }
      }
      else if (msg.type === 'BARRAGE_CONFIG_SAVED') {
        modeSavedOk.value = true
        setTimeout(() => { modeSavedOk.value = false }, 2000)
      }
      else if (msg.type === 'BARRAGE_CONCEPT_SAVED') {
        conceptSavedOk.value = true
        setTimeout(() => { conceptSavedOk.value = false }, 2000)
        // refresh list
        send('GET_BARRAGE_CONCEPTS')
      }
      else if (msg.type === 'BARRAGE_CONCEPT_DELETED') {
        if (selectedConcept.value === msg.data.name) {
          selectedConcept.value = null
        }
        send('GET_BARRAGE_CONCEPTS')
      }
      else if (msg.type === 'BARRAGE_AUDIO_FILES') {
        if (msg.data.conceptName === selectedConcept.value) {
          audioFiles.value = msg.data.files || []
        }
      }
      else if (msg.type === 'BARRAGE_AUDIO_FILES_UPDATED') {
        if (msg.data.conceptName === selectedConcept.value) {
          audioFiles.value = msg.data.files || []
        }
      }
    } catch { /* ignore */ }
  }

  ws.addEventListener('message', onMsg)
  
  const onOpen = () => {
    wsConnected.value = true
    send('GET_BARRAGE_CONFIG')
    send('GET_BARRAGE_CONCEPTS')
  }
  
  const onClose = () => { wsConnected.value = false }
  
  ws.addEventListener('open', onOpen)
  ws.addEventListener('close', onClose)
  
  if (wsConnected.value) {
    send('GET_BARRAGE_CONFIG')
    send('GET_BARRAGE_CONCEPTS')
  }

  onUnmounted(() => {
    ws.removeEventListener('message', onMsg)
    ws.removeEventListener('open', onOpen)
    ws.removeEventListener('close', onClose)
  })
}, { immediate: true })

function saveGlobalMode() {
  send('SET_BARRAGE_CONFIG', {
    mode: globalMode.value,
    document_name: globalDocName.value,
    document_path: globalDocPath.value,
    priority_mode: globalPriorityMode.value,
    random_reply: globalRandomReply.value
  })
}

async function pickGlobalDocFile() {
  try {
    const filePath = await window.api.selectDocumentFile()
    if (filePath) {
      globalDocPath.value = filePath
      const separator = filePath.includes('\\') ? '\\' : '/'
      globalDocName.value = filePath.split(separator).pop()
      saveGlobalMode()
    }
  } catch (err) {
    ElMessage.error('选择文档失败')
  }
}

function createConcept() {
  const name = newConceptName.value.trim()
  if (!name) return
  if (conceptList.value.includes(name)) {
    ElMessage.warning('概念已存在')
    return
  }
  showNewConcept.value = false
  newConceptName.value = ''
  
  // Just select it, don't save to backend until they hit save
  conceptList.value.push(name)
  conceptList.value.sort()
  conceptsMap.value[name] = { keywords: [], priority: false }
  selectConcept(name)
}

function selectConcept(name) {
  selectedConcept.value = name
  const data = conceptsMap.value[name] || { keywords: [], priority: false }
  editForm.value = {
    keywords: data.keywords.join(', '),
    priority: data.priority || false
  }
  
  // Fetch audio files list
  audioFiles.value = []
  send('GET_BARRAGE_AUDIO_FILES', { conceptName: name })
}

async function uploadAudioFiles() {
  if (!selectedConcept.value) return
  try {
    const paths = await window.api.selectMultipleMp3Files()
    if (paths && paths.length > 0) {
      send('UPLOAD_BARRAGE_AUDIO', {
        conceptName: selectedConcept.value,
        filePaths: paths
      })
    }
  } catch (err) {
    ElMessage.error('上传音频文件失败')
  }
}

async function deleteAudioFile(filename) {
  if (!selectedConcept.value) return
  try {
    await ElMessageBox.confirm(`确定要删除音频文件 "${filename}" 吗？`, '确认删除', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    })
    send('DELETE_BARRAGE_AUDIO', {
      conceptName: selectedConcept.value,
      filename
    })
  } catch { /* cancel */ }
}

function saveConcept() {
  if (!selectedConcept.value) return
  const keywords = editForm.value.keywords ? editForm.value.keywords.split(/[,，]/).map(k => k.trim()).filter(Boolean) : []

  send('SAVE_BARRAGE_CONCEPT', {
    name: selectedConcept.value,
    keywords,
    priority: editForm.value.priority
  })
}

async function deleteConcept() {
  if (!selectedConcept.value) return
  try {
    await ElMessageBox.confirm(`确定要删除弹幕概念 "${selectedConcept.value}" 吗？`, '确认删除', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    })
    send('DELETE_BARRAGE_CONCEPT', { name: selectedConcept.value })
  } catch { /* cancel */ }
}
</script>

<style scoped>
.ke-layout {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg);
}

.barrage-header {
  padding: 12px 20px;
  background: var(--bg2);
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
}

.mode-label {
  font-size: 13px;
  color: var(--text-dim);
  margin-right: 12px;
  font-weight: 600;
}

.ke-body {
  display: flex;
  flex: 1;
  overflow: hidden;
}

.ke-col {
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border);
  background: var(--bg2);
}

.ke-col-wide {
  flex: 1;
  background: var(--bg);
}

.col-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 11px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg3);
}

.col-title { font-size: 13px; font-weight: 600; color: var(--text); }

.col-add-btn {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--text-dim);
  border-radius: 4px;
  width: 24px;
  height: 24px;
  cursor: pointer;
}
.col-add-btn:hover:not(:disabled) {
  border-color: var(--amber);
  color: var(--amber);
}

.inline-new {
  display: flex;
  padding: 8px 12px;
  background: #111418;
  border-bottom: 1px solid var(--border);
  gap: 8px;
}
.inline-input {
  flex: 1;
  background: transparent;
  border: none;
  color: var(--text);
  font-size: 13px;
  outline: none;
  min-width: 0;
}
.inline-ok {
  background: var(--amber);
  color: #000;
  border: none;
  border-radius: 3px;
  padding: 0 8px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.col-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px 0;
}

.col-item {
  padding: 8px 16px;
  font-size: 13px;
  color: var(--text-dim);
  cursor: pointer;
  border-left: 2px solid transparent;
}
.col-item:hover { background: var(--bg3); color: var(--text); }
.col-item.active { background: var(--bg3); color: var(--text); border-left-color: var(--cyan); }
.col-empty { padding: 16px; font-size: 12px; color: #4b5563; text-align: center; }

/* Edit Panel */
.edit-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.edit-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 20px;
  border-bottom: 1px solid var(--border);
  background: var(--bg2);
}
.edit-panel-title { font-size: 14px; font-weight: 600; }
.edit-panel-body {
  flex: 1;
  padding: 20px;
  overflow-y: auto;
}
.field-row { display: flex; flex-direction: column; gap: 8px; }
.field-label { font-size: 13px; color: var(--text-dim); font-weight: 600; }
.panel-note { font-size: 12px; color: var(--text-dim); margin-top: 4px; }
.edit-panel-footer {
  display: flex;
  align-items: center;
  padding: 12px 20px;
  border-top: 1px solid var(--border);
  background: var(--bg2);
}

.ok-text { font-size: 12px; color: var(--green); }
.doc-row { display: flex; gap: 8px; }
.doc-row .el-input { flex: 1; }
.header-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 16px;
  width: 100%;
}
.universal-doc-selector {
  display: flex;
  align-items: center;
  gap: 10px;
}
.audio-management-box {
  background: var(--bg3);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 12px;
}
.audio-list-scroller {
  max-height: 200px;
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
  padding: 20px 0;
}
</style>