<template>
  <div class="machine-shell" :class="{ 'is-collapsed': shell.collapsed }">
    <button v-if="!shell.entered" class="welcome" :class="{ 'is-leaving': leaving }"
      aria-label="欢迎来到喵飞直播控制系统，点击任意位置进入机器 1" :disabled="leaving" @click="enter">
      <img class="welcome-art" :src="welcomeArt" alt="欢迎来到喵飞 直播控制系统" draggable="false" fetchpriority="high" />
      <span class="welcome-invitation"><span class="invitation-line"></span>点击任意位置进入<span class="invitation-line"></span></span>
      <span class="welcome-key">ENTER</span>
    </button>
    <header v-else class="machine-bar" :class="{ 'is-mac': isMac }">
      <template v-if="!shell.collapsed">
        <div class="shell-brand"><span class="brand-mark">◈</span><span>喵飞直播</span></div>
        <nav class="machine-tabs" aria-label="机器工作区">
          <button v-for="id in [1, 2, 3]" :key="id" class="machine-tab" :class="{ active: shell.activeMachine === id, visible: shell.layout === 'split' && shell.panes.includes(id) }"
            :aria-label="`切换到机器 ${id}`" :aria-current="shell.activeMachine === id ? 'page' : undefined" @click="select(id)">
            <span class="machine-number">0{{ id }}</span><span>机器 {{ id }}</span>
          </button>
        </nav>
        <div class="layout-control" aria-label="显示方式">
          <button :class="{ selected: shell.layout === 'single' }" :aria-pressed="shell.layout === 'single'" @click="setLayout('single')">单页</button>
          <button :class="{ selected: shell.layout === 'split' }" :aria-pressed="shell.layout === 'split'" @click="setLayout('split')"><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="1"/><path d="M8 3v10"/></svg>双栏</button>
        </div>
        <button class="collapse-control" aria-label="收起机器切换栏" title="收起切换栏 · Ctrl / ⌘ + Shift + M" @click="toggle">
          <span>收起</span><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 10 4-4 4 4" /></svg>
        </button>
      </template>
      <template v-else>
        <span class="collapsed-brand">喵飞直播</span>
        <button class="reveal-control" aria-label="展开机器切换栏" title="展开切换栏 · Ctrl / ⌘ + Shift + M" @click="toggle">
          <span class="current-machine-dot"></span><strong>{{ shell.layout === 'split' ? `机器 ${shell.panes[0]} / 机器 ${shell.panes[1]}` : `机器 ${shell.activeMachine}` }}</strong>
          <span class="reveal-label">展开切换</span><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
        </button>
      </template>
    </header>
    <div v-if="shell.entered && shell.layout === 'split'" class="pane-bar">
      <label v-for="pane in [0, 1]" :key="pane" class="pane-picker" :class="{ focused: shell.activeMachine === shell.panes[pane] }">
        <span>{{ pane === 0 ? '左侧' : '右侧' }}</span>
        <select :value="shell.panes[pane]" :aria-label="pane === 0 ? '左侧机器' : '右侧机器'" @change="selectPane(pane, Number($event.target.value))">
          <option v-for="id in [1, 2, 3]" :key="id" :value="id">机器 {{ id }}</option>
        </select>
      </label>
    </div>
    <div v-if="shell.entered && !nativeShell" class="browser-note">
      <span>机器 {{ shell.activeMachine }}</span>
      <p>此页面预览机器切换栏。完整机器控制台在桌面应用中打开。</p>
    </div>
    <p v-if="error" class="shell-error" role="alert">{{ error }}</p>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import welcomeArt from './assets/miaofei-welcome.png'
import { ShellState } from '../../main/shell-state.mjs'

const nativeShell = Boolean(window.api?.getShellState)
const isMac = /Mac/.test(navigator.platform)
const previewState = new ShellState()
const shell = ref(previewState.snapshot())
const leaving = ref(false)
const error = ref('')
let unsubscribe
let entryTimer

async function enter() {
  if (leaving.value || shell.value.entered) return
  leaving.value = true
  error.value = ''
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  entryTimer = setTimeout(async () => {
    try {
      shell.value = nativeShell ? await window.api.enterMachines() : previewState.enter()
    } catch (failure) { error.value = failure.message; leaving.value = false }
  }, reducedMotion ? 0 : 420)
}
async function select(id) {
  try { shell.value = nativeShell ? await window.api.selectMachine(id) : previewState.select(id) }
  catch (failure) { error.value = failure.message }
}
async function toggle() {
  try { shell.value = nativeShell ? await window.api.toggleMachineTabs() : previewState.toggle() }
  catch (failure) { error.value = failure.message }
}
async function setLayout(layout) {
  try { shell.value = nativeShell ? await window.api.setMachineLayout(layout) : previewState.setLayout(layout) }
  catch (failure) { error.value = failure.message }
}
async function selectPane(pane, id) {
  try { shell.value = nativeShell ? await window.api.selectMachinePane(pane, id) : previewState.selectPane(pane, id) }
  catch (failure) { error.value = failure.message }
}
function keydown(event) {
  if (!shell.value.entered && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); enter() }
}
onMounted(async () => {
  window.addEventListener('keydown', keydown)
  if (!nativeShell) return
  unsubscribe = window.api.onShellState(state => { shell.value = state })
  try { shell.value = await window.api.getShellState() }
  catch (failure) { error.value = failure.message }
})
onUnmounted(() => {
  clearTimeout(entryTimer)
  unsubscribe?.()
  window.removeEventListener('keydown', keydown)
})
</script>

<style scoped>
.machine-shell { width: 100%; height: 100vh; color: #e6edf3; background: #0d1117; font-family: 'Noto Sans SC', -apple-system, BlinkMacSystemFont, sans-serif; }
button { font: inherit; }
button:focus-visible { outline: 2px solid #f5c777; outline-offset: -4px; }
.welcome { position: absolute; inset: 0; display: block; width: 100%; height: 100%; overflow: hidden; border: 0; background: #0d1117; color: white; cursor: pointer; padding: 0; }
.welcome-art { position: absolute; width: min(100%, 1680px); height: auto; max-height: 100%; object-fit: contain; left: 50%; top: 48%; transform: translate(-50%, -50%); pointer-events: none; user-select: none; }
.welcome-invitation { position: absolute; left: 0; right: 0; bottom: 12%; display: flex; align-items: center; justify-content: center; gap: 20px; color: #bbc0c9; font-size: 14px; font-weight: 400; letter-spacing: .26em; animation: invitation-breathe 4s ease-in-out infinite; }
.invitation-line { width: 34px; height: 1px; background: linear-gradient(90deg, transparent, #657181); }
.invitation-line:last-child { transform: rotate(180deg); }
.welcome-key { position: absolute; bottom: 7%; left: 50%; transform: translateX(-50%); font-size: 9px; letter-spacing: .22em; color: #788391; border: 1px solid #303842; border-radius: 4px; padding: 4px 8px; }
.welcome.is-leaving { animation: welcome-out .42s ease-in forwards; pointer-events: none; }
.welcome.is-leaving .welcome-art { transition: transform .42s ease-in; transform: translate(-50%, -50%) scale(1.025); }
@keyframes invitation-breathe { 0%, 100% { opacity: .62; } 50% { opacity: 1; } }
@keyframes welcome-out { to { opacity: 0; } }
.machine-bar { height: 68px; padding: 0 18px 0 24px; display: flex; align-items: center; gap: 24px; border-bottom: 1px solid #2a3039; background: #0f141c; -webkit-app-region: drag; }
.machine-bar.is-mac { padding-left: 94px; }
.shell-brand { display: flex; align-items: center; gap: 10px; color: #cbd1db; font-size: 13px; letter-spacing: .1em; white-space: nowrap; }
.brand-mark { color: #e9d2ab; font-size: 23px; }
.machine-tabs { align-self: stretch; display: flex; align-items: flex-end; gap: 7px; padding-top: 14px; -webkit-app-region: no-drag; }
.machine-tab { min-width: 132px; height: 44px; display: flex; align-items: center; justify-content: center; gap: 14px; padding: 0 22px; border: 1px solid transparent; border-bottom: none; border-radius: 9px 9px 0 0; background: transparent; color: #8f98a7; font-size: 13px; cursor: pointer; transition: background .16s, color .16s; }
.machine-tab:hover { background: #191f28; color: #e5e8ed; }
.machine-tab.active { background: #20252e; border-color: #343944; color: #f5dfb4; box-shadow: inset 0 2px 0 #d9b26e; }
.machine-tab.visible:not(.active) { background: #171e29; color: #c4cfdf; box-shadow: inset 0 2px 0 #63778e; }
.layout-control { display: flex; padding: 3px; border: 1px solid #2b3542; border-radius: 7px; margin-left: auto; -webkit-app-region: no-drag; }
.layout-control button { display: flex; align-items: center; gap: 5px; padding: 5px 9px; border: 0; border-radius: 4px; background: transparent; color: #8c99aa; font-size: 11px; cursor: pointer; white-space: nowrap; }
.layout-control button.selected { background: #2b3441; color: #e6edf3; }
.pane-bar { height: 36px; display: grid; grid-template-columns: 1fr 1fr; background: #161d28; border-bottom: 1px solid #344053; }
.pane-picker { display: flex; align-items: center; gap: 10px; padding: 0 16px; font-size: 10px; color: #8494a9; border-right: 2px solid #394555; }
.pane-picker:last-child { border-right: 0; }
.pane-picker.focused { background: #1b2330; }
.pane-picker select { color: #d8e1ee; background: #202a38; border: 1px solid #3b485b; padding: 2px 20px 2px 8px; border-radius: 4px; font: inherit; font-size: 11px; cursor: pointer; }
.machine-number { color: #687282; font-size: 10px; font-family: 'JetBrains Mono', monospace; }
.machine-tab.active .machine-number { color: #b69863; }
.collapse-control { display: flex; align-items: center; gap: 8px; color: #949eac; background: transparent; border: 1px solid #2d3540; border-radius: 6px; padding: 6px 9px; cursor: pointer; font-size: 11px; -webkit-app-region: no-drag; }
.collapse-control:hover, .reveal-control:hover { color: #f2dfbd; border-color: #8a734b; background: #24252a; }
svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.6; }
.is-collapsed .machine-bar { height: 40px; justify-content: space-between; }
.collapsed-brand { font-size: 10px; color: #788393; letter-spacing: .15em; }
.reveal-control { display: flex; align-items: center; gap: 9px; background: #1a2029; color: #d5dce6; border: 1px solid #35404e; padding: 4px 10px; border-radius: 5px; cursor: pointer; font-size: 11px; -webkit-app-region: no-drag; }
.reveal-control strong { font-weight: 500; }
.current-machine-dot { width: 5px; height: 5px; border-radius: 50%; background: #d9b26e; }
.reveal-label { color: #9ca7b7; margin-left: 7px; padding-left: 12px; border-left: 1px solid #36404d; }
.shell-error { position: absolute; bottom: 24px; left: 24px; color: #ffafaf; }
.browser-note { padding: 80px 40px; color: #8995a4; text-align: center; }
.browser-note > span { font-size: 24px; color: #e6edf3; }
.browser-note p { margin-top: 16px; font-size: 13px; }
@media (max-width: 1050px) {
  .machine-bar { gap: 14px; }
  .machine-tab { min-width: 104px; gap: 8px; padding: 0 14px; }
  .shell-brand { font-size: 11px; gap: 5px; }
}
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
</style>
