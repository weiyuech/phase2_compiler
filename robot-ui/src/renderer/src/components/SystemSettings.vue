<template>
  <div class="settings-shell">

    <!-- Left nav -->
    <nav class="settings-nav">
      <div
        v-for="item in navItems"
        :key="item.key"
        class="nav-item"
        :class="{ active: activeSection === item.key }"
        @click="activeSection = item.key"
      >
        {{ item.label }}
      </div>
    </nav>

    <!-- Right panel -->
    <div class="settings-panel">

      <!-- ── 违禁词 ─────────────────────────────────────────────────────── -->
      <template v-if="activeSection === 'banned'">
        <div class="panel-header">违禁词</div>
        <div class="panel-body">
          <div class="word-tags">
            <el-tag
              v-for="(w, i) in bannedWords"
              :key="i"
              closable
              type="danger"
              size="small"
              @close="removeWord(i)"
            >{{ w }}</el-tag>
            <span v-if="bannedWords.length === 0" class="hint">暂无违禁词</span>
          </div>
          <div class="row-actions">
            <el-input
              v-model="newWord"
              placeholder="添加词条，回车确认"
              size="small"
              style="width: 220px"
              @keyup.enter="addWord"
            />
            <el-button size="small" plain @click="addWord">添加</el-button>
            <el-button size="small" type="primary" :loading="savingWords" @click="saveBannedWords">
              保存
            </el-button>
            <span v-if="wordsSavedOk" class="ok-text">已保存</span>
          </div>
        </div>
      </template>

      <!-- ── 改写提示词 ──────────────────────────────────────────────────── -->
      <template v-else-if="activeSection === 'prompt'">
        <div class="panel-header">改写提示词</div>
        <div class="panel-body panel-body--stretch" style="gap: 20px">
          <div>
            <div class="prompt-header-row" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
              <span class="section-sub-title" style="color: var(--text); font-size: 13px; font-weight: 600;">导播提示词</span>
              <div style="display: flex; align-items: center; gap: 6px;">
                <span style="font-size: 12px; color: var(--text-dim)">自定义</span>
                <el-switch v-model="customCruiseEnabled" size="small" @change="handleCruiseSwitch" />
              </div>
            </div>
            <el-input v-model="promptText" type="textarea" :rows="3" class="prompt-textarea" :disabled="!customCruiseEnabled" />
            <p class="panel-note">当机器人对准目标物体时，程序会自动在末尾追加目标信息</p>
          </div>

          <div>
            <div class="prompt-header-row" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
              <span class="section-sub-title" style="color: var(--text); font-size: 13px; font-weight: 600;">弹幕 - 精准回答提示词</span>
              <div style="display: flex; align-items: center; gap: 6px;">
                <span style="font-size: 12px; color: var(--text-dim)">自定义</span>
                <el-switch v-model="customBarrageNameEnabled" size="small" @change="handleBarrageNameSwitch" />
              </div>
            </div>
            <el-input v-model="barrageNameText" type="textarea" :rows="3" class="prompt-textarea" :disabled="!customBarrageNameEnabled" />
          </div>

          <div>
            <div class="prompt-header-row" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
              <span class="section-sub-title" style="color: var(--text); font-size: 13px; font-weight: 600;">弹幕 - 常规问答提示词</span>
              <div style="display: flex; align-items: center; gap: 6px;">
                <span style="font-size: 12px; color: var(--text-dim)">自定义</span>
                <el-switch v-model="customBarrageGeneralEnabled" size="small" @change="handleBarrageGeneralSwitch" />
              </div>
            </div>
            <el-input v-model="barrageGeneralText" type="textarea" :rows="3" class="prompt-textarea" :disabled="!customBarrageGeneralEnabled" />
          </div>

          <div class="row-actions" style="margin-top: auto; padding-top: 16px;">
            <el-button type="primary" :loading="savingPrompt" @click="savePrompt">保存全部提示词</el-button>
            <span v-if="promptSavedOk" class="ok-text">已保存，后端已重载</span>
          </div>
        </div>
      </template>

      <!-- ── 导播设置 ─────────────────────────────────────────────────────── -->
      <template v-else-if="activeSection === 'cruise'">
        <div class="panel-header">导播设置</div>
        <div class="panel-body">
          <div class="section-sub-title" style="margin-bottom: 12px; color: var(--text); font-size: 13px; font-weight: 600;">运行参数</div>
          <div class="params-grid">
            <template v-for="item in cruisePublicEnvDef" :key="item.key">
              <span class="param-label">{{ item.label }}</span>
              <el-select v-if="item.options" v-model="publicEnv[item.key]" size="small" style="width: 200px">
                <el-option v-for="o in item.options" :key="o" :label="o" :value="o" />
              </el-select>
              <el-input v-else v-model="publicEnv[item.key]" :placeholder="item.placeholder || ''" size="small" style="width: 200px" />
            </template>
          </div>
          <div class="row-actions" style="margin-top: 16px; margin-bottom: 32px">
            <el-button type="primary" :loading="savingPublic" @click="savePublicEnv">保存并重启</el-button>
            <span v-if="publicSavedOk" class="ok-text">{{ restartMsg }}</span>
          </div>

          <div class="section-sub-title" style="margin-bottom: 12px; color: var(--text); font-size: 13px; font-weight: 600;">
            API 密钥
            <span class="lock-chip" :class="{ unlocked: sensitiveUnlocked }">
              {{ sensitiveUnlocked ? '已解锁' : '已锁定' }}
            </span>
          </div>
          
          <!-- 首次使用：设置密码 -->
          <template v-if="!hasPassword">
            <p class="panel-note" style="margin-bottom: 16px">请先设置管理员密码以保护 API 密钥</p>
            <div class="key-form">
              <span class="param-label">新密码</span>
              <el-input v-model="setupPwd1" type="password" show-password size="small" style="width: 240px" placeholder="至少 4 位" />
              <span class="param-label">确认密码</span>
              <el-input v-model="setupPwd2" type="password" show-password size="small" style="width: 240px" @keyup.enter="doSetPassword" />
            </div>
            <div class="row-actions" style="margin-top: 16px">
              <el-button type="primary" :loading="settingPwd" :disabled="!setupPwd1 || !setupPwd2" @click="doSetPassword">设置密码</el-button>
              <span v-if="pwdError" class="err-text">{{ pwdError }}</span>
            </div>
          </template>

          <!-- 已锁定 -->
          <template v-else-if="!sensitiveUnlocked">
            <div class="masked-rows">
              <div v-for="key in cruiseSensitiveKeys" :key="key" class="masked-row">
                <span class="key-name">{{ key }}</span>
                <span class="key-mask">••••••••••••••••</span>
              </div>
            </div>
            <div class="row-actions" style="margin-top: 16px">
              <el-button :disabled="cooldownLeft > 0" @click="doUnlock">{{ cooldownLeft > 0 ? `解锁（${cooldownLeft}s）` : '解锁' }}</el-button>
              <el-button plain @click="doChangePassword">修改密码</el-button>
              <span v-if="unlockError" class="err-text">{{ unlockError }}</span>
            </div>
          </template>

          <!-- 已解锁 -->
          <template v-else>
            <div class="key-form">
              <template v-for="key in cruiseSensitiveKeys" :key="key">
                <span class="param-label key-name-label">{{ key }}</span>
                <el-input v-model="sensitiveEnv[key]" type="password" show-password size="small" style="width: 320px" :placeholder="key" />
              </template>
            </div>
            <div class="row-actions" style="margin-top: 20px">
              <el-button type="primary" :loading="savingSensitive" @click="saveSensitiveEnv">保存并重启</el-button>
              <el-button plain @click="lockSensitive">取消</el-button>
              <span v-if="sensitiveSavedOk" class="ok-text">{{ restartMsg }}</span>
            </div>
          </template>
        </div>
      </template>

      <!-- ── 弹幕设置 ─────────────────────────────────────────────────────── -->
      <template v-else-if="activeSection === 'barrage'">
        <div class="panel-header">弹幕设置</div>
        <div class="panel-body">
          <div class="section-sub-title" style="margin-bottom: 12px; color: var(--text); font-size: 13px; font-weight: 600;">运行参数</div>
          <div class="params-grid">
            <template v-for="item in barragePublicEnvDef" :key="item.key">
              <span class="param-label">{{ item.label }}</span>
              <el-select v-if="item.options" v-model="publicEnv[item.key]" size="small" style="width: 200px">
                <el-option v-for="o in item.options" :key="o" :label="o" :value="o" />
              </el-select>
              <el-input v-else v-model="publicEnv[item.key]" :placeholder="item.placeholder || ''" size="small" style="width: 200px" />
            </template>
          </div>
          <div class="row-actions" style="margin-top: 16px; margin-bottom: 32px">
            <el-button type="primary" :loading="savingPublic" @click="savePublicEnv">保存并重启</el-button>
            <span v-if="publicSavedOk" class="ok-text">{{ restartMsg }}</span>
          </div>

          <div class="section-sub-title" style="margin-bottom: 12px; color: var(--text); font-size: 13px; font-weight: 600;">
            API 密钥
            <span class="lock-chip" :class="{ unlocked: sensitiveUnlocked }">
              {{ sensitiveUnlocked ? '已解锁' : '已锁定' }}
            </span>
          </div>
          
          <!-- 首次使用：设置密码 -->
          <template v-if="!hasPassword">
            <p class="panel-note" style="margin-bottom: 16px">请先设置管理员密码以保护 API 密钥</p>
            <div class="key-form">
              <span class="param-label">新密码</span>
              <el-input v-model="setupPwd1" type="password" show-password size="small" style="width: 240px" placeholder="至少 4 位" />
              <span class="param-label">确认密码</span>
              <el-input v-model="setupPwd2" type="password" show-password size="small" style="width: 240px" @keyup.enter="doSetPassword" />
            </div>
            <div class="row-actions" style="margin-top: 16px">
              <el-button type="primary" :loading="settingPwd" :disabled="!setupPwd1 || !setupPwd2" @click="doSetPassword">设置密码</el-button>
              <span v-if="pwdError" class="err-text">{{ pwdError }}</span>
            </div>
          </template>

          <!-- 已锁定 -->
          <template v-else-if="!sensitiveUnlocked">
            <div class="masked-rows">
              <div v-for="key in barrageSensitiveKeys" :key="key" class="masked-row">
                <span class="key-name">{{ key }}</span>
                <span class="key-mask">••••••••••••••••</span>
              </div>
            </div>
            <div class="row-actions" style="margin-top: 16px">
              <el-button :disabled="cooldownLeft > 0" @click="doUnlock">
                {{ cooldownLeft > 0 ? `解锁（${cooldownLeft}s）` : '解锁' }}
              </el-button>
              <el-button plain @click="doChangePassword">修改密码</el-button>
              <span v-if="unlockError" class="err-text">{{ unlockError }}</span>
            </div>
          </template>

          <!-- 已解锁 -->
          <template v-else>
            <div class="key-form">
              <template v-for="key in barrageSensitiveKeys" :key="key">
                <span class="param-label key-name-label">{{ key }}</span>
                <el-input
                  v-model="sensitiveEnv[key]"
                  type="password"
                  show-password
                  size="small"
                  style="width: 320px"
                  :placeholder="key"
                />
              </template>
            </div>
            <div class="row-actions" style="margin-top: 20px">
              <el-button type="primary" :loading="savingSensitive" @click="saveSensitiveEnv">
                保存并重启
              </el-button>
              <el-button plain @click="lockSensitive">取消</el-button>
              <span v-if="sensitiveSavedOk" class="ok-text">{{ restartMsg }}</span>
            </div>
          </template>

        </div>
      </template>

      <!-- ── 过渡音频 ─────────────────────────────────────────────────────── -->
      <template v-else-if="activeSection === 'transit'">
        <div class="panel-header">过渡音频</div>
        <div class="panel-body">
          <p class="panel-note" style="margin-bottom: 16px">
            机器人行进期间循环播放，到达下一个点位时自动停止。
          </p>
          <div class="params-grid">
            <span class="param-label">启用过渡音频</span>
            <el-switch v-model="transitConfig.enabled" />

            <span class="param-label">音频类型</span>
            <el-radio-group v-model="transitConfig.type" size="small">
              <el-radio-button value="tts">TTS 文字</el-radio-button>
              <el-radio-button value="mp3">MP3 文件</el-radio-button>
            </el-radio-group>

            <template v-if="transitConfig.type === 'tts'">
              <span class="param-label" style="align-self: flex-start; padding-top: 6px">播报文字</span>
              <div>
                <el-input
                  v-model="transitConfig.text"
                  type="textarea"
                  :rows="3"
                  placeholder="例：正在前往下一个展区，请稍候……"
                  style="width: 320px"
                />
                <p class="param-hint">经 LLM 改写后合成语音，每次行进改写一次并缓存循环</p>
              </div>
            </template>

            <template v-else>
              <span class="param-label">MP3 文件</span>
              <div class="mp3-row">
                <el-input
                  v-model="transitConfig.mp3_file"
                  placeholder="点击选择文件按钮选取"
                  size="small"
                  style="width: 240px"
                  readonly
                />
                <el-button size="small" @click="pickTransitMp3">选择文件</el-button>
              </div>
            </template>
          </div>

          <div class="row-actions" style="margin-top: 20px">
            <el-button type="primary" :loading="savingTransit" @click="saveTransitConfig">保存</el-button>
            <span v-if="transitSavedOk" class="ok-text">已保存，下次发目标点时生效</span>
          </div>
        </div>
      </template>

    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, onBeforeUnmount, watch } from 'vue'
import { ElMessageBox, ElMessage }                   from 'element-plus'

const props = defineProps({ wsRef: Object })

const navItems = [
  { key: 'cruise',  label: '导播设置'  },
  { key: 'barrage', label: '弹幕设置'  },
  { key: 'prompt',  label: '改写提示词' },
  { key: 'banned',  label: '违禁词管理'   },
  { key: 'transit', label: '过渡音频'  },
]
const activeSection = ref('cruise')

// ── 违禁词 ─────────────────────────────────────────────────────────────────────
const bannedWords  = ref([])
const newWord      = ref('')
const savingWords  = ref(false)
const wordsSavedOk = ref(false)

async function loadBannedWords() {
  if (!window.api) return
  try {
    const res = await window.api.readBannedWords()
    if (res.ok) bannedWords.value = res.words.filter(w => !w.startsWith('#'))
  } catch {}
}

function addWord() {
  const w = newWord.value.trim()
  if (w && !bannedWords.value.includes(w)) bannedWords.value.push(w)
  newWord.value = ''
}

function removeWord(i) { bannedWords.value.splice(i, 1) }

async function saveBannedWords() {
  if (!window.api) return
  savingWords.value = true
  try {
    const res = await window.api.writeBannedWords([...bannedWords.value])
    if (!res.ok) { ElMessage.error(res.error || '保存失败'); return }
    props.wsRef?.value?.send(JSON.stringify({ type: 'RELOAD_BANNED_WORDS' }))
    wordsSavedOk.value = true
    setTimeout(() => { wordsSavedOk.value = false }, 3000)
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    savingWords.value = false
  }
}

// ── 改写提示词 ─────────────────────────────────────────────────────────────────
const promptText   = ref('')
const barrageNameText = ref('')
const barrageGeneralText = ref('')
const savingPrompt = ref(false)
const promptSavedOk = ref(false)

// Constants for default system prompts
const DEFAULT_CRUISE = '你是一名直播讲解员，请将讲解文本改写为口播版本，语言自然流畅。'

const DEFAULT_BARRAGE_NAME = `你是一个专业的直播助播机器人。你需要根据用户提供的 <document> 文档事实，对 <barrage_text> 中的弹幕问题进行精准且口语化的回答。

【回复规则】
1. 从输入的 <barrage_text> 中识别并提取发送弹幕的用户网名（通常格式为 “用户名: 提问内容”，例如 “北京小王: 那个车多少钱” 中的网名是 “北京小王”）。
2. 你必须首先直接称呼并感谢该网名（例如：“谢谢【北京小王】的提问，关于...” 或 “【北京小王】你好，关于这个越野车...”）。
3. 你的回答必须严格基于 <document> 中提供的事实。如果文档中没有相关信息，请礼貌地表明“这个问题小助手暂时在文档中找不到，我们会帮您记录哦”。不要编造文档之外的任何数据或规格。
4. 回答要简近、生动、口语化，适合通过语音合成进行播放。字数控制在 50 至 80 字以内。`

const DEFAULT_BARRAGE_GENERAL = `你是一个活泼亲切的直播间助手。你需要根据用户提供的 <document> 文档事实，对 <barrage_text> 中的弹幕问题进行幽默、风趣、口语化的解答。

【回复规则】（请严格遵守）

1. **去网名，直接答**：忽略发送弹幕的网名，不需要称呼或者感谢特定用户，直接切入核心回答问题。
2. **拟人化风格**：保持机器人拟人化的亲切风格，使用生动的口语化表达（例如：“哈哈，看到大家都在关心...” 或 “来啦来啦，给大家统一解答一下...”）。
3. **【核心重中之重：混合问题处理】** 你需要仔细拆解弹幕里的所有问题，并与 <document> 进行比对：
   - **文档里有的（必须答）**：只要文档中存在对应事实，你必须将其转化为口语回答。**绝对不允许因为包含超纲问题而拒绝解答已知问题！**
   - **文档里没有的（兜底）**：遇到文档里完全没有的信息，绝不要编造。你只需要在整段回答中顺嘴加一句“关于部分没提到的细节，大家可以找后台小助理咨询哦～”即可。
4. **合并与去重**：
   - 如果检测到多个人在提问相同或非常相似的内容，**只回答一次即可**，不需要重复解答。
   - 如果他们提问的是不同的事情（例如“酒店价格”和“早餐价格”，或是“分期”和“快递”），你必须**分别且仔细地逐一进行解答**，并将所有的解答自然地串联成一段连贯的话。
5. **字数与节奏控制**：整体回复要适合语音播报，短平快。不要被总字数限制死，但**针对每一个具体事实的解答部分**请控制在 20 字左右，保持精炼。`

// Switch states & customized text backups
const customCruiseEnabled = ref(false)
const customCruiseText = ref('')
const customBarrageNameEnabled = ref(false)
const customBarrageNameText = ref('')
const customBarrageGeneralEnabled = ref(false)
const customBarrageGeneralText = ref('')

function isDefaultMatch(savedText, defaultText) {
  if (!savedText) return true
  const normalize = (t) => t.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim()
  return normalize(savedText) === normalize(defaultText)
}

async function loadPrompt() {
  if (!window.api) return
  try {
    const res = await window.api.readLlmPrompt()
    if (res.ok) {
      const text = res.text
      if (isDefaultMatch(text, DEFAULT_CRUISE)) {
        customCruiseEnabled.value = false
        promptText.value = DEFAULT_CRUISE
      } else {
        customCruiseEnabled.value = true
        customCruiseText.value = text
        promptText.value = text
      }
    }
    
    const resName = await window.api.readBarragePromptName()
    if (resName.ok) {
      const text = resName.text
      if (isDefaultMatch(text, DEFAULT_BARRAGE_NAME)) {
        customBarrageNameEnabled.value = false
        barrageNameText.value = DEFAULT_BARRAGE_NAME
      } else {
        customBarrageNameEnabled.value = true
        customBarrageNameText.value = text
        barrageNameText.value = text
      }
    }
    
    const resGen = await window.api.readBarragePromptGeneral()
    if (resGen.ok) {
      const text = resGen.text
      if (isDefaultMatch(text, DEFAULT_BARRAGE_GENERAL)) {
        customBarrageGeneralEnabled.value = false
        barrageGeneralText.value = DEFAULT_BARRAGE_GENERAL
      } else {
        customBarrageGeneralEnabled.value = true
        customBarrageGeneralText.value = text
        barrageGeneralText.value = text
      }
    }
  } catch {}
}

function handleCruiseSwitch(val) {
  if (val) {
    promptText.value = customCruiseText.value || DEFAULT_CRUISE
  } else {
    customCruiseText.value = promptText.value
    promptText.value = DEFAULT_CRUISE
  }
}

function handleBarrageNameSwitch(val) {
  if (val) {
    barrageNameText.value = customBarrageNameText.value || DEFAULT_BARRAGE_NAME
  } else {
    customBarrageNameText.value = barrageNameText.value
    barrageNameText.value = DEFAULT_BARRAGE_NAME
  }
}

function handleBarrageGeneralSwitch(val) {
  if (val) {
    barrageGeneralText.value = customBarrageGeneralText.value || DEFAULT_BARRAGE_GENERAL
  } else {
    customBarrageGeneralText.value = barrageGeneralText.value
    barrageGeneralText.value = DEFAULT_BARRAGE_GENERAL
  }
}

watch(promptText, (newVal) => {
  if (customCruiseEnabled.value) {
    customCruiseText.value = newVal
  }
})
watch(barrageNameText, (newVal) => {
  if (customBarrageNameEnabled.value) {
    customBarrageNameText.value = newVal
  }
})
watch(barrageGeneralText, (newVal) => {
  if (customBarrageGeneralEnabled.value) {
    customBarrageGeneralText.value = newVal
  }
})

async function savePrompt() {
  if (!window.api) return
  savingPrompt.value = true
  try {
    const res = await window.api.writeLlmPrompt(promptText.value)
    if (!res.ok) throw new Error(res.error || '保存失败')
    
    const resName = await window.api.writeBarragePromptName(barrageNameText.value)
    if (!resName.ok) throw new Error(resName.error || '保存失败')
    
    const resGen = await window.api.writeBarragePromptGeneral(barrageGeneralText.value)
    if (!resGen.ok) throw new Error(resGen.error || '保存失败')

    props.wsRef?.value?.send(JSON.stringify({ type: 'RELOAD_PROMPT' }))
    promptSavedOk.value = true
    setTimeout(() => { promptSavedOk.value = false }, 3000)
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    savingPrompt.value = false
  }
}

// ── 运行参数 ───────────────────────────────────────────────────────────────────
const cruisePublicEnvDef = [
  { key: 'DOUBAO_MODEL',   label: '豆包模型 ID',    placeholder: 'ep-xxxxxxxx' },
  { key: 'DEEPSEEK_MODEL', label: 'DeepSeek 模型',  placeholder: 'deepseek-chat' },
  { key: 'TTS_VOICE_TYPE', label: 'TTS 音色 ID',  placeholder: 'BV001_streaming 或复刻音色 S_xxxxxxxxxx' },
  { key: 'TTS_CLUSTER',   label: 'TTS Cluster', placeholder: 'volcano_tts（内置）/ volcano_icl（复刻）' },
  { key: 'LLM_TIMEOUT_MS', label: 'LLM 超时 (ms)',  placeholder: '8000' },
  { key: 'ROBOT_PORT',     label: '机器人监听端口',  placeholder: '8765' },
  { key: 'ROBOT_URL',      label: '机器人 WS 连接地址', placeholder: '空为监听模式 / 填写如 ws://192.168.1.100:8765' },
]

const barragePublicEnvDef = [
  { key: 'BARRAGE_DOUBAO_MODEL',   label: '豆包模型 ID',    placeholder: 'ep-xxxxxxxx' },
  { key: 'BARRAGE_DEEPSEEK_MODEL', label: 'DeepSeek 模型',  placeholder: 'deepseek-chat' },
  { key: 'BARRAGE_TTS_VOICE_TYPE', label: 'TTS 音色 ID',  placeholder: 'BV001_streaming 或复刻音色 S_xxxxxxxxxx' },
  { key: 'BARRAGE_TTS_CLUSTER',   label: 'TTS Cluster', placeholder: 'volcano_tts（内置）/ volcano_icl（复刻）' },
  { key: 'BARRAGE_LLM_TIMEOUT_MS', label: 'LLM 超时 (ms)',  placeholder: '8000' },
]

const publicEnv    = reactive({})
const savingPublic = ref(false)
const publicSavedOk = ref(false)

async function loadPublicEnv() {
  if (!window.api) return
  try {
    const res = await window.api.readPublicEnv()
    if (res.ok) Object.assign(publicEnv, res.env)
  } catch {}
}

async function savePublicEnv() {
  if (!window.api) return
  savingPublic.value = true
  try {
    const res = await window.api.writePublicEnv({ ...publicEnv })
    if (!res.ok) { ElMessage.error(res.error || '保存失败'); return }
    publicSavedOk.value = true
    await triggerRestart()
    setTimeout(() => { publicSavedOk.value = false }, 4000)
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    savingPublic.value = false
  }
}

// ── 重启后端（保存密钥/参数后调用）──────────────────────────────────────────
const restartMsg = ref('')

async function triggerRestart() {
  if (!window.api?.restartBackend) return
  restartMsg.value = '已保存，后端重启中…'
  try {
    await window.api.restartBackend()
    // 给后端约 2s 启动，再更新提示
    setTimeout(() => { restartMsg.value = '已生效，前端将自动重连' }, 2000)
  } catch (e) {
    restartMsg.value = '重启失败：' + e.message
  }
}

// ── API 密钥 ───────────────────────────────────────────────────────────────────
const cruiseSensitiveKeys = [
  'DOUBAO_API_KEY', 'DEEPSEEK_API_KEY', 'QWEN_API_KEY',
  'TTS_APP_ID', 'TTS_ACCESS_TOKEN',
  // 'NGROK_AUTHTOKEN',
]

const barrageSensitiveKeys = [
  'BARRAGE_DOUBAO_API_KEY', 'BARRAGE_DEEPSEEK_API_KEY', 'BARRAGE_QWEN_API_KEY',
  'BARRAGE_TTS_APP_ID', 'BARRAGE_TTS_ACCESS_TOKEN'
]

const hasPassword       = ref(false)
const sensitiveUnlocked = ref(false)
const sensitiveEnv      = reactive({})
const savingSensitive   = ref(false)
const sensitiveSavedOk  = ref(false)
const unlockError       = ref('')
const pwdError          = ref('')
const settingPwd        = ref(false)
const setupPwd1         = ref('')
const setupPwd2         = ref('')

let failedAttempts = 0
const cooldownLeft = ref(0)
let cooldownTimer  = null
let _sessionPwd    = ''

async function loadHasPassword() {
  if (!window.api) return
  try { hasPassword.value = await window.api.adminHasPassword() } catch {}
}

async function doSetPassword() {
  if (!window.api) return
  pwdError.value = ''
  if (setupPwd1.value !== setupPwd2.value) { pwdError.value = '两次密码不一致'; return }
  if (setupPwd1.value.length < 4)          { pwdError.value = '密码至少 4 位';  return }
  settingPwd.value = true
  try {
    const res = await window.api.adminSetPassword(setupPwd1.value)
    if (!res.ok) { pwdError.value = res.error || '设置失败'; return }
  } catch (e) {
    pwdError.value = e.message; return
  } finally {
    settingPwd.value = false
  }
  hasPassword.value = true
  // Auto-unlock: skip redundant re-entry of password
  try {
    const envRes = await window.api.readSensitiveEnv(setupPwd1.value)
    _sessionPwd = setupPwd1.value
    if (envRes.ok) Object.assign(sensitiveEnv, envRes.env)
  } catch {}
  setupPwd1.value = setupPwd2.value = ''
  sensitiveUnlocked.value = true
}

async function doUnlock() {
  if (cooldownLeft.value > 0) return
  let pwd
  try {
    const { value } = await ElMessageBox.prompt('', '输入管理员密码', {
      inputType: 'password',
      confirmButtonText: '确认',
      cancelButtonText: '取消',
    })
    pwd = value
  } catch { return }

  try {
    const res = await window.api.readSensitiveEnv(pwd)
    if (!res.ok) {
      failedAttempts++
      unlockError.value = failedAttempts >= 3
        ? '密码错误，请等待冷却'
        : `密码错误（${failedAttempts}/3）`
      if (failedAttempts >= 3) startCooldown(30)
      return
    }
    failedAttempts = 0
    unlockError.value = ''
    _sessionPwd = pwd
    Object.assign(sensitiveEnv, res.env)
    sensitiveUnlocked.value = true
  } catch (e) {
    unlockError.value = e.message
  }
}

function startCooldown(s) {
  cooldownLeft.value = s
  clearInterval(cooldownTimer)
  cooldownTimer = setInterval(() => {
    if (--cooldownLeft.value <= 0) {
      clearInterval(cooldownTimer)
      failedAttempts = 0
      unlockError.value = ''
    }
  }, 1000)
}

async function doChangePassword() {
  let oldPwd, newPwd, confirmPwd
  try {
    oldPwd     = (await ElMessageBox.prompt('', '当前密码',     { inputType: 'password', confirmButtonText: '下一步', cancelButtonText: '取消' })).value
    newPwd     = (await ElMessageBox.prompt('', '新密码（≥4位）', { inputType: 'password', confirmButtonText: '下一步', cancelButtonText: '取消' })).value
    confirmPwd = (await ElMessageBox.prompt('', '确认新密码',   { inputType: 'password', confirmButtonText: '确认', cancelButtonText: '取消' })).value
  } catch { return }
  if (newPwd !== confirmPwd)  { ElMessage.error('两次密码不一致'); return }
  if (newPwd.length < 4)      { ElMessage.error('密码至少 4 位'); return }
  try {
    const res = await window.api.adminChangePassword(oldPwd, newPwd)
    if (!res.ok) { ElMessage.error(res.error || '修改失败'); return }
    ElMessage.success('密码已修改')
  } catch (e) { ElMessage.error(e.message) }
}

async function saveSensitiveEnv() {
  if (!window.api) return
  savingSensitive.value = true
  try {
    const res = await window.api.writeSensitiveEnv(_sessionPwd, { ...sensitiveEnv })
    if (!res.ok) { ElMessage.error(res.error || '保存失败'); return }
    sensitiveSavedOk.value = true
    lockSensitive()
    await triggerRestart()
    setTimeout(() => { sensitiveSavedOk.value = false }, 4000)
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    savingSensitive.value = false
  }
}

function lockSensitive() {
  sensitiveUnlocked.value = false
  _sessionPwd = ''
  for (const k of cruiseSensitiveKeys) sensitiveEnv[k] = ''
  for (const k of barrageSensitiveKeys) sensitiveEnv[k] = ''
}

// ── 过渡音频 ─────────────────────────────────────────────────────────────────
const transitConfig  = reactive({ enabled: false, type: 'tts', text: '', mp3_file: '' })
const savingTransit  = ref(false)
const transitSavedOk = ref(false)

function loadTransitConfig() {
  const ws = props.wsRef
  if (!ws || ws.readyState !== WebSocket.OPEN) return

  const handler = (event) => {
    try {
      const msg = JSON.parse(event.data)
      if (msg.type === 'TRANSIT_CONFIG') {
        Object.assign(transitConfig, msg.data)
        ws.removeEventListener('message', handler)
      }
    } catch { /* ignore */ }
  }
  ws.addEventListener('message', handler)
  ws.send(JSON.stringify({ type: 'GET_TRANSIT_CONFIG' }))
  // Auto-cleanup after 5s in case no response
  setTimeout(() => ws.removeEventListener('message', handler), 5000)
}

async function pickTransitMp3() {
  const filePath = await window.api.selectMp3File()
  if (filePath) transitConfig.mp3_file = filePath
}

async function saveTransitConfig() {
  const ws = props.wsRef
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    ElMessage.error('未连接后端')
    return
  }
  savingTransit.value = true
  ws.send(JSON.stringify({ type: 'SET_TRANSIT_CONFIG', data: { ...transitConfig } }))
  transitSavedOk.value = true
  setTimeout(() => { transitSavedOk.value = false }, 3000)
  savingTransit.value = false
}

// ── Lifecycle ──────────────────────────────────────────────────────────────────
onMounted(() => {
  loadBannedWords()
  loadPrompt()
  loadPublicEnv()
  loadHasPassword()
  loadTransitConfig()
})

onBeforeUnmount(() => {
  lockSensitive()
  clearInterval(cooldownTimer)
})
</script>

<style scoped>
/* ── Shell ── */
.settings-shell {
  display: flex;
  height: 100%;
  overflow: hidden;
}

/* ── Left nav ── */
.settings-nav {
  width: 148px;
  min-width: 148px;
  border-right: 1px solid var(--border);
  padding: 12px 0;
  background: var(--bg2);
}
.nav-item {
  padding: 9px 16px;
  font-size: 13px;
  color: var(--text-dim);
  cursor: pointer;
  border-left: 2px solid transparent;
  transition: all .12s;
  user-select: none;
}
.nav-item:hover { color: var(--text); background: var(--bg3); }
.nav-item.active {
  color: var(--text);
  background: var(--bg3);
  border-left-color: var(--cyan);
}

/* ── Right panel ── */
.settings-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.panel-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 11px 20px;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: .05em;
  border-bottom: 1px solid var(--border);
  background: var(--bg2);
  flex-shrink: 0;
}
.panel-body {
  padding: 20px;
  overflow-y: auto;
  flex: 1;
}
.panel-body--stretch {
  display: flex;
  flex-direction: column;
}
.panel-body--stretch .prompt-textarea {
  flex: 1;
  min-height: 0;
}
.panel-note {
  margin-top: 12px;
  font-size: 11px;
  color: var(--text-dim);
}
.param-hint {
  margin-top: 4px;
  font-size: 11px;
  color: var(--text-dim);
}
.mp3-row { display: flex; gap: 8px; align-items: center; }

/* ── Lock chip ── */
.lock-chip {
  margin-left: 8px;
  font-size: 11px;
  font-weight: 400;
  padding: 2px 8px;
  border-radius: 10px;
  background: rgba(248,113,113,.12);
  color: var(--red);
  border: 1px solid rgba(248,113,113,.25);
  letter-spacing: 0;
}
.lock-chip.unlocked {
  background: rgba(74,222,128,.1);
  color: var(--green);
  border-color: rgba(74,222,128,.25);
}

/* ── Banned words ── */
.word-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-height: 28px;
  margin-bottom: 14px;
}
.hint { font-size: 12px; color: var(--text-dim); align-self: center; }

/* ── Prompt textarea ── */
.prompt-textarea :deep(.el-textarea__inner) {
  font-family: var(--font-mono) !important;
  font-size: 12px !important;
  height: 100% !important;
  resize: none !important;
}

/* ── Params grid ── */
.params-grid {
  display: grid;
  grid-template-columns: 160px 1fr;
  gap: 10px 12px;
  align-items: center;
  max-width: 500px;
}
.param-label {
  font-size: 12px;
  color: var(--text-dim);
  text-align: right;
}

/* ── Key form ── */
.key-form {
  display: grid;
  grid-template-columns: 160px 1fr;
  gap: 10px 12px;
  align-items: center;
  max-width: 560px;
}
.key-name-label {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--amber);
  text-align: right;
}

/* ── Masked rows ── */
.masked-rows { display: flex; flex-direction: column; gap: 4px; }
.masked-row {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 7px 10px;
  background: var(--bg3);
  border-radius: 4px;
  border: 1px solid var(--border);
}
.key-name {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--amber);
  min-width: 180px;
}
.key-mask {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-dim);
  letter-spacing: 3px;
}

/* ── Shared ── */
.row-actions { display: flex; align-items: center; gap: 8px; }
.ok-text  { font-size: 12px; color: var(--green); }
.err-text { font-size: 12px; color: var(--red); }
</style>
