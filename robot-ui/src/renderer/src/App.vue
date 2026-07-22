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
        <span class="ws-label">{{ wsLabel }}</span>
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
const WS_URL = 'ws://localhost:3001'
const ws = ref(null)
const wsStatus = ref('disconnected') // 'connected' | 'disconnected' | 'error'
const wsLabel = ref('未连接')
let wsTimer

function connectWS() {
  try {
    const socket = new WebSocket(WS_URL)
    socket.onopen = () => {
      console.log('[WebSocket] Connected')
      ws.value = socket
      wsStatus.value = 'connected'
      wsLabel.value = '已连接到后端'
    }
    
    socket.addEventListener('message', (e) => {
      // Logic handled in child components via props/events
    })

    socket.onclose = () => {
      wsStatus.value = 'disconnected'
      wsLabel.value = '未连接 — 5s后重试'
      ws.value = null
      wsTimer = setTimeout(connectWS, 5000)
    }
    socket.onerror = () => {
      wsStatus.value = 'error'
      wsLabel.value = '连接错误'
    }
  } catch {
    wsStatus.value = 'error'
    wsTimer = setTimeout(connectWS, 5000)
  }
}

onMounted(() => {
  updateClock()
  clockTimer = setInterval(updateClock, 1000)
  connectWS()
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
