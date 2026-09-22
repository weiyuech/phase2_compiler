// Real Electron UI + three real OCR workers. Uses synthetic images and empty
// profiles; never captures the screen, plays audio, calls APIs or controls robots.
import { _electron as electron } from 'playwright'
import sharp from 'sharp'
import { WebSocket } from 'ws'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '../..')
const argument = name => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1] }
const packaged = argument('--executable')
if (packaged && process.env.GITHUB_ACTIONS !== 'true') throw new Error('Packaged smoke must run on a clean GitHub Actions runner')
const profile = await mkdtemp(join(tmpdir(), 'miaofei-shell-test-'))
const shots = resolve(argument('--shots') || join(root, 'output/machine-shell-preview'))
await mkdir(shots, { recursive: true })
const env = { ...process.env, MIAOFEI_DEV_PROFILE: profile }
delete env.ELECTRON_RUN_AS_NODE
const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms))
async function until(check, message, timeout = 60000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await wait(200) }
  throw new Error(message)
}
let app
const sockets = []
const report = { status: 'failed', checks: [] }
const pass = name => { report.checks.push(name); console.log('[machine-shell] PASS ' + name) }
try {
  app = await electron.launch({
    executablePath: packaged ? resolve(packaged) : require('electron'),
    args: packaged ? [] : [join(root, 'robot-ui')], env, timeout: 60000,
  })
  console.log('[machine-shell] launched')
  app.context().setDefaultTimeout(15000)
  app.context().setDefaultNavigationTimeout(15000)
  await app.firstWindow()
  const shell = await until(() => app.context().pages().find(p => p.url().endsWith('#/shell')), 'Shell renderer did not load')
  await shell.waitForLoadState('domcontentloaded')
  await shell.locator('.welcome-art').waitFor()
  await shell.waitForFunction(() => document.querySelector('.welcome-art')?.complete)
  const errors = []
  for (const page of app.context().pages()) page.on('pageerror', error => errors.push(error.message))
  const dataRoot = packaged ? await app.evaluate(({ app }) => app.getPath('userData')) : profile
  const directory = id => id === 1 ? dataRoot : join(dataRoot, 'machines', `machine-${id}`)
  const machine = async (id, expression) => app.evaluate(async ({ webContents }, { id, expression }) => {
    const view = webContents.getAllWebContents().find(w => w.getURL().endsWith(`/machine/${id}`))
    if (!view) return null
    return view.executeJavaScript(expression)
  }, { id, expression })
  const status = id => machine(id, 'window.api.getBackendStatus()')
  async function capture(name) {
    // Electron capturePage captures an individual WebContents. Composite the
    // actual native child surfaces at their actual bounds (no simulated UI).
    await wait(180)
    const layers = await app.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/shell'))
      const result = { size: win.getContentSize(), base: (await win.webContents.capturePage()).toPNG().toString('base64'), children: [] }
      for (const view of win.contentView.children) {
        if (view.getVisible() && view.webContents) result.children.push({ bounds: view.getBounds(), image: (await view.webContents.capturePage()).toPNG().toString('base64') })
      }
      return result
    })
    const base = Buffer.from(layers.base, 'base64')
    const metadata = await sharp(base).metadata()
    const scale = metadata.width / layers.size[0]
    const overlays = await Promise.all(layers.children.map(async child => ({
      input: await sharp(Buffer.from(child.image, 'base64')).resize(Math.round(child.bounds.width * scale), Math.round(child.bounds.height * scale)).png().toBuffer(),
      left: Math.round(child.bounds.x * scale), top: Math.round(child.bounds.y * scale),
    })))
    await sharp(base).composite(overlays).png().toFile(join(shots, name))
  }
  console.log('[machine-shell] welcome ready')
  await capture('01-welcome.png')
  console.log('[machine-shell] welcome captured')
  console.log('[machine-shell] entering via click')
  await shell.getByRole('button', { name: '欢迎来到喵飞直播控制系统，点击任意位置进入机器 1' }).click()
  console.log('[machine-shell] click delivered')
  await shell.locator('.machine-tabs').waitFor()
  console.log('[machine-shell] entered')
  console.log('[machine-shell] querying machine backends')
  const initial = await until(async () => {
    const values = await Promise.all([1, 2, 3].map(status))
    return values.every(s => s?.running && s.port) && values
  }, 'Three independent backends did not start')
  assert.equal(new Set(initial.map(s => s.port)).size, 3)
  await until(async () => (await Promise.all([1, 2, 3].map(async id => (await readFile(join(directory(id), 'backend.log'), 'utf8')).includes('Worker ready')))).every(Boolean), 'Three native OCR workers did not initialize')
  pass('three independent backends and native OCR workers')

  for (const id of [1, 2, 3]) {
    await machine(id, `window.__backgroundTicks = 0; window.__backgroundTimer = setInterval(() => window.__backgroundTicks++, 100); true`)
  }
  await capture('02-tabs-expanded.png')
  await shell.getByRole('button', { name: '收起机器切换栏' }).click()
  await shell.getByRole('button', { name: '展开机器切换栏' }).waitFor()
  await capture('03-tabs-hidden.png')
  await shell.getByRole('button', { name: '展开机器切换栏' }).click()
  await shell.getByRole('button', { name: '切换到机器 2' }).click()
  await shell.getByRole('button', { name: '切换到机器 1' }).click()
  pass('hide, reveal and switch without reloading machines')

  function response(socket, predicate, timeout = 20000) {
    return new Promise((resolveResponse, reject) => {
      let lastText = ''
      const timer = setTimeout(() => { socket.off('message', listener); reject(new Error('OCR/control response timed out; last OCR text: ' + lastText)) }, timeout)
      const listener = raw => {
        let msg; try { msg = JSON.parse(raw) } catch { return }
        if (msg.type === 'BARRAGE_CURRENT_TEXT') lastText = msg.data.text
        if (!predicate(msg)) return
        clearTimeout(timer); socket.off('message', listener); resolveResponse(msg)
      }
      socket.on('message', listener)
    })
  }
  for (const backend of initial) {
    const socket = new WebSocket(`ws://127.0.0.1:${backend.port}`)
    sockets.push(socket)
    await new Promise((resolveOpen, reject) => { socket.once('open', resolveOpen); socket.once('error', reject) })
    const saved = response(socket, msg => msg.type === 'BARRAGE_CONFIG_SAVED' && msg.data.mode === 'mp3')
    socket.send(JSON.stringify({ type: 'SET_BARRAGE_CONFIG', data: { mode: 'mp3', cooldown: 3000, scan_interval: 1 } }))
    await saved
    socket.send(JSON.stringify({ type: 'BARRAGE_START', data: { x: 0, y: 0, width: 720, height: 120 } }))
  }
  const svg = await readFile(join(root, 'robot-ui/scripts/fixtures/runtime-ocr.svg'), 'utf8')
  const words = ['12345', '23451', '34512', '45123', '51234']
  async function frame(digit) {
    const positions = [7851, 8990, 10129, 11268, 12407]
    const glyphs = svg.replace(/<path transform="translate\((\d+) 0\)"[^>]*\/>/g, (path, x) => {
      const index = positions.indexOf(Number(x))
      if (index < 0) return path
      const target = positions[(index - (digit - 1) + 5) % 5]
      return path.replace(`translate(${x} 0)`, `translate(${target} 0)`)
    })
    return sharp(Buffer.from(glyphs)).png().toBuffer()
  }
  async function recognizeAll(digits) {
    await Promise.all(sockets.map(async (socket, index) => {
      const png = await frame(digits[index])
      const result = response(socket, msg => msg.type === 'BARRAGE_CURRENT_TEXT' && msg.data.text.replace(/\s/g, '').endsWith(words[digits[index] - 1]))
      const send = () => socket.send(png)
      const timer = setInterval(send, 600)
      try { send(); await result } finally { clearInterval(timer) }
    }))
  }
  await recognizeAll([1, 2, 3])
  pass('three OCR engines recognize different images concurrently, including hidden machines')
  await shell.getByRole('button', { name: '双栏', exact: true }).click()
  await shell.getByLabel('右侧机器').selectOption('3')
  const split = await shell.evaluate(() => window.api.getShellState())
  assert.equal(split.layout, 'split')
  assert.deepEqual(split.panes, [1, 3])
  await recognizeAll([3, 4, 5])
  await capture('04-split-view.png')
  for (const id of [1, 2, 3]) {
    assert.ok(await machine(id, 'window.__backgroundTicks') > 10, `machine ${id} renderer remained active`)
    await machine(id, 'clearInterval(window.__backgroundTimer); true')
    assert.match(await readFile(join(directory(id), 'data/barrage-ocr-log.txt'), 'utf8'), new RegExp(`${words[id + 1]}\\s*(?:$|\\n)`))
  }
  pass('two live panes, background renderer timers and third-machine OCR continue through layout changes')
  for (const socket of sockets) socket.send(JSON.stringify({ type: 'BARRAGE_STOP' }))

  await shell.getByRole('button', { name: '单页', exact: true }).click()
  await shell.getByRole('button', { name: '切换到机器 2' }).click()
  const starts = text => (text.match(/=== backend start/g) || []).length
  const before = await Promise.all([1, 3].map(async id => starts(await readFile(join(directory(id), 'backend.log'), 'utf8'))))
  const machine2Starts = starts(await readFile(join(directory(2), 'backend.log'), 'utf8'))
  await machine(2, `window.api.writePublicEnv({ TTS_VOICE_TYPE: 'machine-2-smoke-only' }).then(() => window.api.restartBackend())`)
  await until(async () => {
    const s = await status(2)
    const restarted = starts(await readFile(join(directory(2), 'backend.log'), 'utf8')) > machine2Starts
    return restarted && s?.running && s.port
  }, 'Machine 2 did not restart')
  assert.equal((await status(1)).port, initial[0].port)
  assert.equal((await status(3)).port, initial[2].port)
  for (const [index, id] of [1, 3].entries()) {
    assert.equal(starts(await readFile(join(directory(id), 'backend.log'), 'utf8')), before[index])
    assert.doesNotMatch(await readFile(join(directory(id), '.env'), 'utf8'), /machine-2-smoke-only/)
  }
  const after = await shell.evaluate(() => window.api.getShellState())
  assert.equal(after.entered, true)
  assert.equal(after.activeMachine, 2)
  assert.equal(await shell.locator('.welcome').count(), 0)
  await shell.reload({ waitUntil: 'domcontentloaded' })
  await shell.locator('.machine-tabs').waitFor()
  assert.equal(await shell.locator('.welcome').count(), 0)
  pass('only selected machine settings/restart change; welcome stays dismissed')
  assert.deepEqual(errors, [])
  report.status = 'passed'
  console.log('[machine-shell] Screenshots: ' + shots)
} catch (error) {
  report.error = error.stack || error.message
  throw error
} finally {
  for (const socket of sockets) socket.terminate()
  if (app) await Promise.race([app.close(), wait(10000).then(() => { app.process().kill('SIGTERM') })])
  await writeFile(join(shots, 'machine-shell-smoke.json'), JSON.stringify(report, null, 2) + '\n')
}
