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
        <!-- 连接失败过就一直显示：用户报障时我们让他点这个按钮 -->
        <button
          v-if="wsEverFailed && wsStatus !== 'connected'"
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
async function resolveWsUrl() {
  let port = DEFAULT_PORT
  try {
    const p = await window.api?.getUiPort?.()
    if (Number.isInteger(p) && p > 0) port = p
  } catch { /* 拿不到就用默认端口（开发模式） */ }
  return `ws://127.0.0.1:${port}`
}
const ws = ref(null)
const wsStatus = ref('disconnected') // 'connected' | 'disconnected' | 'error'
const wsLabel = ref('未连接')
const wsDetail = ref('')             // 后端崩溃时的 stderr 摘要，鼠标悬停可见
const wsEverFailed = ref(false)      // 连过一次失败才显示"导出诊断日志"，正常启动时不闪
let wsTimer

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
  // 端口占用是最常见的一种，后端会以退出码 3 结束，这里给出可操作的提示。
  // code 为空 = 进程根本没起来（fork 就失败了），不能显示成 "code undefined"
  wsLabel.value = code == null
    ? '后端未能启动'
    : code === 3
      ? '后端启动失败：端口 3001 被占用'
      : `后端进程已退出 (code ${code})`
  wsDetail.value = stderr || '（无错误输出，详见 backend.log）'
}

async function connectWS() {
  try {
    const socket = new WebSocket(await resolveWsUrl())
    socket.onopen = () => {
      console.log('[WebSocket] Connected')
      ws.value = socket
      wsStatus.value = 'connected'
      wsLabel.value = '已连接到后端'
      wsDetail.value = ''
      wsEverFailed.value = false
    }
    
    socket.addEventListener('message', (e) => {
      // Logic handled in child components via props/events
    })

    socket.onclose = () => {
      wsEverFailed.value = true
      // 后端崩溃的具体原因优先保留：重连每 5s 触发一次 onclose，
      // 不加这个判断的话"端口被占用"几秒钟就被通用文案覆盖掉了
      if (!wsDetail.value) {
        wsStatus.value = 'disconnected'
        wsLabel.value = '未连接 — 5s后重试'
      }
      ws.value = null
      wsTimer = setTimeout(connectWS, 5000)
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
    wsTimer = setTimeout(connectWS, 5000)
  }
}

onMounted(() => {
  updateClock()
  clockTimer = setInterval(updateClock, 1000)
  connectWS()

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
