// Real Electron + utility backends + ffmpeg + three loopback robot endpoints.
// Run after `npm --prefix robot-ui run build`. Only synthetic temporary profiles
// are opened; no provider request, microphone, speaker or real robot is needed.
import { _electron as electron } from 'playwright'
import { WebSocket, WebSocketServer } from 'ws'
import assert from 'node:assert/strict'
import { createHash, randomUUID, scryptSync } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import ffmpeg from 'ffmpeg-static'
import { parse as parseEnv } from 'dotenv'
import { upgradeSmokeOptions } from './machine-upgrade-options.mjs'

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '../..')
const options = upgradeSmokeOptions(process.argv.slice(2))
const workspace = await mkdtemp(join(options.packaged ? process.env.RUNNER_TEMP : tmpdir(), 'miaofei-upgrade-audio-'))
const roaming = join(workspace, 'roaming')
const profile = options.packaged ? join(roaming, 'robot-live-ui') : workspace
const installDirectory = join(workspace, 'installed')
const executable = options.installer ? join(installDirectory, 'robot-live-ui.exe') : options.executable
const output = resolve(options.output || join(root, 'output/machine-upgrade-smoke'))
await mkdir(output, { recursive: true })
const directory = id => id === 1 ? profile : join(profile, 'machines', `machine-${id}`)
const ids = [1, 2, 3]
const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const report = { status: 'failed', platform: process.platform, checks: [], audio: [], installerVerified: false,
  scope: options.installer
    ? 'Real Windows NSIS install and same-build overwrite from tray, synthetic old user profile, installed Electron utility processes and loopback WebSockets; not a physical robot test'
    : options.packaged
      ? 'Packaged Windows Electron, synthetic old user profile, real utility processes and loopback WebSockets; not an installer or physical robot test'
      : 'Built development Electron, real utility processes and loopback WebSockets; not an installer or physical robot test' }
const pass = name => { report.checks.push(name); console.log('[machine-upgrade] PASS ' + name) }
const fixtures = new Map(), endpoints = [], controls = [], preserved = new Map()
let app, shell
async function until(check, message, timeout = 45000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await wait(100)
  }
  throw new Error(message)
}
async function put(id, relative, bytes, preserve = true) {
  const path = join(directory(id), relative)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, bytes)
  if (preserve) preserved.set(path, Buffer.from(bytes))
  return path
}
function runFfmpeg(args) {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...args], { maxBuffer: 8 * 1024 * 1024 })
  assert.equal(result.status, 0, result.stderr?.toString() || result.error?.message)
  return result.stdout
}
function item(id) { return { map_name: `fixture-map-${id}`, path_name: `fixture-route-${id}`, goal_id: id, play_mode: 'mp3' } }
function heartbeat(id, task = {}) {
  return { system: { battery: 100 }, map: { name: item(id).map_name, status: 'ready' }, task }
}
async function simulatedRobot(id) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false })
  await once(server, 'listening')
  const endpoint = { id, server, connections: 0, goals: 0, frames: [], sockets: new Set(), errors: [],
    url: `ws://127.0.0.1:${server.address().port}` }
  server.on('connection', socket => {
    endpoint.connections++
    endpoint.sockets.add(socket)
    const send = payload => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload)) }
    const timer = setInterval(() => send(heartbeat(id)), 300)
    send(heartbeat(id))
    socket.on('close', () => { clearInterval(timer); endpoint.sockets.delete(socket) })
    socket.on('error', error => endpoint.errors.push(error.message))
    socket.on('message', raw => {
      try {
        const message = JSON.parse(raw)
        if (message.audio) {
          const { type, sample, seq, data } = message.audio
          assert.equal(type, 'pcm'); assert.equal(sample, '16')
          assert.ok(Number.isInteger(seq) && seq > 0)
          const bytes = Buffer.from(data, 'base64')
          assert.ok(bytes.length > 0 && bytes.length <= 640 && bytes.length % 2 === 0)
          endpoint.frames.push({ bytes, seq, at: performance.now(), connection: endpoint.connections })
        } else if (message.get_map_list) send({ robot_map_list: [item(id).map_name] })
        else if (message.get_path_list) send({ robot_path_list: [item(id).path_name] })
        else if (message.set_switch_map) {
          assert.equal(message.set_switch_map, item(id).map_name)
          send({ robot_switch_map: 'true' }); send(heartbeat(id))
        } else if (message.set_goal) {
          const goal = message.set_goal
          assert.equal(goal.path_name, item(id).path_name); assert.equal(goal.goal_id, id)
          endpoint.goals++
          send({ robot_goal: { path_file: goal.path_name, goal_id: id, goal_check: 'true', goal_object: goal.goal_object } })
          send(heartbeat(id, { path_file: goal.path_name, goal_id: id, goal_status: 'done' }))
        } else throw new Error('Unexpected robot command: ' + Object.keys(message).join(','))
      } catch (error) { endpoint.errors.push(error.message) }
    })
  })
  return endpoint
}
function machine(id, expression) {
  return app.evaluate(async ({ webContents }, { id, expression }) => {
    const contents = webContents.getAllWebContents().find(w => w.getURL().endsWith(`/machine/${id}`))
    return contents ? contents.executeJavaScript(expression) : null
  }, { id, expression })
}
const status = id => machine(id, 'window.api.getBackendStatus()')
async function connectControl(id) {
  const backend = await until(async () => { const value = await status(id); return value?.running && value.port && value }, `Machine ${id} backend did not start`)
  const socket = new WebSocket(`ws://127.0.0.1:${backend.port}`)
  const control = { id, socket, messages: [], port: backend.port }
  controls.push(control)
  socket.on('message', raw => control.messages.push(JSON.parse(raw)))
  socket.on('error', () => {})
  await once(socket, 'open')
  await until(() => control.messages.find(m => m.type === 'TOUR_STATE'), `Machine ${id} did not provide initial state`)
  return control
}
async function command(control, type, data, replyType, predicate = () => true) {
  const offset = control.messages.length
  control.socket.send(JSON.stringify({ type, data }))
  if (!replyType) return
  return until(() => control.messages.slice(offset).find(message => message.type === replyType && predicate(message.data)), `${type} did not return ${replyType} for machine ${control.id}`)
}
function isolatedEnvironment() {
  // Do not inherit renderer URLs, Node hooks or credentials from the shell.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|PATHEXT|HOME|USERPROFILE|USERNAME|USERDOMAIN|APPDATA|LOCALAPPDATA|PROGRAMDATA|ALLUSERSPROFILE|PUBLIC|PROGRAMFILES(?:\(X86\))?|PROGRAMW6432|COMMONPROGRAMFILES(?:\(X86\))?|COMMONPROGRAMW6432|PROCESSOR_ARCHITECTURE|SYSTEMROOT|WINDIR|COMSPEC|SYSTEMDRIVE|TEMP|TMP|TMPDIR|LANG|LC_.*|DISPLAY|WAYLAND_DISPLAY|XDG_.*)$/i.test(key)))
  if (options.packaged) {
    // Remove case-insensitive duplicates before assigning Windows variables.
    for (const key of Object.keys(env)) if (/^(APPDATA|LOCALAPPDATA)$/i.test(key)) delete env[key]
    env.APPDATA = roaming
    env.LOCALAPPDATA = join(workspace, 'local')
  } else env.MIAOFEI_DEV_PROFILE = profile
  return env
}
async function runInstaller(label) {
  assert.equal(options.packaged, true)
  assert.equal(process.platform, 'win32')
  assert.equal(process.env.GITHUB_ACTIONS, 'true')
  assert.ok((await stat(options.installer)).isFile(), 'NSIS installer is missing')
  // NSIS /D must be last and unquoted. Runner-generated paths contain no spaces;
  // fail rather than accidentally install into the real default destination.
  assert.doesNotMatch(installDirectory, /[\s"]/u, 'NSIS acceptance needs a runner temp path without whitespace')
  const started = Date.now()
  const child = spawn(options.installer, ['/S', `/D=${installDirectory}`], {
    env: isolatedEnvironment(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = '', timeout
  const append = chunk => { log = (log + chunk.toString()).slice(-64000) }
  child.stdout.on('data', append)
  child.stderr.on('data', append)
  try {
    const result = await new Promise((resolveExit, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => resolveExit({ code, signal }))
      timeout = setTimeout(() => {
        // Bound a hung installer and its helper, targeting only this spawned PID.
        if (child.pid) spawnSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true, timeout: 10000 })
        reject(new Error(`${label}: NSIS installer did not finish within 180 seconds`))
      }, 180000)
    })
    report.installer ||= []
    report.installer.push({ label, ...result, elapsedMs: Date.now() - started })
    assert.equal(result.code, 0, `${label}: installer failed closed or failed installation (exit ${result.code}, signal ${result.signal})`)
    assert.ok((await stat(executable)).isFile(), `${label}: requested isolated install directory has no application`)
  } finally {
    clearTimeout(timeout)
    await writeFile(join(output, `installer-${label}.log`), log || '(installer produced no stdout/stderr)\n')
  }
}
async function launch() {
  app = await electron.launch({
    executablePath: executable || require('electron'),
    // Electron 41 PreSandboxStartup maps this switch to chrome::DIR_USER_DATA,
    // the same path returned by app.getPath('userData'). APPDATA alone is not a
    // reliable override for Windows Known Folder APIs.
    args: options.packaged ? [`--user-data-dir=${profile}`] : [join(root, 'robot-ui')],
    env: isolatedEnvironment(), timeout: 60000,
  })
  // Check isolation before any UI/robot command. No packaged test may silently
  // fall back to an actual user profile if Electron changes its path handling.
  const identity = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, userData: app.getPath('userData'), version: app.getVersion() }))
  assert.equal(identity.packaged, options.packaged)
  const expectedUserData = options.packaged ? profile : join(profile, 'electron')
  assert.equal(resolve(identity.userData).toLowerCase(), resolve(expectedUserData).toLowerCase(), 'Electron userData is outside the synthetic profile')
  report.application = { packaged: identity.packaged, version: identity.version, isolatedUserData: true }
  app.context().setDefaultTimeout(15000)
  await app.firstWindow()
  shell = await until(() => app.context().pages().find(page => page.url().endsWith('#/shell')), 'Shell did not load')
  await shell.locator('.welcome-art').waitFor()
  await shell.getByRole('button', { name: '欢迎来到喵飞直播控制系统，点击任意位置进入机器 1' }).click()
  await shell.locator('.machine-tabs').waitFor()
  const result = await Promise.all(ids.map(connectControl))
  assert.equal(new Set(result.map(control => control.port)).size, 3)
  await until(() => endpoints.every(endpoint => endpoint.sockets.size === 1), 'Three independent simulated robot connections did not open')
  return result
}
async function closeApp() {
  for (const control of controls) control.socket.terminate()
  if (!app) return
  const closing = app
  app = null
  let timer
  try {
    await Promise.race([closing.close(), new Promise((_, reject) => {
      timer = setTimeout(() => { closing.process().kill('SIGKILL'); reject(new Error('Electron shutdown timed out')) }, 10000)
    })])
  } finally { clearTimeout(timer) }
}
async function captureControls() {
  await machine(1, `(() => {
    const tab = [...document.querySelectorAll('.tab-btn')].find(button => button.textContent.includes('播报控制'));
    if (!tab) throw new Error('Controls tab is missing');
    tab.click();
    return true;
  })()`)
  await until(() => machine(1, `(() => {
    const card = document.querySelector('.stationary-card');
    return !!card && card.getBoundingClientRect().height > 0;
  })()`), 'Freshly built Controls card did not render')
  await machine(1, `document.querySelector('.stationary-card').scrollIntoView({ block: 'center' }); true`)
  await wait(200)
  const images = await app.evaluate(async ({ webContents }) => {
    const contents = webContents.getAllWebContents().find(view => view.getURL().endsWith('/machine/1'))
    const rect = await contents.executeJavaScript(`(() => {
      const rect = document.querySelector('.stationary-card').getBoundingClientRect();
      return { x: Math.floor(rect.x), y: Math.floor(rect.y), width: Math.ceil(rect.width), height: Math.ceil(rect.height) };
    })()`)
    return {
      controls: (await contents.capturePage()).toPNG().toString('base64'),
      card: (await contents.capturePage(rect)).toPNG().toString('base64'),
    }
  })
  await writeFile(join(output, '01-controls.png'), Buffer.from(images.controls, 'base64'))
  await writeFile(join(output, '02-stationary-card.png'), Buffer.from(images.card, 'base64'))
  report.screenshots = ['01-controls.png', '02-stationary-card.png']
}
async function assertPreserved() {
  for (const [path, bytes] of preserved) assert.ok((await readFile(path)).equals(bytes), `Changed synthetic user file: ${path.slice(profile.length + 1)}`)
}
async function owner(id) {
  const parent = join(directory(id), 'data/robot-pcm-cache')
  const names = (await readdir(parent)).filter(name => /^run-\d+-[a-f0-9-]{36}$/.test(name))
  const owners = await Promise.all(names.map(async name => ({ ...JSON.parse(await readFile(join(parent, name, 'owner.json'), 'utf8')), directory: join(parent, name) })))
  return owners.filter(value => { try { process.kill(value.pid, 0); return true } catch { return false } })
}
async function startPoint(control) {
  const output = await command(control, 'GET_AUDIO_OUTPUT_CONFIG', {}, 'AUDIO_OUTPUT_CONFIG')
  assert.equal(output.data.destination, 'robot', 'Only robot output may be started by this test')
  assert.equal(output.data.robotConnected, true)
  await command(control, 'SELECT_MAP', { map_name: item(control.id).map_name }, 'PATH_LIST')
  await command(control, 'START_TOUR', { repeatCount: 1 }, 'TOUR_STARTED')
}
function verifyFrames(id, start, complete = false, label = '') {
  const frames = endpoints[id - 1].frames.slice(start)
  assert.ok(frames.length > 0, `Machine ${id} sent no PCM`)
  frames.forEach((frame, index) => assert.equal(frame.seq, index + 1, `Machine ${id} frame sequence`))
  const actual = Buffer.concat(frames.map(frame => frame.bytes)), expected = fixtures.get(id).pcm
  assert.ok(actual.equals(expected.subarray(0, actual.length)), `Machine ${id} PCM differs from its decoded MP3`)
  if (complete) assert.equal(actual.length, expected.length, `Machine ${id} PCM is truncated`)
  const maxGapMs = frames.slice(1).reduce((max, frame, index) => Math.max(max, frame.at - frames[index].at), 0)
  // This is a broad interruption bound, not a hardware audibility assertion.
  // Keep measured packet gaps in the report for later robot-side comparison.
  assert.ok(maxGapMs < 1000, `Machine ${id} PCM stalled for ${Math.round(maxGapMs)} ms`)
  report.audio.push({ machine: id, label, complete, frames: frames.length, bytes: actual.length, sha256: digest(actual), maxGapMs: Math.round(maxGapMs) })
}
async function assertQuiet(current) {
  const before = endpoints.map(endpoint => [endpoint.frames.length, endpoint.goals])
  for (const control of current) {
    const state = await command(control, 'GET_TOUR_STATE', {}, 'TOUR_STATE')
    assert.equal(state.data.running, false)
  }
  await wait(450)
  assert.deepEqual(endpoints.map(endpoint => [endpoint.frames.length, endpoint.goals]), before, 'Opening/restarting automatically triggered navigation or audio')
}
async function overwriteFromTray() {
  const old = app
  const metrics = await old.evaluate(({ app }) => app.getAppMetrics())
  const pids = new Set([old.process().pid, ...metrics.map(metric => metric.pid)])
  const hidden = await old.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('/shell'))
    window.close() // Exercise the real close-to-tray handler, not a mock hide.
    return !window.isDestroyed() && !window.isVisible()
  })
  assert.equal(hidden, true, 'Closing the application must leave it running in the tray')
  for (const id of ids) assert.equal((await status(id)).running, true, `Machine ${id} was not alive in the tray`)
  await runInstaller('overwrite-from-tray')
  await until(() => [...pids].every(pid => {
    try { process.kill(pid, 0); return false } catch (error) { return error.code === 'ESRCH' }
  }), 'Installer returned success before the old application and its processes exited', 15000)
  app = null // The installer, rather than the harness, closed this Electron run.
  for (const control of controls) control.socket.terminate()
  await until(() => endpoints.every(endpoint => endpoint.sockets.size === 0), 'Old robot connections survived the installer')
  await assertPreserved()
  pass('silent NSIS overwrite closes the tray application and its backends before replacing files, preserving all synthetic user data')
}

try {
  await mkdir(profile, { recursive: true })
  if (options.packaged) await mkdir(join(workspace, 'local'), { recursive: true })
  for (const id of ids) endpoints.push(await simulatedRobot(id))
  for (const id of ids) {
    const path = join(profile, `source-${id}.mp3`)
    // Machine 2 needs enough material to remain active through slower CI UI
    // clicks; the long sibling clips span both restart and crash recovery.
    runFfmpeg(['-f', 'lavfi', '-i', `sine=frequency=${[401, 607, 809][id - 1]}:sample_rate=44100:duration=${id === 2 ? 8 : 32}`, '-c:a', 'libmp3lame', '-b:a', '64k', path])
    const pcm = runFfmpeg(['-nostdin', '-i', path, '-vn', '-f', 's16le', '-acodec', 'pcm_s16le', '-ac', '1', '-ar', '16000', 'pipe:1'])
    assert.ok(pcm.some(byte => byte !== 0), 'Fixture must contain audible-content PCM, without playing it')
    fixtures.set(id, { path, mp3: await readFile(path), pcm })
  }
  assert.equal(new Set(ids.map(id => digest(fixtures.get(id).pcm))).size, 3)
  const legacyEnv = `# Synthetic old installation only\r\nKB_PROVIDER=flatfile\r\nROBOT_URL=${endpoints[0].url}\r\nNGROK_AUTHTOKEN=\r\nTTS_API_KEY=synthetic-upgrade-key-1\r\nTTS_VOICE_TYPE=synthetic-voice-1\r\nDOUBAO_API_KEY=synthetic-llm-key-1\r\nBARRAGE_TTS_API_KEY=synthetic-barrage-key-1\r\n`
  await put(1, '.env', legacyEnv, false)
  const salt = 'synthetic-acceptance-salt'
  await put(1, 'config/admin.json', JSON.stringify({ salt, hash: scryptSync('synthetic-password', salt, 32).toString('hex') }))
  for (const file of ['banned-words', 'llm-system-prompt', 'barrage-prompt-name', 'barrage-prompt-general']) await put(1, `config/${file}.txt`, `旧安装合成脚本：${file}\r\n`)
  await put(1, 'data/tour-list.json', JSON.stringify([item(1)], null, 2) + '\r\n')
  await put(1, 'data/flatfiles/fixture-map-1/fixture-route-1/1.json', '{ "body": "机器一旧点位讲稿，升级保留。" }\r\n')
  await put(1, 'data/cruising-audio/fixture-map-1/fixture-route-1/1/owned.mp3', fixtures.get(1).mp3)
  await put(1, 'data/tts-cache/legacy-library.mp3', fixtures.get(1).mp3)
  await put(1, 'data/tts-cache/legacy-library.txt', '用户已保存的合成语音库；不是临时 PCM 缓存。\r\n')
  await put(1, 'data/barrage-knowledge/concepts/legacy.json', JSON.stringify({ name: 'legacy', keywords: ['fixture'], replies: ['仅保留，不触发'] }))
  await put(1, 'data/audio-output.json', JSON.stringify({ destination: 'robot', robotVolumePercent: 100 }))
  await put(1, 'data/robot-pcm-cache/owner.json', JSON.stringify({ kind: 'robot-pcm-cache-v1', pid: process.pid, nonce: randomUUID() }))
  await put(1, `data/robot-pcm-cache/pcm-${randomUUID()}.pcm`, 'legacy root PCM stays untouched')
  for (const id of [2, 3]) {
    // Only loopback connection settings exist; all user-content directories are
    // absent until the real runtime seeds its clean first-install defaults.
    await put(id, '.env', `KB_PROVIDER=flatfile\nSPEECH_PROFILES_VERSION=1\nROBOT_URL=${endpoints[id - 1].url}\nNGROK_AUTHTOKEN=\n`)
    await assert.rejects(readdir(join(directory(id), 'data')), { code: 'ENOENT' })
  }
  if (options.installer) await runInstaller('initial')
  let current = await launch()
  await assertPreserved()
  const migrated = parseEnv(await readFile(join(profile, '.env')))
  for (const [key, value] of Object.entries(parseEnv(legacyEnv))) assert.equal(migrated[key], value, `Legacy setting ${key} changed`)
  assert.equal(migrated.TRANSIT_TTS_API_KEY, migrated.TTS_API_KEY)
  assert.equal(migrated.BARRAGE_TTS_API_KEY, 'synthetic-barrage-key-1')
  assert.equal(migrated.SPEECH_PROFILES_VERSION, '1')
  preserved.set(join(profile, '.env'), await readFile(join(profile, '.env')))
  assert.equal(await machine(1, 'window.api.adminHasPassword()'), true)
  assert.equal((await machine(1, `window.api.readSensitiveEnv('synthetic-password')`)).env.TTS_API_KEY, 'synthetic-upgrade-key-1')
  for (const id of [2, 3]) {
    assert.equal(await machine(id, 'window.api.adminHasPassword()'), false)
    assert.deepEqual((await command(current[id - 1], 'GET_TOUR_LIST', {}, 'TOUR_LIST')).data.items, [])
    assert.deepEqual((await command(current[id - 1], 'GET_KB_MAPS', {}, 'KB_MAPS')).data.maps, [])
    assert.deepEqual((await command(current[id - 1], 'GET_TTS_CACHE_LIST', {}, 'TTS_CACHE_LIST')).data.items, [])
    assert.equal((await command(current[id - 1], 'GET_AUDIO_OUTPUT_CONFIG', {}, 'AUDIO_OUTPUT_CONFIG')).data.destination, 'local')
    assert.ok(!Object.values(parseEnv(await readFile(join(directory(id), '.env')))).some(value => value.includes('synthetic-upgrade-key-1')))
  }
  await assertQuiet(current)
  pass('old credentials, admin, points, scripts and MP3 library survive; machines 2/3 begin empty; startup is idle')
  await captureControls()

  for (const id of [2, 3]) {
    const control = current[id - 1], point = item(id)
    await command(control, 'SAVE_KB_ENTRY', { ...point, body: `机器 ${id} 自己的讲稿` }, 'KB_ENTRY_SAVED')
    await command(control, 'UPLOAD_CRUISING_AUDIO', { ...point, filePaths: [fixtures.get(id).path] }, 'CRUISING_AUDIO_FILES_UPDATED')
    await command(control, 'SET_TOUR_LIST', { items: [point] }, 'TOUR_LIST_CHANGED')
    await command(control, 'SET_AUDIO_OUTPUT_CONFIG', { destination: 'robot', robotVolumePercent: 100 }, 'AUDIO_OUTPUT_CONFIG')
    for (const path of ['data/tour-list.json', `data/flatfiles/${point.map_name}/${point.path_name}/${id}.json`, `data/cruising-audio/${point.map_name}/${point.path_name}/${id}/source-${id}.mp3`, 'data/audio-output.json']) {
      preserved.set(join(directory(id), path), await readFile(join(directory(id), path)))
    }
    await put(id, `data/tts-cache/machine-${id}.mp3`, fixtures.get(id).mp3)
    await put(id, `data/tts-cache/machine-${id}.txt`, `只属于机器 ${id} 的语音库`)
  }
  await put(2, 'data/robot-pcm-cache/owner.json', '{interrupted old owner')
  await put(2, `data/robot-pcm-cache/pcm-${randomUUID()}.pcm`, 'malformed legacy owner does not authorize deletion')
  const initialPorts = current.map(control => control.port)
  const siblingConnections = [endpoints[0].connections, endpoints[2].connections]
  await Promise.all(current.map(startPoint))
  await until(() => endpoints.every(endpoint => endpoint.frames.length >= 20), 'Three different robots did not receive PCM')
  await shell.getByRole('button', { name: '收起机器切换栏' }).click()
  await shell.getByRole('button', { name: '展开机器切换栏' }).click()
  await shell.getByRole('button', { name: '切换到机器 2' }).click()
  await shell.getByRole('button', { name: '双栏', exact: true }).click()
  await shell.getByLabel('右侧机器').selectOption('3')
  const split = await shell.evaluate(() => window.api.getShellState())
  assert.equal(split.layout, 'split')
  const beforeLayout = endpoints.map(endpoint => endpoint.frames.length)
  await until(() => endpoints.every((endpoint, index) => endpoint.frames.length > beforeLayout[index] + 5), 'Hiding/switching/splitting stalled PCM')
  pass('three different real MP3s keep sending PCM through hidden tabs and split view')

  const beforeRestart = endpoints.map(endpoint => endpoint.frames.length)
  const oldOwners = await owner(2)
  assert.equal(oldOwners.length, 1)
  const connectionCountBeforeSave = endpoints[1].connections
  const environmentBeforeSave = parseEnv(await readFile(join(directory(2), '.env')))
  current[1].socket.terminate()
  const repeatedSave = await machine(2, `(async () => {
    const saves = [], restarts = [];
    saves.push(await window.api.writePublicEnv({ TTS_VOICE_TYPE: 'machine-2-save-first' }));
    // Keep restart promises pending while later real settings saves arrive.
    restarts.push(window.api.restartBackend(), window.api.restartBackend());
    saves.push(await window.api.writePublicEnv({ TTS_VOICE_TYPE: 'machine-2-save-second' }));
    restarts.push(window.api.restartBackend(), window.api.restartBackend());
    saves.push(await window.api.writePublicEnv({ TTS_VOICE_TYPE: 'machine-2-save-final' }));
    restarts.push(window.api.restartBackend(), window.api.restartBackend());
    return { saves, restarts: await Promise.all(restarts), settings: await window.api.readPublicEnv() };
  })()`)
  assert.equal(repeatedSave.saves.length, 3)
  assert.equal(repeatedSave.restarts.length, 6)
  for (const result of [...repeatedSave.saves, ...repeatedSave.restarts]) assert.equal(result.ok, true, result.error)
  assert.equal(repeatedSave.settings.env.TTS_VOICE_TYPE, 'machine-2-save-final')
  const environmentAfterSave = parseEnv(await readFile(join(directory(2), '.env')))
  assert.deepEqual(environmentAfterSave, { ...environmentBeforeSave, TTS_VOICE_TYPE: 'machine-2-save-final' })
  preserved.set(join(directory(2), '.env'), await readFile(join(directory(2), '.env')))
  await until(() => endpoints[1].connections >= connectionCountBeforeSave + 1, 'Machine 2 repeated saves did not reconnect its robot')
  current[1] = await connectControl(2)
  await wait(600)
  assert.equal(endpoints[1].connections, connectionCountBeforeSave + 1, 'Concurrent restart requests spawned more than one replacement connection')
  assert.equal(endpoints[1].sockets.size, 1, 'Only one machine 2 robot connection may remain')
  const replacementOwners = await owner(2)
  assert.equal(replacementOwners.length, 1, 'Only one machine 2 backend may remain after repeated saves')
  assert.notEqual(replacementOwners[0].pid, oldOwners[0].pid)
  const afterSaveMetrics = await app.evaluate(({ app }) => app.getAppMetrics())
  assert.equal(afterSaveMetrics.some(metric => metric.pid === oldOwners[0].pid), false, 'Old backend survived replacement')
  assert.ok(afterSaveMetrics.some(metric => metric.pid === replacementOwners[0].pid && metric.type === 'Utility'))
  report.repeatedSave = { saves: 3, concurrentRestartRequests: 6, replacementConnections: 1, liveMachineBackends: 1, finalVoice: environmentAfterSave.TTS_VOICE_TYPE }
  verifyFrames(2, 0, false, 'before isolated restart')
  const secondStart = endpoints[1].frames.length
  await startPoint(current[1])
  await until(() => endpoints[1].frames.length >= secondStart + 20, 'Machine 2 did not resume MP3 after restart')
  for (const id of [1, 3]) {
    assert.equal((await status(id)).port, initialPorts[id - 1])
    assert.ok(endpoints[id - 1].frames.length > beforeRestart[id - 1] + 10, `Machine ${id} stopped while machine 2 restarted`)
  }
  assert.deepEqual([endpoints[0].connections, endpoints[2].connections], siblingConnections)
  await assertPreserved()
  pass('three machine 2 saves and six overlapping restarts retain the last settings and one replacement backend; machine 1/3 PCM continues')

  const activeOwners = await owner(2)
  assert.equal(activeOwners.length, 1, 'Only the current synthetic machine 2 cache owner may be crashed')
  const crashed = activeOwners[0]
  assert.equal(crashed.kind, 'robot-pcm-cache-v1')
  assert.notEqual(crashed.pid, process.pid)
  // Verify ownership against Electron's utility-process inventory before kill.
  const metrics = await app.evaluate(({ app }) => app.getAppMetrics())
  assert.ok(metrics.some(metric => metric.pid === crashed.pid && metric.type === 'Utility'), 'Refusing to kill a PID outside this Electron instance')
  const beforeCrash = endpoints.map(endpoint => endpoint.frames.length)
  process.kill(crashed.pid, 'SIGKILL')
  await until(async () => (await status(2))?.running === false, 'Machine 2 crash was not observed')
  verifyFrames(2, secondStart, false, 'before forced crash')
  current[1].socket.terminate()
  assert.equal((await machine(2, 'window.api.restartBackend()')).ok, true)
  await until(() => endpoints[1].connections >= 3, 'Machine 2 did not recover after crash')
  current[1] = await connectControl(2)
  assert.equal((await command(current[1], 'GET_TOUR_STATE', {}, 'TOUR_STATE')).data.running, false)
  await assert.rejects(readdir(crashed.directory), { code: 'ENOENT' })
  const recoveredStart = endpoints[1].frames.length
  const recoveredGoals = endpoints[1].goals
  await wait(450)
  assert.equal(endpoints[1].frames.length, recoveredStart, 'Crash recovery automatically played audio')
  assert.equal(endpoints[1].goals, recoveredGoals, 'Crash recovery automatically navigated')
  await startPoint(current[1])
  await until(() => current[1].messages.some(message => message.type === 'TOUR_FINISHED'), 'Recovered machine 2 MP3 did not finish')
  verifyFrames(2, recoveredStart, true, 'after crash recovery')
  for (const id of [1, 3]) assert.ok(endpoints[id - 1].frames.length > beforeCrash[id - 1] + 10, `Machine ${id} stopped during machine 2 crash recovery`)
  assert.deepEqual([endpoints[0].connections, endpoints[2].connections], siblingConnections)
  pass('crashed machine 2 reports exit, reclaims its abandoned run, stays idle and then plays complete PCM; siblings continue')

  await until(() => [current[0], current[2]].every(control => control.messages.some(message => message.type === 'TOUR_FINISHED')), 'Machines 1/3 did not finish complete audio', 40000)
  for (const id of [1, 3]) verifyFrames(id, 0, true, 'uninterrupted across layout/restart/crash')
  for (const endpoint of endpoints) assert.deepEqual(endpoint.errors, [])
  await assertPreserved()
  pass('all three endpoints receive their own complete, non-silent, byte-exact 16 kHz PCM; legacy owner files are untouched')

  if (options.installer) await overwriteFromTray()
  else await closeApp()
  current = await launch()
  await assertQuiet(current)
  await assertPreserved()
  for (const id of ids) {
    assert.deepEqual((await command(current[id - 1], 'GET_TOUR_LIST', {}, 'TOUR_LIST')).data.items, [item(id)])
    const library = (await command(current[id - 1], 'GET_TTS_CACHE_LIST', {}, 'TTS_CACHE_LIST')).data.items
    assert.deepEqual(library.map(entry => entry.hash), [id === 1 ? 'legacy-library' : `machine-${id}`])
  }
  if (options.installer) report.installerVerified = true
  pass('reopening preserves each machine’s own data and library without automatic navigation or playback')
  report.status = 'passed'
} catch (error) {
  report.error = error.stack || error.message
  process.exitCode = 1
  console.error('[machine-upgrade] ' + report.error)
} finally {
  try { await closeApp() } catch (error) { report.status = 'failed'; report.shutdownError = error.message; process.exitCode = 1 }
  for (const endpoint of endpoints) {
    for (const socket of endpoint.sockets) socket.terminate()
    await new Promise(resolveClose => endpoint.server.close(resolveClose))
  }
  // Retain only bounded diagnostic evidence, never the synthetic credentials.
  for (const id of ids) {
    try { await writeFile(join(output, `machine-${id}-backend.log`), await readFile(join(directory(id), 'backend.log'))) } catch {}
  }
  await writeFile(join(output, 'machine-upgrade-smoke.json'), JSON.stringify(report, null, 2) + '\n')
  await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  console.log('[machine-upgrade] Report: ' + join(output, 'machine-upgrade-smoke.json'))
}
