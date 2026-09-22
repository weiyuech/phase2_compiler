<template>
  <div class="app-shell">
    <!-- Header bar -->
    <header class="topbar">
      <div class="topbar-left">
        <span class="logo-icon">◈</span>
        <span class="logo-text">机器人直播控制台</span>
      </div>
      <div class="topbar-center">
        <span class="ws-dot" :class="wsStatus" />
        <span class="ws-label" :title="wsDetail">{{ wsLabel }}</span>
        <!-- Playback/configuration failures also need diagnostics while connected. -->
        <button
          class="ws-log-btn"
          title="把排障需要的信息导出成一个文件，发给技术支持"
          @click="exportDiagnostics"
        >导出诊断日志</button>
      </div>
      <div class="topbar-right">
        <span class="clock">{{ clock }}</span>
      </div>
    </header>

    <!-- Tab nav -->
    <nav class="tab-nav">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        class="tab-btn"
        :class="{ active: activeTab === tab.key }"
        @click="activeTab = tab.key"
      >
        <span v-if="tab.icon" class="tab-icon">{{ tab.icon }}</span>
        {{ tab.label }}
      </button>
    </nav>

    <!-- Panel area -->
    <main class="panel-area">
      <LiveMonitor     v-show="activeTab === 'monitor'"   :ws-ref="ws" />
      <Controls        v-show="activeTab === 'controls'" :ws-ref="ws" />
      <PointEditor     v-show="activeTab === 'points'"   :ws-ref="ws" />
      <KnowledgeEditor v-show="activeTab === 'knowledge'" :ws-ref="ws" />
      <BarrageEditor   v-show="activeTab === 'barrage'"   :ws-ref="ws" />
      <TtsCacheLibrary v-show="activeTab === 'ttsCache'"  :ws-ref="ws" />
      <SystemSettings  v-show="activeTab === 'settings'" :ws-ref="ws" />
    </main>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { ElMessage } from 'element-plus'
import LiveMonitor     from './components/LiveMonitor.vue'
import Controls        from './components/Controls.vue'
import PointEditor     from './components/PointEditor.vue'
import KnowledgeEditor from './components/KnowledgeEditor.vue'
import BarrageEditor   from './components/BarrageEditor.vue'
import TtsCacheLibrary from './components/TtsCacheLibrary.vue'
import SystemSettings  from './components/SystemSettings.vue'

const tabs = [
  { key: 'monitor',   label: '实时监控', icon: '▣' },
  { key: 'controls',  label: '播报控制', icon: '◎' },
  { key: 'points',    label: '点位编辑', icon: '◈' },
  { key: 'knowledge', label: '知识库',   icon: '◧' },
  { key: 'barrage',   label: '弹幕回复', icon: '▤' },
  { key: 'ttsCache',  label: '语音下载库' },
  { key: 'settings',  label: '系统设置', icon: '⚙' },
]
const activeTab = ref('monitor')

// Clock
const clock = ref('')
let clockTimer
function updateClock() {
  clock.value = new Date().toLocaleTimeString('zh-CN', { hour12: false })
}

// WebSocket — connect to your existing Node.js backend
// 用 127.0.0.1 而不是 localhost：后端只监听回环 IPv4，
// 而 localhost 在部分 Windows 机器上会先解析成 ::1（IPv6），
// 那样首次连接会失败、只能靠浏览器回退。写死 IPv4 就没有这个不确定性。
//
// 端口不写死：后端首选 3001，被占用时会改用系统分配的空闲端口，
// 并把真实端口交给主进程。每次连接前都重新问一次（重启后端可能会换端口）。
const DEFAULT_PORT = 3001
let _isDev = null      // 只问一次：开发模式下后端是手动 npm start 起的

async function resolveWsUrl() {
  try {
    const p = await window.api?.getUiPort?.()
    if (Number.isInteger(p) && p > 0) return `ws://127.0.0.1:${p}`
  } catch { /* 忽略，下面按未知端口处理 */ }

  // 端口还不知道。开发模式固定 3001；打包模式下端口由后端自己选，
  // 这时候贸然去连 3001 很危险：占用它的可能是别的程序，
  // 那种程序会接受 TCP 连接却不说 WebSocket，握手就一直卡着不返回。
  if (_isDev === null) {
    try { _isDev = (await window.api?.getBackendStatus?.())?.dev === true }
    catch { _isDev = true }
  }
  if (_isDev || !window.api?.getUiPort) return `ws://127.0.0.1:${DEFAULT_PORT}`
  return null      // 打包模式：等后端把端口报上来再连
}
const ws = ref(null)
const wsStatus = ref('disconnected') // 'connected' | 'disconnected' | 'error'
const wsLabel = ref('未连接')
const wsDetail = ref('')             // 后端崩溃时的 stderr 摘要，鼠标悬停可见
const wsEverFailed = ref(false)      // 连过一次失败才显示"导出诊断日志"，正常启动时不闪
let wsTimer
// 正在连接中/已连接的那个 socket 及其目标端口。
// 只用 ws.value 判断是不够的：它要等 onopen 才赋值，
// 握手期间 ws.value 还是 null，这时收到端口通知就会再开一条，
// 结果两条都连上了（run #42 的日志里 界面已连接 出现了两次）。
let activeSocket = null
let activePort   = null

async function exportDiagnostics() {
  const res = await window.api?.exportDiagnostics?.()
  if (res?.ok) {
    ElMessage.success({
      message: `诊断日志已保存到桌面，请把这个文件发给技术支持：\n${res.path}`,
      duration: 8000
    })
  } else if (res?.error && res.error !== '已取消') {
    ElMessage.error(`导出失败: ${res.error}`)
  }
}

function showBackendFailure({ code, stderr }) {
  console.error('[Backend] exited with code', code, '\n', stderr)
  wsStatus.value     = 'error'
  wsEverFailed.value = true
  // code 为空 = 进程根本没起来（fork 就失败了），不能显示成 "code undefined"。
  // 注意：端口被占用现在会自动换端口，不再以退出码 3 结束；
  // 3 只剩下"通道启动失败"这一类（权限、地址不可用等），别再写成端口占用。
  wsLabel.value = code == null
    ? '后端未能启动'
    : code === 3
      ? '后端启动失败：控制台通道无法监听'
      : `后端进程已退出 (code ${code})`
  wsDetail.value = stderr || '（无错误输出，详见 backend.log）'
}

function scheduleReconnect(delay = 5000) {
  clearTimeout(wsTimer)
  wsTimer = setTimeout(connectWS, delay)
}

async function connectWS() {
  clearTimeout(wsTimer)
  try {
    const url = await resolveWsUrl()
    if (!url) {          // 端口还没报上来，稍后再试（不去猜 3001）
      scheduleReconnect(1000)
      return
    }

    // 同一时间只保留一条连接：新建之前先丢掉上一条（可能还在握手中）
    if (activeSocket) { try { activeSocket.close() } catch {} }

    const socket = new WebSocket(url)
    const thisPort = Number(new URL(url).port)
    activeSocket = socket
    activePort   = thisPort
    let settled = false

    // 握手超时。连到一个"只接 TCP、不说 WebSocket"的程序时，
    // onopen / onclose / onerror 一个都不会触发，socket 就永远停在 CONNECTING，
    // 重连定时器也永远排不上——界面会一直停在"未连接"。
    const handshakeTimer = setTimeout(() => {
      if (settled) return
      settled = true
      try { socket.close() } catch {}
      if (activeSocket === socket) { activeSocket = null; activePort = null }
      wsEverFailed.value = true
      if (!wsDetail.value) {
        wsStatus.value = 'error'
        wsLabel.value = '连接超时 — 重试中'
      }
      scheduleReconnect(2000)
    }, 6000)

    socket.onopen = () => {
      settled = true
      clearTimeout(handshakeTimer)
      console.log('[WebSocket] Connected on port', thisPort)
      ws.value = socket
      wsStatus.value = 'connected'
      wsLabel.value = '已连接到后端'
      wsDetail.value = ''
      wsEverFailed.value = false
    }

    socket.addEventListener('message', (e) => {
      try {
        const { type, data } = JSON.parse(e.data)
        if (type === 'ERROR' && data?.message) {
          ElMessage.error({ message: data.message, duration: 8000, showClose: true })
        }
      } catch { /* Ignore non-JSON frames. */ }
    })

    socket.onclose = () => {
      clearTimeout(handshakeTimer)
      if (settled && !ws.value) return     // 超时分支已经安排过重连了
      settled = true
      wsEverFailed.value = true
      // 后端崩溃的具体原因优先保留：重连每 5s 触发一次 onclose，
      // 不加这个判断的话"端口被占用"几秒钟就被通用文案覆盖掉了
      if (!wsDetail.value) {
        wsStatus.value = 'disconnected'
        wsLabel.value = '未连接 — 5s后重试'
      }
      ws.value = null
      if (activeSocket === socket) { activeSocket = null; activePort = null }
      scheduleReconnect(5000)
    }
    socket.onerror = () => {
      wsEverFailed.value = true
      if (!wsDetail.value) {
        wsStatus.value = 'error'
        wsLabel.value = '连接错误'
      }
    }
  } catch {
    wsEverFailed.value = true
    if (!wsDetail.value) wsStatus.value = 'error'
    scheduleReconnect(5000)
  }
}

onMounted(() => {
  updateClock()
  clockTimer = setInterval(updateClock, 1000)
  connectWS()

  // 后端一报出真实端口就立刻（重）连，不用等 5 秒的重试节奏。
  // 后端重启换端口时也是靠这条消息把界面带过去。
  window.api?.onUiPort?.((port) => {
    // 已经连着（或正在连）这个端口就什么都不用做。
    // 必须连"正在握手"的情况也算上，否则启动时会开出第二条连接。
    if (activePort === port) return
    console.log('[WebSocket] backend reported port', port)
    if (ws.value) { try { ws.value.close() } catch {} }
    connectWS()
  })

  // 后端进程退出 → 直接把原因显示出来，而不是让用户对着"未连接"猜
  window.api?.onBackendExit?.(showBackendFailure)

  // 后端可能在窗口出现之前就崩溃了（比如端口被占用），那条消息发不到这里，主动补问一次
  window.api?.getBackendStatus?.().then(status => {
    if (status && !status.running) showBackendFailure(status)
  })
})

onUnmounted(() => {
  clearInterval(clockTimer)
  clearTimeout(wsTimer)
  ws.value?.close()
})
</script>

<style>
/* ── Reset & base ── */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --bg:        #0d1117;
  --bg2:       #161b22;
  --bg3:       #21262d;
  --border:    #30363d;
  --amber:     #f59e0b;
  --amber-dim: #92600a;
  --cyan:      #22d3ee;
  --red:       #f87171;
  --green:     #4ade80;
  --text:      #e6edf3;
  --text-dim:  #8b949e;
  --font-body: 'Noto Sans SC', sans-serif;
  --font-mono: 'JetBrains Mono', monospace;
}

html, body, #app { height: 100%; background: var(--bg); color: var(--text); font-family: var(--font-body); }

/* Element Plus dark overrides */
.el-input__wrapper, .el-textarea__inner {
  background: var(--bg3) !important;
  box-shadow: 0 0 0 1px var(--border) inset !important;
  color: var(--text) !important;
}
.el-input__inner, .el-textarea__inner { color: var(--text) !important; }
.el-button--primary { background: var(--amber) !important; border-color: var(--amber) !important; color: #000 !important; font-weight: 600; }
.el-button--danger  { background: var(--red) !important; border-color: var(--red) !important; color: #000 !important; font-weight: 600; }
.el-table { background: var(--bg2) !important; color: var(--text) !important; }
.el-table th, .el-table tr, .el-table td { background: transparent !important; border-color: var(--border) !important; color: var(--text) !important; }
.el-table__header th { color: var(--amber) !important; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; }
.el-table__row:hover td { background: var(--bg3) !important; }
.el-form-item__label { color: var(--text-dim) !important; font-size: 12px; letter-spacing: .06em; }
.el-tag { font-family: var(--font-mono); font-size: 12px; }
.el-slider__bar { background: var(--amber) !important; }
.el-slider__button { border-color: var(--amber) !important; }
.el-slider__runway { background: var(--border) !important; }
.el-select-dropdown { background: var(--bg3) !important; border-color: var(--border) !important; }
.el-select-dropdown__item { color: var(--text) !important; }
.el-select-dropdown__item.hover, .el-select-dropdown__item:hover { background: var(--bg2) !important; }
.el-scrollbar__bar { background: var(--border) !important; }
</style>

<style scoped>
.app-shell { display: flex; flex-direction: column; height: 100vh; overflow: hidden; }

.topbar {
  display: flex; align-items: center; justify-content: space-between;
  padding: 0 20px; height: 48px; min-height: 48px;
  background: var(--bg2); border-bottom: 1px solid var(--border);
}
.topbar-left  { display: flex; align-items: center; gap: 10px; }
.logo-icon    { color: var(--amber); font-size: 18px; }
.logo-text    { font-weight: 700; font-size: 14px; letter-spacing: .08em; color: var(--text); }
.topbar-center { display: flex; align-items: center; gap: 8px; }
.ws-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--text-dim);
  transition: background .3s;
}
.ws-dot.connected    { background: var(--green); box-shadow: 0 0 6px var(--green); }
.ws-dot.disconnected { background: var(--text-dim); }
.ws-dot.error        { background: var(--red); box-shadow: 0 0 6px var(--red); }
.ws-label { font-size: 12px; color: var(--text-dim); font-family: var(--font-mono); }
.ws-log-btn {
  margin-left: 8px; padding: 1px 6px;
  font-size: 11px; font-family: var(--font-mono);
  color: var(--amber); background: transparent;
  border: 1px solid var(--amber-dim); border-radius: 3px; cursor: pointer;
}
.ws-log-btn:hover { background: var(--bg3); }
.clock { font-family: var(--font-mono); font-size: 13px; color: var(--amber); letter-spacing: .1em; }

.tab-nav {
  display: flex; gap: 0;
  background: var(--bg2); border-bottom: 1px solid var(--border);
  padding: 0 12px;
}
.tab-btn {
  display: flex; align-items: center; gap: 6px;
  padding: 10px 18px; background: none; border: none; border-bottom: 2px solid transparent;
  color: var(--text-dim); font-family: var(--font-body); font-size: 13px; cursor: pointer;
  transition: all .15s; white-space: nowrap;
}
.tab-btn:hover { color: var(--text); }
.tab-btn.active { color: var(--amber); border-bottom-color: var(--amber); }
.tab-icon { font-size: 14px; }

.panel-area { flex: 1; overflow: hidden; }
</style>
