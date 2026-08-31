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
  }
  const context = vm.createContext({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    BrowserWindow: MockBrowserWindow,
    require(name) {
      assert.equal(name, 'electron')
      return { screen: { getPrimaryDisplay: () => ({ bounds: { width: 1440, height: 900 } }) } }
    },
    join: path.join,
    __dirname: '/mock/robot-ui/out/main',
    DEVTOOLS_ENABLED: false,
    process: { env: rendererUrl ? { ELECTRON_RENDERER_URL: rendererUrl } : {} },
    _win: { webContents: { send: (...args) => sent.push(args) } },
  })
  vm.runInContext(`let _overlayWin = null;\n${handlerSource}`, context, { filename: 'actual-overlay-handlers.js' })
  return { handlers, windows, sent }
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
  assert.equal(windows[0].loadedUrl, 'http://localhost:5173#/overlay')
  assert.match(overlaySource, /\.overlay-container\s*\{[^}]*background-color:\s*rgba\(74,\s*222,\s*128,\s*0\.2\)/)
})

test('repeated enable reuses the singleton and native close releases it', () => {
  const { handlers, windows } = setup('http://localhost:5173')
  const open = handlers.get('open-barrage-overlay')
  open()
  open()
  assert.equal(windows.length, 1)
  assert.equal(windows[0].shown, 1)
  windows[0].emit('closed')
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
  assert.equal(sent.length, 0)
})
