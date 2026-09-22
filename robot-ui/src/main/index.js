import { app, BrowserWindow, WebContentsView, ipcMain, Menu, Tray, nativeImage } from 'electron'
import { join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { createMachineRuntime } from './machine-runtime.js'
import { ShellState } from './shell-state.mjs'
import { machineProfile } from '../../../src/packaging/machine-profile.js'

const PROJECT_ROOT = app.isPackaged ? join(process.resourcesPath, 'backend') : resolve(__dirname, '../../../')
const DEVTOOLS_ENABLED = !app.isPackaged || process.env.ROBOT_DEVTOOLS === '1'
// Optional development fixture; normal launches retain the existing Machine 1 data.
const devProfile = !app.isPackaged && process.env.MIAOFEI_DEV_PROFILE
if (devProfile) app.setPath('userData', resolve(devProfile, 'electron'))
const state = new ShellState()
const machines = new Map()
const senders = new Map()
const registered = new Set()
let _win = null
let _tray = null

function loadPage(contents, hash) {
  const renderer = process.env.ELECTRON_RENDERER_URL
  if (renderer) return contents.loadURL(`${renderer}#${hash}`)
  return contents.loadFile(join(__dirname, '../renderer/index.html'), { hash })
}

function bindSender(contents, runtime, allowed = null) {
  senders.set(contents.id, { runtime, allowed })
  contents.once('destroyed', () => senders.delete(contents.id))
  for (const channel of runtime.handlers.keys()) {
    if (registered.has(channel)) continue
    registered.add(channel)
    ipcMain.handle(channel, (event, ...args) => {
      const entry = senders.get(event.sender.id)
      if (!entry || event.senderFrame !== event.sender.mainFrame || (entry.allowed && !entry.allowed.has(channel))) {
        throw new Error('该页面无权操作此工作区')
      }
      return entry.runtime.handlers.get(channel)(event, ...args)
    })
  }
}

function layoutMachines() {
  if (!_win || _win.isDestroyed()) return
  const [width, height] = _win.getContentSize()
  for (const [id, machine] of machines) {
    machine.view.setBounds(state.bounds(width, height, id))
    machine.view.setVisible(state.visibleMachines.includes(id))
  }
}

function publishState({ focus = false } = {}) {
  layoutMachines()
  if (_win && !_win.isDestroyed()) _win.webContents.send('shell-state', state.snapshot())
  if (focus && state.entered) machines.get(state.activeMachine)?.view.webContents.focus()
  return state.snapshot()
}

function shellHandler(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    if (event.sender !== _win?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('Invalid shell request')
    return handler(event, ...args)
  })
}

shellHandler('shell-get-state', () => state.snapshot())
shellHandler('shell-enter', () => { state.enter(); return publishState({ focus: true }) })
shellHandler('shell-toggle-tabs', () => { state.toggle(); return publishState() })
shellHandler('shell-set-layout', (_event, layout) => { state.setLayout(layout); return publishState({ focus: true }) })
shellHandler('shell-select-pane', (_event, pane, id) => { state.selectPane(pane, id); return publishState({ focus: true }) })
ipcMain.handle('shell-select-machine', (event, id) => {
  if (event.sender !== _win?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('Invalid shell request')
  state.select(id)
  return publishState({ focus: true })
})

function attachShortcut(contents) {
  contents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && (input.control || input.meta) && input.shift && input.key.toLowerCase() === 'm' && state.entered) {
      event.preventDefault()
      state.toggle()
      publishState()
      _win.webContents.focus()
    }
  })
}

function createWindow() {
  _win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 900, minHeight: 600,
    title: '喵飞直播控制系统', backgroundColor: '#0d1117',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'), contextIsolation: true,
      nodeIntegration: false, devTools: DEVTOOLS_ENABLED,
    },
  })
  _win.on('close', event => {
    if (!app.isQuitting) { event.preventDefault(); _win.hide() }
  })
  _win.on('resize', layoutMachines)
  attachShortcut(_win.webContents)
  loadPage(_win.webContents, '/shell')

  for (const id of [1, 2, 3]) {
    const profile = machineProfile({
      id, packaged: app.isPackaged || Boolean(devProfile), projectRoot: PROJECT_ROOT,
      userDataDir: devProfile ? resolve(devProfile) : app.getPath('userData'),
    })
    const view = new WebContentsView({ webPreferences: {
      preload: join(__dirname, '../preload/index.js'), contextIsolation: true,
      nodeIntegration: false, devTools: DEVTOOLS_ENABLED,
      backgroundThrottling: false,
      ...(profile.partition ? { partition: profile.partition } : {}),
    } })
    view.setBackgroundColor('#0d1117')
    _win.contentView.addChildView(view)
    view.setVisible(false)
    let runtime
    runtime = createMachineRuntime({
      profile, projectRoot: PROJECT_ROOT, view, ownerWindow: _win,
      registerOverlay: contents => bindSender(contents, runtime, new Set(['close-barrage-overlay'])),
    })
    machines.set(id, { view, runtime })
    bindSender(view.webContents, runtime)
    attachShortcut(view.webContents)
    view.webContents.on('focus', () => {
      if (state.visibleMachines.includes(id) && state.activeMachine !== id) {
        state.select(id)
        publishState()
      }
    })
    // A navigation cannot turn a machine's privileged renderer into a remote page.
    view.webContents.on('will-navigate', event => event.preventDefault())
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    view.webContents.on('render-process-gone', (_event, details) => {
      console.error(`[machine ${id}] renderer exited: ${details.reason}`)
    })
    runtime.start()
    loadPage(view.webContents, `/machine/${id}`)
  }
  layoutMachines()
}

function showMainWindow() {
  if (!_win || _win.isDestroyed()) return
  if (_win.isMinimized()) _win.restore()
  _win.show()
  _win.focus()
}

function createTray() {
  const iconPath = app.isPackaged ? join(process.resourcesPath, 'tray-icon.png') : join(__dirname, '../../build/tray-icon.png')
  const icon = existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty()
  if (process.platform === 'darwin') icon.setTemplateImage(true)
  _tray = new Tray(icon)
  _tray.setToolTip('喵飞直播控制系统')
  _tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示界面', click: showMainWindow },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]))
  _tray.on('click', showMainWindow)
}

function applyProductionMenu() {
  if (DEVTOOLS_ENABLED) return
  Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([
    { role: 'appMenu' },
    { label: '编辑', submenu: [
      { role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' },
      { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' },
      { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' },
    ] },
  ]) : null)
}

const isPrimary = app.requestSingleInstanceLock()
if (!isPrimary) app.quit()
app.on('second-instance', showMainWindow)
app.whenReady().then(() => {
  if (!isPrimary) return
  applyProductionMenu()
  createWindow()
  createTray()
  app.on('activate', showMainWindow)
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', () => {
  app.isQuitting = true
  for (const { runtime, view } of machines.values()) {
    runtime.dispose()
    if (!view.webContents.isDestroyed()) view.webContents.close()
  }
})
