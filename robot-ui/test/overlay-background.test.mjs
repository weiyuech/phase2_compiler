import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'

const project = fileURLToPath(new URL('../../', import.meta.url))
const mainSource = fs.readFileSync(path.join(project, 'robot-ui/src/main/index.js'), 'utf8')
const overlaySource = fs.readFileSync(path.join(project, 'robot-ui/src/renderer/src/BarrageOverlay.vue'), 'utf8')
const begin = mainSource.indexOf("ipcMain.handle('open-barrage-overlay',")
const end = mainSource.indexOf('// ─── IPC: File picker', begin)
assert.ok(begin >= 0 && end > begin, 'Locate the actual open/close overlay handlers')
const handlerSource = mainSource.slice(begin, end)

const captureBegin = mainSource.indexOf('function getScreenCapturePermissionStatus()')
const captureEnd = mainSource.indexOf("ipcMain.handle('capture-screen-region'", captureBegin)
assert.ok(captureBegin >= 0 && captureEnd > captureBegin, 'Locate the screen-source permission handler')
const captureHandlerSource = mainSource.slice(captureBegin, captureEnd)
const regionCaptureEnd = mainSource.indexOf("ipcMain.handle('open-barrage-overlay'", captureEnd)
assert.ok(regionCaptureEnd > captureEnd, 'Locate the legacy region-capture handler')
const regionCaptureHandlerSource = mainSource.slice(captureEnd, regionCaptureEnd)

// Verify the native-window options and CSS together without opening Electron
// or capturing the screen. Real packaged overlay operation remains a smoke test.
function setup(rendererUrl) {
  const handlers = new Map()
  const windows = []
  const sent = []
  class MockBrowserWindow extends EventEmitter {
    constructor(options) {
      super()
      this.options = options
      this.shown = 0
      this.closed = 0
      windows.push(this)
    }
    show() { this.shown++ }
    loadURL(url) { this.loadedUrl = url }
    loadFile(file, options) { this.loadedFile = { file, options } }
    close() { this.closed++; this.emit('closed') }
    isDestroyed() { return false }
  }
  const context = vm.createContext({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    BrowserWindow: MockBrowserWindow,
    require(name) {
      assert.equal(name, 'electron')
      return { screen: { getPrimaryDisplay: () => ({ id: 8, bounds: { x: -1440, y: 40, width: 1440, height: 900 }, scaleFactor: 2 }) } }
    },
    join: path.join,
    __dirname: '/mock/robot-ui/out/main',
    DEVTOOLS_ENABLED: false,
    process: { env: rendererUrl ? { ELECTRON_RENDERER_URL: rendererUrl } : {} },
    _win: { isDestroyed: () => false, webContents: { send: (...args) => sent.push(args) } },
  })
  vm.runInContext(`let _overlayWin = null; let _finishOverlaySelection = null;\n${handlerSource}`, context, { filename: 'actual-overlay-handlers.js' })
  return { handlers, windows, sent }
}

function setupScreenCapture({ platform = 'darwin', status = 'granted', sources = [{ id: 'screen:0:0', display_id: '8' }], sourceError = null, packaged = false } = {}) {
  const handlers = new Map()
  let sourceCalls = 0
  const opened = []
  const context = vm.createContext({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    app: { isPackaged: packaged },
    systemPreferences: { getMediaAccessStatus: () => status },
    desktopCapturer: {
      async getSources() {
        sourceCalls++
        if (sourceError) throw sourceError
        return sources
      }
    },
    shell: { async openExternal(url) { opened.push(url) } },
    require(name) {
      assert.equal(name, 'electron')
      return { screen: { getPrimaryDisplay: () => ({ id: 8, bounds: { x: -1440, y: 40, width: 1440, height: 900 }, scaleFactor: 2 }) } }
    },
    process: { platform, versions: { electron: 'test' } },
    console: { error() {} }
  })
  vm.runInContext(captureHandlerSource, context, { filename: 'actual-screen-capture-handler.js' })
  return { handlers, opened, sourceCalls: () => sourceCalls }
}

test('native overlay background is fully clear while CSS keeps the chosen green tint', () => {
  const { handlers, windows } = setup('http://localhost:5173')
  handlers.get('open-barrage-overlay')()
  assert.equal(windows.length, 1)
  const options = windows[0].options
  assert.equal(options.backgroundColor, '#00000000')
  assert.equal(options.transparent, true)
  assert.equal(options.frame, false)
  assert.equal(options.alwaysOnTop, true)
  assert.equal(options.width, 1440)
  assert.equal(options.height, 900)
  assert.equal(options.x, -1440)
  assert.equal(options.y, 40)
  assert.equal(windows[0].loadedUrl, 'http://localhost:5173#/overlay')
  assert.match(overlaySource, /\.overlay-container\s*\{[^}]*background-color:\s*rgba\(74,\s*222,\s*128,\s*0\.2\)/)
})

test('repeated enable reuses the singleton and native close releases it', () => {
  const { handlers, windows, sent } = setup('http://localhost:5173')
  const open = handlers.get('open-barrage-overlay')
  open()
  open()
  assert.equal(windows.length, 1)
  assert.equal(windows[0].shown, 1)
  windows[0].emit('closed')
  assert.deepEqual(sent, [['barrage-region-selected', null]])
  open()
  assert.equal(windows.length, 2)
})

test('confirm closes overlay and returns the unchanged selection to the main window', () => {
  const { handlers, windows, sent } = setup('http://localhost:5173')
  const open = handlers.get('open-barrage-overlay')
  const close = handlers.get('close-barrage-overlay')
  open()
  const rect = { x: 10, y: 20, width: 300, height: 200 }
  assert.equal(close({}, rect).ok, true)
  assert.equal(windows[0].closed, 1)
  assert.deepEqual(sent, [['barrage-region-selected', rect]])
  open()
  assert.equal(windows.length, 2)
})

test('packaged load and cancel retain the same route/lifetime behavior', () => {
  const { handlers, windows, sent } = setup()
  handlers.get('open-barrage-overlay')()
  assert.equal(windows[0].loadedFile.file, path.join('/mock/robot-ui/out/main', '../renderer/index.html'))
  assert.equal(windows[0].loadedFile.options.hash, '/overlay')
  assert.equal(handlers.get('close-barrage-overlay')({}, null).ok, true)
  assert.equal(windows[0].closed, 1)
  assert.deepEqual(sent, [['barrage-region-selected', null]])
})

test('screen source attempts enumeration even when macOS preflight says denied', async () => {
  const { handlers, sourceCalls } = setupScreenCapture({
    status: 'denied',
    sourceError: new Error('Failed to get sources.')
  })
  const result = await handlers.get('get-screen-source-id')()
  assert.equal(result.ok, false)
  assert.equal(result.code, 'SCREEN_PERMISSION_DENIED')
  assert.equal(result.permissionStatus, 'denied')
  assert.equal(result.canOpenSettings, true)
  assert.match(result.error, /Electron（本地开发版）/)
  assert.equal(sourceCalls(), 1)
})

test('an empty macOS source list retains the permission recovery action', async () => {
  const { handlers } = setupScreenCapture({ status: 'denied', sources: [] })
  const result = await handlers.get('get-screen-source-id')()
  assert.equal(result.code, 'SCREEN_PERMISSION_DENIED')
  assert.equal(result.canOpenSettings, true)
})

test('region capture does not short-circuit on the macOS preflight value', () => {
  assert.doesNotMatch(regionCaptureHandlerSource, /status\s*!==\s*['"]granted['"][\s\S]*return/)
  assert.match(regionCaptureHandlerSource, /desktopCapturer\.getSources\(/)
  assert.match(regionCaptureHandlerSource, /screenCapturePermissionFailure\(permissionStatus\)/)
})

test('screen source returns a structured id after a granted preflight', async () => {
  const { handlers, sourceCalls } = setupScreenCapture()
  const result = await handlers.get('get-screen-source-id')()
  assert.equal(result.ok, true)
  assert.equal(result.sourceId, 'screen:0:0')
  assert.equal(result.permissionStatus, 'granted')
  assert.deepEqual(JSON.parse(JSON.stringify(result.display)), {
    id: '8',
    bounds: { x: -1440, y: 40, width: 1440, height: 900 },
    scaleFactor: 2
  })
  assert.equal(result.primaryMatched, true)
  assert.equal(sourceCalls(), 1)
})

test('screen source matches the primary display instead of assuming the first source', async () => {
  const { handlers } = setupScreenCapture({
    sources: [
      { id: 'screen:secondary', display_id: '3' },
      { id: 'screen:primary', display_id: '8' }
    ]
  })
  const result = await handlers.get('get-screen-source-id')()
  assert.equal(result.sourceId, 'screen:primary')
})

test('screen source failure distinguishes permission from enumeration errors', async () => {
  const denied = setupScreenCapture({ status: 'not-determined', sourceError: new Error('Failed to get sources.') })
  const permissionResult = await denied.handlers.get('get-screen-source-id')()
  assert.equal(permissionResult.code, 'SCREEN_PERMISSION_DENIED')
  assert.equal(permissionResult.permissionStatus, 'not-determined')

  const granted = setupScreenCapture({ status: 'granted', sourceError: new Error('Failed to get sources.') })
  const sourceResult = await granted.handlers.get('get-screen-source-id')()
  assert.equal(sourceResult.code, 'SCREEN_SOURCE_FAILED')
  assert.equal(sourceResult.canOpenSettings, undefined)
})

test('macOS screen permission action opens only the Screen Recording settings pane', async () => {
  const { handlers, opened } = setupScreenCapture()
  const result = await handlers.get('open-screen-recording-settings')()
  assert.equal(result.ok, true)
  assert.deepEqual(opened, ['x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'])
})
