import { app, BrowserWindow, dialog, utilityProcess, systemPreferences, desktopCapturer, shell } from 'electron'
import { join }                        from 'path'
import { readFileSync, writeFileSync, existsSync, cpSync, renameSync, rmSync } from 'fs'
import { scryptSync, randomBytes, timingSafeEqual } from 'crypto'
import { RollingLog } from '../../../src/diagnostics/rolling-log.js'
import { createDiagnosticsReport } from '../../../src/diagnostics/report.js'
import { seedMachineProfile, backendEnvironment } from '../../../src/packaging/machine-profile.js'
import { DEFAULT_OCR_JUDGE_PROMPT, resolveOcrJudgePrompt } from '../../../src/phase2/ocr/judge-prompt.js'
import { readStationaryPrompt, readStationaryOptions, writeStationaryPrompt } from '../../../src/llm/stationary-prompt-store.js'
import { speechProfileKeys, speechProfileMigration, selectSpeechProfileChanges } from '../../../src/config/speech-profiles.js'
import { createBackendRestarter } from './backend-restart.mjs'


// One closure per machine: settings, backend, IPC and OCR selection never share state.
export function createMachineRuntime({ profile, projectRoot, view, ownerWindow, registerOverlay }) {
const PROJECT_ROOT = projectRoot
const USER_DATA_DIR = profile.root
const CONFIG_DIR = join(USER_DATA_DIR, 'config')
const DIAGNOSTICS_DIR = profile.diagnosticsDir
const DEVTOOLS_ENABLED = !app.isPackaged || process.env.ROBOT_DEVTOOLS === '1'
const handlers = new Map()
const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) }
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
const BANNED_WORDS_PATH = join(CONFIG_DIR, 'banned-words.txt')
const LLM_PROMPT_PATH   = join(CONFIG_DIR, 'llm-system-prompt.txt')
const STATIONARY_PROMPT_PATH = join(CONFIG_DIR, 'stationary-prompt.txt')
const BARRAGE_PROMPT_NAME_PATH = join(CONFIG_DIR, 'barrage-prompt-name.txt')
const BARRAGE_PROMPT_GENERAL_PATH = join(CONFIG_DIR, 'barrage-prompt-general.txt')
const BARRAGE_PROMPT_JUDGE_PATH = join(CONFIG_DIR, 'barrage-prompt-judge.txt')
const ADMIN_PATH        = join(CONFIG_DIR, 'admin.json')
const ENV_PATH          = join(USER_DATA_DIR, '.env')

const PUBLIC_ENV_KEYS   = [
  ...speechProfileKeys('cruise'), ...speechProfileKeys('barrage'),
  ...speechProfileKeys('transit'),
  'KB_PROVIDER', 'DOUBAO_MODEL', 'DEEPSEEK_MODEL', 'TTS_VOICE_TYPE', 'TTS_CLUSTER', 'TTS_RESOURCE_ID', 'TTS_AUTH_MODE',
  'DUCK_VOLUME', 'DUCK_FADE_MS', 'LLM_TIMEOUT_MS', 'LLM_MAX_TOKENS', 'TTS_TIMEOUT_MS', 'ROBOT_PORT', 'ROBOT_URL',
  'DUCK_NOISE_DB', 'DUCK_DURATION', 'BANNED_WORDS_FILE',
  'BARRAGE_DOUBAO_MODEL', 'BARRAGE_DEEPSEEK_MODEL', 'BARRAGE_TTS_VOICE_TYPE', 'BARRAGE_TTS_CLUSTER',
  'BARRAGE_TTS_RESOURCE_ID', 'BARRAGE_TTS_AUTH_MODE', 'BARRAGE_TTS_TIMEOUT_MS', 'BARRAGE_LLM_TIMEOUT_MS', 'BARRAGE_LLM_MAX_TOKENS'
]
const SENSITIVE_ENV_KEYS = [
  ...speechProfileKeys('cruise', { secrets: true }), ...speechProfileKeys('barrage', { secrets: true }),
  ...speechProfileKeys('transit', { secrets: true }),
  'DOUBAO_API_KEY', 'DEEPSEEK_API_KEY', 'QWEN_API_KEY',
  'TTS_APP_ID', 'TTS_ACCESS_TOKEN', 'TTS_API_KEY',
  'NGROK_AUTHTOKEN',
  'BARRAGE_DOUBAO_API_KEY', 'BARRAGE_DEEPSEEK_API_KEY', 'BARRAGE_QWEN_API_KEY',
  'BARRAGE_TTS_APP_ID', 'BARRAGE_TTS_ACCESS_TOKEN', 'BARRAGE_TTS_API_KEY'
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
    // 和 dotenv 的行为保持一致：带引号的值取引号内内容，未加引号的值要去掉行尾注释。
    // .env.example 里几乎每行都带 `# 说明`，不处理的话设置界面会把注释当成值显示
    // （TTS_VOICE_TYPE 会显示成 "# built-in voice ..."，看着像已配置其实是空的），
    // 用户点一次保存就把注释原样写回 .env 了。
    const rest   = t.slice(eq + 1)
    const quoted = rest.trim().match(/^(['"])([\s\S]*?)\1/)
    result[key]  = quoted ? quoted[2] : rest.replace(/\s+#.*$/, '').trim()
  }
  return result
}

function writeEnvFields(raw, changes) {
  // 值里如果混进换行，写回去就变成了新的一行 KEY=VALUE。
  // 那样 write-public-env（不需要密码）就能写入 SENSITIVE 的密钥，
  // 甚至写入 FFPLAY_PATH 让后端去启动任意程序。这里直接挡掉。
  for (const [key, val] of Object.entries(changes)) {
    if (/^(?:(?:TRANSIT|BARRAGE)_)?DEEPSEEK_PLATFORM$/.test(key) && !['', 'official', 'ark'].includes(val)) {
      throw new Error('DeepSeek 平台无效，请从下拉列表选择')
    }
    if (/^(?:(?:TRANSIT|BARRAGE)_)?LLM_(?:FALLBACK_)?PROVIDER$/.test(key)) {
      const allowed = key.endsWith('FALLBACK_PROVIDER') ? ['', 'none', 'doubao', 'deepseek', 'qwen'] : ['', 'doubao', 'deepseek', 'qwen']
      if (!allowed.includes(val)) throw new Error('LLM 服务商无效，请从下拉列表选择')
    }
    if (/[\r\n]/.test(String(val))) {
      throw new Error(`配置项 ${key} 的值不能包含换行`)
    }
  }

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

function readEnvironment() {
  const raw = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : ''
  const env = parseEnv(raw)
  return { ...env, ...speechProfileMigration(env) }
}

function saveEnvironmentChanges(changes) {
  const raw = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : ''
  const updated = writeEnvFields(raw, { ...speechProfileMigration(parseEnv(raw)), ...changes })
  const temporary = `${ENV_PATH}.${randomBytes(8).toString('hex')}.tmp`
  try {
    writeFileSync(temporary, updated, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    renameSync(temporary, ENV_PATH)
  } finally { rmSync(temporary, { force: true }) }
}

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
// Each machine owns a utilityProcess in both development and packaged builds.

let _backendProcess = null
const _win = { webContents: view.webContents, isDestroyed: () => view.webContents.isDestroyed() }
let _disposed = false
// Backend failure may precede renderer readiness; retain it for the first status query.
let _lastBackendExit = null
// 后端实际监听的端口。首选 3001，被占用时后端会改用系统分配的空闲端口，
// 并通过 parentPort 把真实端口告诉这里，再由渲染进程取走。
let _uiPort = null

// ─── backend.log 轮转 ─────────────────────────────────────────────────────────
// 两段各 512 KiB，整个类别最多 1 MiB；队列有上限，异步批量写入。
let _backendLog = null
function appendLog(value) {
  // The shell owns one independent log writer for each machine.
  _backendLog ||= new RollingLog({ directory: DIAGNOSTICS_DIR, name: 'backend.log' })
  _backendLog.append(value)
}

function startBackend() {
  if (_disposed || _backendProcess) return

  _lastBackendExit = null
  _uiPort = null            // 重启后端会重新分配，先清掉旧值

  const entry   = join(PROJECT_ROOT, 'src/index.js')
  const logPath = join(DIAGNOSTICS_DIR, 'backend.log')

  const log = (s) => appendLog(s)

  log(`\n=== backend start ${new Date().toISOString()} ===\n`)
  log(`entry: ${entry}\n`)
  log(`PROJECT_ROOT: ${PROJECT_ROOT}\n`)
  log(`USER_DATA_DIR: ${USER_DATA_DIR}\n`)
  log(`entry exists: ${existsSync(entry)}\n`)

  _backendProcess = utilityProcess.fork(entry, [], {
    env: backendEnvironment({
      parent: process.env, projectRoot: PROJECT_ROOT, userDataDir: USER_DATA_DIR,
      environmentPath: ENV_PATH, path: buildPath(), id: profile.id, diagnosticsDir: DIAGNOSTICS_DIR,
    }),
    cwd: PROJECT_ROOT,
    stdio: 'pipe',
  })
  // StringDecoder 而不是逐块 toString('utf8')：中文有可能正好被切在两个 chunk 之间，
  // 分别 toString 会在接缝处留下一个乱码字（日志是给人看的，别自己制造噪音）
  const { StringDecoder } = require('string_decoder')
  const outDecoder = new StringDecoder('utf8')
  _backendProcess.stdout?.on('data', d => {
    log('[out] ' + outDecoder.write(Buffer.isBuffer(d) ? d : Buffer.from(d)))
  })

  // stderr 和 stdout 一样进入有上限的异步日志队列；这里只额外保留
  // 少量错误尾部给启动失败提示。异常退出可能丢失最后尚未写入的数据。
  const STDERR_TAIL_MAX = 64 * 1024
  const errDecoder = new StringDecoder('utf8')
  let stderrTail = ''
  _backendProcess.stderr?.on('data', d => {
    const s = errDecoder.write(Buffer.isBuffer(d) ? d : Buffer.from(d))
    if (!s) return
    log('[err] ' + s)
    stderrTail = (stderrTail + s).slice(-STDERR_TAIL_MAX)
  })

  // 后端启动后会把真实监听端口发过来
  const backend = _backendProcess
  backend.on('message', (msg) => {
    if (_backendProcess !== backend || _disposed) return
    if (msg?.type === 'UI_PORT' && Number.isInteger(msg.port)) {
      _uiPort = msg.port
      log(`[backend] UI 通道端口: ${_uiPort}\n`)
      try {
        if (_win && !_win.isDestroyed()) _win.webContents.send('ui-port', _uiPort)
      } catch {}
    }
  })

  backend.on('exit', (code) => {
    if (_backendProcess !== backend) return
    log(`[backend] process exited with code ${code}\n`)
    _backendProcess = null
    _uiPort = null
    // 后端崩溃时界面原本只会显示"未连接"，用户无从判断是配置问题还是程序问题。
    // 把退出码和 stderr 末尾几行送到渲染进程，直接显示在标题栏上。
    const tail = stderrTail.trim().split('\n').slice(-8).join('\n')
    _lastBackendExit = { code, stderr: tail, logPath }
    // 退出可能发生在窗口已销毁之后（比如 before-quit 里 kill 后端），
    // 对已销毁的窗口 send 会抛异常，反过来把这个 exit 处理器搞崩
    try {
      if (_win && !_win.isDestroyed()) _win.webContents.send('backend-exit', _lastBackendExit)
    } catch {}
  })
}

// utilityProcess.fork 抛异常（入口文件缺失等）不能把主进程一起带走：
// 在 whenReady 里会连托盘和窗口都起不来，在 setTimeout 里更是直接崩主进程。
// 统一走这个包装：记下失败原因，界面照常显示。
function startBackendSafe() {
  try {
    startBackend()
    return { ok: true }
  } catch (err) {
    _lastBackendExit = {
      code: null,
      stderr: `启动后端进程失败: ${err?.stack || err}`,
      logPath: join(DIAGNOSTICS_DIR, 'backend.log'),
    }
    try {
      if (_win && !_win.isDestroyed()) _win.webContents.send('backend-exit', _lastBackendExit)
    } catch {}
    return { ok: false, error: `启动后端进程失败：${err?.message || err}` }
  }
}

// ─── IPC: Restart backend ─────────────────────────────────────────────────────
// 保存密钥/运行参数后调用，让后端重新读取 .env 使配置立即生效
const backendRestarter = createBackendRestarter({
  getBackend: () => _backendProcess,
  startBackend: startBackendSafe,
  isClosing: () => _disposed,
})

// ─── IPC: 诊断日志导出 ────────────────────────────────────────────────────────
// 目的：让非技术用户能一键把排障需要的信息存成一个文件发给开发者，
// 而不是让对方去 %APPDATA% 里翻目录。后端崩了也能用（全在主进程里跑）。

async function buildDiagnosticsReport(includeBackendLogs = false) {
  // A failed backend cannot answer a flush request. Persisted audio history is
  // still exportable; never wait indefinitely on a live or crashed process.
  if (_backendLog) await Promise.race([_backendLog.flush(), new Promise(resolve => setTimeout(resolve, 500))])
  return createDiagnosticsReport({
    directory: DIAGNOSTICS_DIR, includeBackendLogs,
    metadata: {
      appVersion: app.getVersion(), electronVersion: process.versions.electron,
      nodeVersion: process.versions.node, platform: process.platform, arch: process.arch,
      packaged: app.isPackaged,
      backendStatus: _backendProcess ? 'running' : (_lastBackendExit ? 'exited' : 'not-running'),
      backendEntryExists: existsSync(join(PROJECT_ROOT, 'src/index.js')),
      dependenciesExist: existsSync(join(PROJECT_ROOT, 'node_modules')),
      ffplayBundled: existsSync(join(PROJECT_ROOT, 'ffplay.exe')),
    },
  })
}

ipcMain.handle('export-diagnostics', async (_event, options = {}) => {
  try {
    const includeBackendLogs = options?.includeBackendLogs === true
    if (includeBackendLogs) {
      const answer = await dialog.showMessageBox({
        type: 'warning', buttons: ['取消', '包含后台日志并继续'], defaultId: 0, cancelId: 0,
        title: '后台日志可能包含隐私内容',
        message: '原始后台日志可能含播报文字、OCR、文档内容、文件路径或连接地址。请在发送给他人前检查文件。',
      })
      if (answer.response !== 1) return { ok: false, error: '已取消' }
    }
    const now  = new Date()
    const pad  = (n) => String(n).padStart(2, '0')
    const name = `诊断日志-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.txt`

    const { canceled, filePath } = await dialog.showSaveDialog({
      title: '导出诊断日志（请把这个文件发给技术支持）',
      defaultPath: join(app.getPath('desktop'), name),
      filters: [{ name: 'Text Files', extensions: ['txt'] }]
    })
    if (canceled || !filePath) return { ok: false, error: '已取消' }

    // \r\n + BOM：用户大概率直接用 Windows 记事本打开。
    // 旧版记事本（Win10 1903 之前 / Win7）不加 BOM 会把中文显示成乱码
    const report = await buildDiagnosticsReport(includeBackendLogs)
    writeFileSync(filePath, '﻿' + report.replace(/\r?\n/g, '\r\n'), 'utf-8')
    const { shell } = require('electron')
    shell.showItemInFolder(filePath)        // 直接在资源管理器里高亮这个文件
    return { ok: true, path: filePath }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

// 渲染进程启动时来问一次：后端是不是已经挂了（窗口出现之前就崩溃的情况）
ipcMain.handle('get-backend-status', () => {
  if (_backendProcess)  return { running: true, port: _uiPort }
  return { running: false, port: _uiPort, ..._lastBackendExit }
})

// 每个页面只查询所属后台的端口，启动和重启时均不猜测其他实例的端口。
ipcMain.handle('get-ui-port', () => _uiPort)

ipcMain.handle('restart-backend', () => backendRestarter.request())

// ─── IPC: Barrage Overlay ─────────────────────────────────────────────────────

let _overlayWin = null
let _finishOverlaySelection = null

function getScreenCapturePermissionStatus() {
  if (process.platform !== 'darwin') return 'not-applicable'
  return systemPreferences.getMediaAccessStatus('screen')
}

function screenSourceForDisplay(sources, display) {
  const displayId = String(display?.id ?? '')
  return sources.find(source => String(source?.display_id ?? '') === displayId) || sources[0] || null
}

function screenCapturePermissionFailure(status) {
  const appLabel = app.isPackaged ? '机器人直播控制台' : 'Electron（本地开发版）'
  return {
    ok: false,
    code: 'SCREEN_PERMISSION_DENIED',
    permissionStatus: status,
    canOpenSettings: true,
    error: `macOS 未允许 ${appLabel} 录制屏幕。请在“系统设置 → 隐私与安全性 → 屏幕与系统音频录制（或屏幕录制）”中开启权限，然后完全退出并重新打开应用。`
  }
}

ipcMain.handle('get-screen-source-id', async () => {
  let permissionStatus = getScreenCapturePermissionStatus()
  try {
    // Do not return early when macOS reports `denied`. Before the first request
    // after a TCC reset, screen status may still look denied; getSources() is the
    // user-initiated call that gives macOS a chance to display its consent prompt.
    // Width/height 0 avoids making thumbnails; the renderer only needs the id.
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 0, height: 0 }
    })
    if (!sources.length) {
      if (process.platform === 'darwin' && permissionStatus !== 'granted') {
        return screenCapturePermissionFailure(permissionStatus)
      }
      return {
        ok: false,
        code: 'NO_SCREEN_SOURCE',
        permissionStatus,
        error: '未找到可用的屏幕画面。请完全退出并重新打开应用；若仍失败，请导出诊断日志。'
      }
    }
    const { screen } = require('electron')
    const primaryDisplay = screen.getPrimaryDisplay()
    const source = screenSourceForDisplay(sources, primaryDisplay)
    const primaryMatched = String(source?.display_id ?? '') === String(primaryDisplay.id)
    if (!primaryMatched && sources.length > 1) {
      console.warn(`[screen-capture] primary display ${primaryDisplay.id} did not match a source display_id; using ${source.id}`)
    }
    return {
      ok: true,
      sourceId: source.id,
      permissionStatus,
      display: {
        id: String(primaryDisplay.id),
        bounds: {
          x: primaryDisplay.bounds.x,
          y: primaryDisplay.bounds.y,
          width: primaryDisplay.bounds.width,
          height: primaryDisplay.bounds.height
        },
        scaleFactor: primaryDisplay.scaleFactor
      },
      primaryMatched
    }
  } catch (error) {
    permissionStatus = getScreenCapturePermissionStatus()
    console.error(
      `[screen-capture] source enumeration failed: permission=${permissionStatus} ` +
      `platform=${process.platform} electron=${process.versions.electron} error=${error?.message || error}`
    )
    if (process.platform === 'darwin' && permissionStatus !== 'granted') {
      return screenCapturePermissionFailure(permissionStatus)
    }
    return {
      ok: false,
      code: 'SCREEN_SOURCE_FAILED',
      permissionStatus,
      error: process.platform === 'win32'
        ? '无法获取屏幕画面。请在 Windows“设置 → 隐私和安全性 → 屏幕截图和录制”中允许桌面应用访问，然后重启应用。'
        : '系统已允许屏幕录制，但 Electron 无法获取屏幕画面。请完全退出并重新打开应用；若仍失败，请导出诊断日志。'
    }
  }
})

ipcMain.handle('open-screen-recording-settings', async () => {
  if (process.platform !== 'darwin') {
    return { ok: false, error: '此设置入口仅适用于 macOS。' }
  }
  try {
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error?.message || String(error) }
  }
})

ipcMain.handle('capture-screen-region', async (_, rect) => {
  try {
    // Do not gate capture on the macOS preflight value. Electron cannot request
    // Screen Recording through askForMediaAccess(), and a reset/changed binary
    // can still report `denied` before the first real user-initiated capture.
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

    const primaryScreen = screenSourceForDisplay(sources, primaryDisplay)

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
    const permissionStatus = getScreenCapturePermissionStatus()
    if (process.platform === 'darwin' && permissionStatus !== 'granted') {
      return screenCapturePermissionFailure(permissionStatus)
    }
    return { ok: false, code: 'SCREEN_CAPTURE_FAILED', permissionStatus, error: error.message }
  }
})

ipcMain.handle('open-barrage-overlay', () => {
  if (_overlayWin) {
    _overlayWin.show()
    return
  }

  const { screen } = require('electron')
  const primaryDisplay = screen.getPrimaryDisplay()
  const { x, y, width, height } = primaryDisplay.bounds
  _overlayWin = new BrowserWindow({
    width,
    height,
    x,
    y,
    transparent: true,
    backgroundColor: '#00000000', // Transparent native background; the overlay page draws the green tint.
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
      devTools: DEVTOOLS_ENABLED,
      allowLoadingUnsignedLibraries: true
    }
  })
  const overlayWin = _overlayWin
  registerOverlay?.(overlayWin.webContents)
  let selectionResolved = false
  const finishSelection = (rect) => {
    if (selectionResolved) return
    selectionResolved = true
    if (_win && !_win.isDestroyed()) {
      _win.webContents.send('barrage-region-selected', rect || null)
    }
  }
  _finishOverlaySelection = finishSelection
  // Load a special route or HTML for the overlay.
  // In dev mode, Vite serves the whole app, we can use a hash route like `#/overlay`
  if (process.env['ELECTRON_RENDERER_URL']) {
    overlayWin.loadURL(process.env['ELECTRON_RENDERER_URL'] + '#/overlay')
  } else {
    overlayWin.loadFile(join(__dirname, '../renderer/index.html'), { hash: '/overlay' })
  }

  overlayWin.on('closed', () => {
    if (_overlayWin === overlayWin) {
      _overlayWin = null
      _finishOverlaySelection = null
    }
    finishSelection(null)
  })
})

ipcMain.handle('close-barrage-overlay', (_, rect) => {
  const overlayWin = _overlayWin
  const finishSelection = _finishOverlaySelection
  finishSelection?.(rect || null)
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.close()
  }
  return { ok: true }
})

// ─── IPC: File picker ─────────────────────────────────────────────────────────

ipcMain.handle('select-mp3-file', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender) || ownerWindow
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'm4a'] }]
  })
  if (canceled || filePaths.length === 0) return null
  return filePaths[0]
})

ipcMain.handle('select-json-file', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender) || ownerWindow
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })
  if (canceled || filePaths.length === 0) return null
  return filePaths[0]
})

ipcMain.handle('select-multiple-mp3-files', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender) || ownerWindow
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'm4a'] }]
  })
  if (canceled || filePaths.length === 0) return []
  return filePaths
})

ipcMain.handle('export-tts-audio', async (event, hash, defaultFilename) => {
  if (typeof hash !== 'string' || !/^[a-f0-9]{32,64}$/i.test(hash)) throw new Error('无效的语音文件')
  const win = BrowserWindow.fromWebContents(event.sender) || ownerWindow
  const dataDir = join(USER_DATA_DIR, 'data')
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
  const win = BrowserWindow.fromWebContents(event.sender) || ownerWindow
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

ipcMain.handle('read-stationary-prompt', () => {
  try { return { ok: true, text: readStationaryPrompt(STATIONARY_PROMPT_PATH), ...readStationaryOptions(STATIONARY_PROMPT_PATH) } }
  catch (e) { return { ok: false, error: e.message } }
})

ipcMain.handle('write-stationary-prompt', (_, text, stylePrompt, customEnabled) => {
  try {
    writeStationaryPrompt(text, STATIONARY_PROMPT_PATH, stylePrompt, customEnabled)
    return { ok: true }
  } catch (e) { return { ok: false, error: e.message } }
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

ipcMain.handle('read-barrage-prompt-judge', () => {
  try { return { ok: true, text: resolveOcrJudgePrompt(readFileSync(BARRAGE_PROMPT_JUDGE_PATH, 'utf-8')) } }
  catch (e) {
    return e.code === 'ENOENT' ? { ok: true, text: DEFAULT_OCR_JUDGE_PROMPT } : { ok: false, error: e.message }
  }
})

ipcMain.handle('write-barrage-prompt-judge', (_, text) => {
  try {
    if (typeof text !== 'string' || !text.trim() || text.length > 32000) throw new Error('判断提示词不能为空且不能超过 32000 字符')
    writeFileSync(BARRAGE_PROMPT_JUDGE_PATH, text, 'utf-8')
    return { ok: true }
  } catch (e) { return { ok: false, error: e.message } }
})

ipcMain.handle('write-barrage-prompt-general', (_, text) => {
  try {
    writeFileSync(BARRAGE_PROMPT_GENERAL_PATH, text, 'utf-8')
    return { ok: true }
  } catch (e) { return { ok: false, error: e.message } }
})

ipcMain.handle('download-barrage-log', async () => {
  const dataDir = join(USER_DATA_DIR, 'data')
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

const MIN_PASSWORD_LEN = 4

ipcMain.handle('admin-set-password', (_, newPwd) => {
  try {
    // 只能用于"首次设置"。以前这里不检查密码是否已存在，界面也只是把设置表单
    // 藏起来而已——于是任何能执行渲染进程代码的人（打开 DevTools 就行）
    // 都可以先重置密码，再用新密码把所有 API 密钥读出来。
    // 修改密码必须走 admin-change-password（它会校验旧密码）。
    if (existsSync(ADMIN_PATH)) {
      return { ok: false, error: '已设置过密码，请使用「修改密码」' }
    }
    // 长度校验放在主进程：渲染进程里的校验只是 UX，绕得过去
    if (typeof newPwd !== 'string' || newPwd.length < MIN_PASSWORD_LEN) {
      return { ok: false, error: `密码至少 ${MIN_PASSWORD_LEN} 位` }
    }
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
    if (typeof newPwd !== 'string' || newPwd.length < MIN_PASSWORD_LEN) {
      return { ok: false, error: `密码至少 ${MIN_PASSWORD_LEN} 位` }
    }
    writeFileSync(ADMIN_PATH, JSON.stringify(hashPassword(newPwd)), 'utf-8')
    return { ok: true }
  } catch (e) { return { ok: false, error: e.message } }
})

// ─── IPC: Public .env params (no password) ───────────────────────────────────

ipcMain.handle('read-public-env', () => {
  try {
    const all = readEnvironment()
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
    saveEnvironmentChanges(safe)
    return { ok: true }
  } catch (e) { return { ok: false, error: e.message } }
})

// ─── IPC: Sensitive .env params (password-protected) ─────────────────────────

ipcMain.handle('read-sensitive-env', (_, pwd) => {
  try {
    if (!existsSync(ADMIN_PATH)) return { ok: false, error: '未设置管理员密码' }
    const { hash, salt } = JSON.parse(readFileSync(ADMIN_PATH, 'utf-8'))
    if (!verifyPassword(pwd, hash, salt)) return { ok: false, error: '密码错误' }
    const all = readEnvironment()
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
    saveEnvironmentChanges(safe)
    return { ok: true }
  } catch (e) { return { ok: false, error: e.message } }
})

// Save one complete speech profile, including voice/model parameters, in one write.
ipcMain.handle('write-speech-profile', (_, pwd, profile, changes) => {
  try {
    if (!existsSync(ADMIN_PATH)) return { ok: false, error: '未设置管理员密码' }
    const { hash, salt } = JSON.parse(readFileSync(ADMIN_PATH, 'utf8'))
    if (!verifyPassword(pwd, hash, salt)) return { ok: false, error: '密码错误' }
    saveEnvironmentChanges(selectSpeechProfileChanges(profile, changes))
    return { ok: true }
  } catch (e) { return { ok: false, error: e.message } }
})

// End machine IPC
return {
  id: profile.id, handlers,
  start() {
    try {
      const seeded = seedMachineProfile({ profile, packaged: app.isPackaged, projectRoot: PROJECT_ROOT })
      if (seeded.environmentCreated) saveEnvironmentChanges({ ROBOT_PORT: String(profile.defaultRobotPort) })
      if (existsSync(ENV_PATH)) {
        const migration = speechProfileMigration(parseEnv(readFileSync(ENV_PATH, 'utf8')))
        if (Object.keys(migration).length) saveEnvironmentChanges(migration)
      }
      startBackendSafe()
    } catch (error) {
      // An inaccessible profile must not prevent the other machines from opening.
      _lastBackendExit = { code: null, stderr: `工作区初始化失败: ${error?.message || error}`,
        logPath: join(DIAGNOSTICS_DIR, 'backend.log') }
      try { if (!_win.isDestroyed()) _win.webContents.send('backend-exit', _lastBackendExit) } catch {}
    }
  },
  dispose() {
    _disposed = true
    backendRestarter.dispose()
    _overlayWin?.close()
    try { _backendProcess?.kill() } catch (error) {
      appendLog(`[backend] shutdown failed: ${error?.message || error}\n`)
    }
    return _backendLog?.flush()
  },
}
}
