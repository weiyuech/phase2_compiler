import { app, BrowserWindow, ipcMain, dialog, utilityProcess, systemPreferences, Tray, Menu, nativeImage } from 'electron'
import { join, resolve }                        from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, appendFileSync } from 'fs'
import { scryptSync, randomBytes, timingSafeEqual } from 'crypto'

// ─── PROJECT_ROOT ─────────────────────────────────────────────────────────────
// dev:      src/main/ → src/ → robot-ui/ → robot-live-system/  (3 levels up)
// packaged: resources/backend/  (extraResources target)
const PROJECT_ROOT = app.isPackaged
  ? join(process.resourcesPath, 'backend')
  : resolve(__dirname, '../../../')

// ─── PATH helper（packaged app 不继承 shell PATH，手动补充 ffplay 常见位置）────
// PROJECT_ROOT 会被放到 PATH 最前面：Windows 下 ffplay.exe 就在这个目录里，
// 走 PATH 解析也能被 spawn 找到（audio-player 里的解析器是主路径，这里是兜底）
function buildPath() {
  const sep  = process.platform === 'win32' ? ';' : ':'
  const base = process.env.PATH || ''
  const extra =
    process.platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin'] :
    process.platform === 'win32'  ? [PROJECT_ROOT, 'C:\\ffmpeg\\bin', 'C:\\Program Files\\ffmpeg\\bin'] :
    /* linux */                     [PROJECT_ROOT, '/usr/local/bin']
  return [...extra, base].join(sep)
}
// ─── USER_DATA_DIR ────────────────────────────────────────────────────────────
// 运行时可写数据（巡游清单、知识库文件）放此处，避免 Windows 安装目录写权限问题
const USER_DATA_DIR = app.getPath('userData')

// 打包后所有可写文件放 userData，避免 Windows C:\Program Files\ 写权限问题
const CONFIG_DIR = app.isPackaged
  ? join(USER_DATA_DIR, 'config')
  : join(PROJECT_ROOT, 'config')

function seedUserData() {
  // data/ 目录
  const dataSrc = join(PROJECT_ROOT, 'data')
  const dataDst = join(USER_DATA_DIR, 'data')
  if (!existsSync(dataDst) && existsSync(dataSrc)) {
    mkdirSync(dataDst, { recursive: true })
    cpSync(dataSrc, dataDst, { recursive: true })
    console.log('[main] 首次启动，已初始化用户数据目录:', dataDst)
  }
  // .env 配置文件：如果用户数据目录下不存在 .env，则从打包资源中拷贝默认 .env.example
  if (app.isPackaged) {
    const envDst = join(USER_DATA_DIR, '.env')
    if (!existsSync(envDst)) {
      const envSrc = join(PROJECT_ROOT, '.env.example')
      if (existsSync(envSrc)) {
        cpSync(envSrc, envDst)
        console.log('[main] 首次启动，已拷贝默认 .env.example 配置文件至:', envDst)
      }
    }
  }
  // config/ 目录：仅复制初始配置文件（banned-words / llm-prompt），不覆盖用户已有内容
  if (app.isPackaged) {
    mkdirSync(CONFIG_DIR, { recursive: true })
    for (const file of ['banned-words.txt', 'llm-system-prompt.txt', 'barrage-prompt-name.txt', 'barrage-prompt-general.txt']) {
      const dst = join(CONFIG_DIR, file)
      if (!existsSync(dst)) {
        const src = join(PROJECT_ROOT, 'config', file)
        if (existsSync(src)) cpSync(src, dst)
      }
    }
  }
}

const BANNED_WORDS_PATH = join(CONFIG_DIR, 'banned-words.txt')
const LLM_PROMPT_PATH   = join(CONFIG_DIR, 'llm-system-prompt.txt')
const BARRAGE_PROMPT_NAME_PATH = join(CONFIG_DIR, 'barrage-prompt-name.txt')
const BARRAGE_PROMPT_GENERAL_PATH = join(CONFIG_DIR, 'barrage-prompt-general.txt')
const ADMIN_PATH        = join(CONFIG_DIR, 'admin.json')
const ENV_PATH          = app.isPackaged ? join(USER_DATA_DIR, '.env') : join(PROJECT_ROOT, '.env')

const PUBLIC_ENV_KEYS   = [
  'KB_PROVIDER', 'DOUBAO_MODEL', 'DEEPSEEK_MODEL', 'TTS_VOICE_TYPE', 'TTS_CLUSTER',
  'DUCK_VOLUME', 'DUCK_FADE_MS', 'LLM_TIMEOUT_MS', 'ROBOT_PORT', 'ROBOT_URL',
  'DUCK_NOISE_DB', 'DUCK_DURATION', 'BANNED_WORDS_FILE',
  'BARRAGE_DOUBAO_MODEL', 'BARRAGE_DEEPSEEK_MODEL', 'BARRAGE_TTS_VOICE_TYPE', 'BARRAGE_TTS_CLUSTER', 'BARRAGE_LLM_TIMEOUT_MS'
]
const SENSITIVE_ENV_KEYS = [
  'DOUBAO_API_KEY', 'DEEPSEEK_API_KEY', 'QWEN_API_KEY',
  'TTS_APP_ID', 'TTS_ACCESS_TOKEN',
  'NGROK_AUTHTOKEN',
  'BARRAGE_DOUBAO_API_KEY', 'BARRAGE_DEEPSEEK_API_KEY', 'BARRAGE_QWEN_API_KEY',
  'BARRAGE_TTS_APP_ID', 'BARRAGE_TTS_ACCESS_TOKEN'
]

// ─── .env helpers ─────────────────────────────────────────────────────────────

function parseEnv(raw) {
  const result = {}
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq === -1) continue
    const key = t.slice(0, eq).trim()
    const val = t.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '')
    result[key] = val
  }
  return result
}

function writeEnvFields(raw, changes) {
  const lines   = raw.split('\n')
  const written = new Set()

  const updated = lines.map(line => {
    const t = line.trim()
    if (!t || t.startsWith('#')) return line
    const eq = t.indexOf('=')
    if (eq === -1) return line
    const key = t.slice(0, eq).trim()
    if (key in changes) {
      written.add(key)
      return `${key}=${changes[key]}`
    }
    return line
  })

  for (const [key, val] of Object.entries(changes)) {
    if (!written.has(key)) updated.push(`${key}=${val}`)
  }

  return updated.join('\n')
}

// ─── Password helpers ─────────────────────────────────────────────────────────

function hashPassword(pwd) {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(pwd, salt, 32).toString('hex')
  return { hash, salt }
}

function verifyPassword(pwd, hash, salt) {
  try {
    const derived = scryptSync(pwd, salt, 32)
    const stored  = Buffer.from(hash, 'hex')
    return timingSafeEqual(derived, stored)
  } catch {
    return false
  }
}

// ─── Backend auto-start ───────────────────────────────────────────────────────
// In packaged mode the backend runs as a utilityProcess (Electron's built-in Node).
// In dev mode the developer runs `npm start` manually, so we skip auto-start.

let _backendProcess = null
let _tray = null
let _win  = null

function startBackend() {
  if (!app.isPackaged) return   // dev: use `npm start` in a separate terminal

  const entry   = join(PROJECT_ROOT, 'src/index.js')
  const logPath = join(USER_DATA_DIR, 'backend.log')

  // appendFileSync 是同步系统调用，写完立刻落盘，进程崩溃也不会丢数据
  // createWriteStream / writeFileSync 都有内存缓冲，崩溃前来不及 flush 就截断
  const log = (s) => { try { appendFileSync(logPath, String(s)) } catch {} }

  log(`\n=== backend start ${new Date().toISOString()} ===\n`)
  log(`entry: ${entry}\n`)
  log(`PROJECT_ROOT: ${PROJECT_ROOT}\n`)
  log(`USER_DATA_DIR: ${USER_DATA_DIR}\n`)
  log(`entry exists: ${existsSync(entry)}\n`)

  _backendProcess = utilityProcess.fork(entry, [], {
    env: {
      ...process.env,
      PROJECT_ROOT:        PROJECT_ROOT,
      USER_DATA_DIR:       USER_DATA_DIR,
      DOTENV_CONFIG_PATH:  ENV_PATH,
      PATH:                buildPath(),
    },
    cwd: PROJECT_ROOT,
    stdio: 'pipe',
  })
  _backendProcess.stdout?.on('data', d => {
    log('[out] ' + d.toString('utf8'))
  })

  // stderr 全部缓冲，等流真正关闭后再一次性写入
  // 原因：进程崩溃时真正的报错往往在 Electron 初始化输出之后的下一个 chunk，
  // 那个 chunk 还没触发 data 事件进程就退了——缓冲+close 事件才能保证写全
  const stderrChunks = []
  _backendProcess.stderr?.on('data', d => {
    stderrChunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d))
  })
  _backendProcess.stderr?.on('close', () => {
    if (stderrChunks.length) log('[err] ' + Buffer.concat(stderrChunks).toString('utf8') + '\n')
  })

  _backendProcess.on('exit', (code) => {
    log(`[backend] process exited with code ${code}\n`)
    _backendProcess = null
  })
}

// ─── System Tray ──────────────────────────────────────────────────────────────

function showMainWindow() {
  if (_win) {
    if (_win.isMinimized()) _win.restore()
    _win.show()
    _win.focus()
  } else {
    createWindow()
  }
}

function createTray() {
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'tray-icon.png')
    : join(__dirname, '../../build/tray-icon.png')

  // 图标不存在时用空图标兜底——至少保证托盘菜单（退出按钮）可用
  const img = existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createEmpty()
  if (process.platform === 'darwin') img.setTemplateImage(true)  // 自适应深/浅色菜单栏

  _tray = new Tray(img)
  _tray.setToolTip('机器人直播控制台')

  const menu = Menu.buildFromTemplate([
    { label: '显示界面', click: showMainWindow },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ])
  _tray.setContextMenu(menu)

  // Windows / Linux：单击托盘图标直接显示窗口
  _tray.on('click', showMainWindow)
}

// ─── Window ───────────────────────────────────────────────────────────────────

function createWindow() {
  _win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0d1117',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      allowLoadingUnsignedLibraries: true
    }
  })

  // 关窗口时隐藏而非销毁（标准托盘模式）
  // app.isQuitting = true 时（托盘"退出"触发）允许真正关闭
  _win.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault()
      _win.hide()
    }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    _win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    _win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ─── Single instance lock ─────────────────────────────────────────────────────
// 第二个实例启动时，唤起第一个实例的窗口并退出自身（避免两个后端争抢 port 3001）
const _isPrimary = app.requestSingleInstanceLock()
if (!_isPrimary) app.quit()

app.on('second-instance', () => { showMainWindow() })

app.whenReady().then(async () => {
  // 双重保险：即使 whenReady 在 app.quit() 之后意外触发，也不启动后端
  if (!_isPrimary) return

  if (process.platform === 'darwin') {
    await systemPreferences.askForMediaAccess('microphone')
  }
  seedUserData()
  startBackend()
  createTray()
  createWindow()
  app.on('activate', () => {
    // macOS：点击 Dock 图标时恢复窗口
    if (_win) { _win.show(); _win.focus() }
    else createWindow()
  })
})

app.on('window-all-closed', () => {
  // macOS 惯例保持进程运行；Windows/Linux 所有窗口关闭即退出
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  app.isQuitting = true
  _backendProcess?.kill()
})

// ─── IPC: Restart backend ─────────────────────────────────────────────────────
// 保存密钥/运行参数后调用，让后端重新读取 .env 使配置立即生效

ipcMain.handle('restart-backend', () => {
  if (_backendProcess) {
    // 监听 exit 事件，确保旧进程彻底退出后再等待 2000ms 重启，彻底规避 Windows 端口延迟释放(EADDRINUSE)问题
    _backendProcess.once('exit', () => {
      setTimeout(startBackend, 2000)
    })
    _backendProcess.kill()
  } else {
    startBackend()
  }
  return { ok: true }
})

// ─── IPC: Barrage Overlay ─────────────────────────────────────────────────────

const { desktopCapturer } = require('electron')

let _overlayWin = null

ipcMain.handle('get-screen-source-id', async () => {
  const { desktopCapturer } = require('electron')
  // Super fast: width/height 0 means it doesn't waste CPU taking pictures
  const sources = await desktopCapturer.getSources({ 
    types: ['screen'], 
    thumbnailSize: { width: 0, height: 0 } 
  })
  return sources.length ? sources[0].id : null
})

ipcMain.handle('capture-screen-region', async (_, rect) => {
  try {
    // 0. macOS Permission Check
    if (process.platform === 'darwin') {
      const { systemPreferences } = require('electron')
      const status = systemPreferences.getMediaAccessStatus('screen')
      if (status !== 'granted') {
        return { ok: false, error: '请在 macOS 系统设置 -> 隐私与安全性 -> 屏幕录制 中允许本应用访问屏幕。' }
      }
    }

    const { screen } = require('electron')
    const primaryDisplay = screen.getPrimaryDisplay()
    const scaleFactor = primaryDisplay.scaleFactor

    // 1. Get the primary screen source
    const sources = await desktopCapturer.getSources({ 
      types: ['screen'],
      thumbnailSize: { 
        width: Math.round(primaryDisplay.bounds.width * scaleFactor), 
        height: Math.round(primaryDisplay.bounds.height * scaleFactor) 
      }
    })
    
    if (!sources || sources.length === 0) {
      return { ok: false, error: '无法获取屏幕画面。Windows 11 用户请前往 设置 -> 隐私和安全性 -> 屏幕截图和录制，开启"允许桌面应用访问"。' }
    }
    
    const primaryScreen = sources[0]
    
    // 2. DPI Correction: Multiply logical CSS coordinates by Windows Scale Factor (e.g. 1.25, 1.5)
    const physicalRect = {
      x: Math.round(rect.x * scaleFactor),
      y: Math.round(rect.y * scaleFactor),
      width: Math.round(rect.width * scaleFactor),
      height: Math.round(rect.height * scaleFactor)
    }

    // 3. Crop the image to the corrected physical rectangle
    const cropped = primaryScreen.thumbnail.crop(physicalRect)
    
    // 4. Return as a raw PNG buffer
    return { ok: true, buffer: cropped.toPNG() }
  } catch (error) {
    return { ok: false, error: error.message }
  }
})

ipcMain.handle('open-barrage-overlay', () => {
  if (_overlayWin) {
    _overlayWin.show()
    return
  }

  const { screen } = require('electron')
  const primaryDisplay = screen.getPrimaryDisplay()
  const { width, height } = primaryDisplay.bounds
_overlayWin = new BrowserWindow({
  width,
  height,
  x: 0,
  y: 0,
  transparent: true,
  backgroundColor: '#4ade8033', // Exact light green veil color (20% opacity)
  frame: false,
  hasShadow: false,
  alwaysOnTop: true,
  skipTaskbar: true,
  resizable: false,
  movable: false,
  webPreferences: {
    preload: join(__dirname, '../preload/index.js'),
    contextIsolation: true,
    nodeIntegration: false,
    allowLoadingUnsignedLibraries: true
  }
})
  // Load a special route or HTML for the overlay.
  // In dev mode, Vite serves the whole app, we can use a hash route like `#/overlay`
  if (process.env['ELECTRON_RENDERER_URL']) {
    _overlayWin.loadURL(process.env['ELECTRON_RENDERER_URL'] + '#/overlay')
  } else {
    _overlayWin.loadFile(join(__dirname, '../renderer/index.html'), { hash: '/overlay' })
  }

  _overlayWin.on('closed', () => {
    _overlayWin = null
  })
})

ipcMain.handle('close-barrage-overlay', (_, rect) => {
  if (_overlayWin) {
    _overlayWin.close()
    _overlayWin = null
  }
  // If rect is provided, we can broadcast it to the main window or backend
  if (rect && _win) {
    _win.webContents.send('barrage-region-selected', rect)
  }
  return { ok: true }
})

// ─── IPC: File picker ─────────────────────────────────────────────────────────

ipcMain.handle('select-mp3-file', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'm4a'] }]
  })
  if (canceled || filePaths.length === 0) return null
  return filePaths[0]
})

ipcMain.handle('select-json-file', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })
  if (canceled || filePaths.length === 0) return null
  return filePaths[0]
})

ipcMain.handle('select-multiple-mp3-files', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'm4a'] }]
  })
  if (canceled || filePaths.length === 0) return []
  return filePaths
})

ipcMain.handle('export-tts-audio', async (event, hash, defaultFilename) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  const dataDir = app.isPackaged
    ? join(USER_DATA_DIR, 'data')
    : join(PROJECT_ROOT, 'data')
  const srcPath = join(dataDir, 'tts-cache', `${hash}.mp3`)
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: '导出语音文件',
    defaultPath: defaultFilename,
    filters: [{ name: 'Audio Files', extensions: ['mp3'] }]
  })
  if (canceled || !filePath) return false
  try {
    cpSync(srcPath, filePath)
    return true
  } catch (err) {
    console.error('[main] 导出语音文件失败:', err.message)
    throw err
  }
})

ipcMain.handle('select-document-file', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'Document', extensions: ['txt', 'docx'] }]
  })
  if (canceled || filePaths.length === 0) return null
  return filePaths[0]
})

// ─── IPC: Banned words ────────────────────────────────────────────────────────

ipcMain.handle('read-banned-words', () => {
  try {
    const raw   = readFileSync(BANNED_WORDS_PATH, 'utf-8')
    const words = raw.split('\n').map(w => w.trim()).filter(Boolean)
    return { ok: true, words }
  } catch (e) { return { ok: false, error: e.message, words: [] } }
})

ipcMain.handle('write-banned-words', (_, words) => {
  try {
    writeFileSync(BANNED_WORDS_PATH, words.join('\n') + '\n', 'utf-8')
    return { ok: true }
  } catch (e) { return { ok: false, error: e.message } }
})

// ─── IPC: LLM Prompt ──────────────────────────────────────────────────────────

ipcMain.handle('read-llm-prompt', () => {
  try {
    const text = readFileSync(LLM_PROMPT_PATH, 'utf-8')
    return { ok: true, text }
  } catch (e) { return { ok: false, error: e.message, text: '' } }
})

ipcMain.handle('write-llm-prompt', (_, text) => {
  try {
    writeFileSync(LLM_PROMPT_PATH, text, 'utf-8')
    return { ok: true }
  } catch (e) { return { ok: false, error: e.message } }
})

ipcMain.handle('read-barrage-prompt-name', () => {
  try {
    const text = readFileSync(BARRAGE_PROMPT_NAME_PATH, 'utf-8')
    return { ok: true, text }
  } catch (e) { return { ok: false, error: e.message, text: '' } }
})

ipcMain.handle('write-barrage-prompt-name', (_, text) => {
  try {
    writeFileSync(BARRAGE_PROMPT_NAME_PATH, text, 'utf-8')
    return { ok: true }
  } catch (e) { return { ok: false, error: e.message } }
})

ipcMain.handle('read-barrage-prompt-general', () => {
  try {
    const text = readFileSync(BARRAGE_PROMPT_GENERAL_PATH, 'utf-8')
    return { ok: true, text }
  } catch (e) { return { ok: false, error: e.message, text: '' } }
})

ipcMain.handle('write-barrage-prompt-general', (_, text) => {
  try {
    writeFileSync(BARRAGE_PROMPT_GENERAL_PATH, text, 'utf-8')
    return { ok: true }
  } catch (e) { return { ok: false, error: e.message } }
})

ipcMain.handle('download-barrage-log', async () => {
  const dataDir = app.isPackaged
    ? join(USER_DATA_DIR, 'data')
    : join(PROJECT_ROOT, 'data')
  const logPath = join(dataDir, 'barrage-ocr-log.txt')
  if (!existsSync(logPath)) {
    return { ok: false, error: '暂无识别日志数据，请先开启弹幕识别进行记录' }
  }

  const { filePath } = await dialog.showSaveDialog({
    title: '下载弹幕识别日志',
    defaultPath: 'barrage-ocr-log.txt',
    filters: [{ name: 'Text Files', extensions: ['txt'] }]
  })

  if (filePath) {
    try {
      cpSync(logPath, filePath)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  }
  return { ok: false, error: '用户取消下载' }
})

// ─── IPC: Admin password ──────────────────────────────────────────────────────

ipcMain.handle('admin-has-password', () => {
  return existsSync(ADMIN_PATH)
})

ipcMain.handle('admin-set-password', (_, newPwd) => {
  try {
    const creds = hashPassword(newPwd)
    writeFileSync(ADMIN_PATH, JSON.stringify(creds), 'utf-8')
    return { ok: true }
  } catch (e) { return { ok: false, error: e.message } }
})

ipcMain.handle('admin-change-password', (_, oldPwd, newPwd) => {
  try {
    if (!existsSync(ADMIN_PATH)) return { ok: false, error: '未设置密码' }
    const { hash, salt } = JSON.parse(readFileSync(ADMIN_PATH, 'utf-8'))
    if (!verifyPassword(oldPwd, hash, salt)) return { ok: false, error: '旧密码错误' }
    writeFileSync(ADMIN_PATH, JSON.stringify(hashPassword(newPwd)), 'utf-8')
    return { ok: true }
  } catch (e) { return { ok: false, error: e.message } }
})

// ─── IPC: Public .env params (no password) ───────────────────────────────────

ipcMain.handle('read-public-env', () => {
  try {
    const raw = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf-8') : ''
    const all = parseEnv(raw)
    const env = {}
    for (const key of PUBLIC_ENV_KEYS) env[key] = all[key] ?? ''
    return { ok: true, env }
  } catch (e) { return { ok: false, error: e.message, env: {} } }
})

ipcMain.handle('write-public-env', (_, changes) => {
  try {
    const safe = {}
    for (const key of PUBLIC_ENV_KEYS) {
      if (key in changes) safe[key] = changes[key]
    }
    const raw     = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf-8') : ''
    const updated = writeEnvFields(raw, safe)
    writeFileSync(ENV_PATH, updated, 'utf-8')
    return { ok: true }
  } catch (e) { return { ok: false, error: e.message } }
})

// ─── IPC: Sensitive .env params (password-protected) ─────────────────────────

ipcMain.handle('read-sensitive-env', (_, pwd) => {
  try {
    if (!existsSync(ADMIN_PATH)) return { ok: false, error: '未设置管理员密码' }
    const { hash, salt } = JSON.parse(readFileSync(ADMIN_PATH, 'utf-8'))
    if (!verifyPassword(pwd, hash, salt)) return { ok: false, error: '密码错误' }
    const raw = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf-8') : ''
    const all = parseEnv(raw)
    const env = {}
    for (const key of SENSITIVE_ENV_KEYS) env[key] = all[key] ?? ''
    return { ok: true, env }
  } catch (e) { return { ok: false, error: e.message, env: {} } }
})

ipcMain.handle('write-sensitive-env', (_, pwd, changes) => {
  try {
    if (!existsSync(ADMIN_PATH)) return { ok: false, error: '未设置管理员密码' }
    const { hash, salt } = JSON.parse(readFileSync(ADMIN_PATH, 'utf-8'))
    if (!verifyPassword(pwd, hash, salt)) return { ok: false, error: '密码错误' }
    const safe = {}
    for (const key of SENSITIVE_ENV_KEYS) {
      if (key in changes) safe[key] = changes[key]
    }
    const raw     = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf-8') : ''
    const updated = writeEnvFields(raw, safe)
    writeFileSync(ENV_PATH, updated, 'utf-8')
    return { ok: true }
  } catch (e) { return { ok: false, error: e.message } }
})
