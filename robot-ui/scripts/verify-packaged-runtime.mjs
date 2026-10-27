#!/usr/bin/env node
/**
 * Execute with the exact installed/unpacked app binary (not system Node).
 * Windows GUI executables require Start-Process -Wait -PassThru before reading
 * their exit code/report; the full quoted invocation is in windows-package.yml.
 * Arguments: <this script> --backend-root <resources/backend> --report <json>.
 * The launcher sets ELECTRON_RUN_AS_NODE=1 only for the check process.
 *
 * Never starts the backend, contacts providers/robots, captures screens or plays
 * audio. --local-preflight cannot produce a release-passing report.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, open, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const SYNTHETIC_TEXT = 'ROBOT 12345'
export const MODEL_FILES = Object.freeze([
  'PP-OCRv6_medium_det.onnx', 'PP-OCRv6_medium_rec.onnx', 'ppocrv6_dict.txt',
])
export const FIXTURE_PATH = fileURLToPath(new URL('./fixtures/runtime-ocr.svg', import.meta.url))
const AUDIO_CADENCE_FRAME_COUNT = 500
const AUDIO_CADENCE_FRAME_MS = 20
const AUDIO_CADENCE_MAX_DRIFT_RATIO = 0.1

export function summarizeAudioSendCadence({ startedAt, finishedAt, sendTimes, deadlineLatenessMs,
  earlyWakeups = 0, cpuUserMicros = 0, cpuSystemMicros = 0 }) {
  assert.ok(Number.isFinite(startedAt) && Number.isFinite(finishedAt) && finishedAt > startedAt,
    'Audio cadence requires a finite, positive measurement interval')
  assert.equal(sendTimes.length, AUDIO_CADENCE_FRAME_COUNT, 'Audio cadence must measure all 500 frames')
  assert.equal(deadlineLatenessMs.length, sendTimes.length, 'Audio cadence is missing deadline measurements')
  assert.ok(sendTimes.every((time, index) => Number.isFinite(time) && time >= startedAt
    && time <= finishedAt && (!index || time > sendTimes[index - 1])), 'Audio cadence timestamps must increase')
  assert.ok(deadlineLatenessMs.every(value => Number.isFinite(value) && value >= 0),
    'Audio cadence must not record a frame before its nominal deadline')
  const intervals = sendTimes.slice(1).map((time, index) => time - sendTimes[index])
  const sorted = [...intervals].sort((a, b) => a - b)
  const percentile = fraction => sorted[Math.ceil(sorted.length * fraction) - 1]
  const elapsedMs = finishedAt - startedAt
  const targetElapsedMs = AUDIO_CADENCE_FRAME_COUNT * AUDIO_CADENCE_FRAME_MS
  const cpuMs = (cpuUserMicros + cpuSystemMicros) / 1000
  return {
    measurement: 'real-runtime-timers-without-robot-or-network',
    frameCount: sendTimes.length, targetFrameMs: AUDIO_CADENCE_FRAME_MS, targetElapsedMs, elapsedMs,
    driftMs: elapsedMs - targetElapsedMs, driftRatio: (elapsedMs - targetElapsedMs) / targetElapsedMs,
    averageIntervalMs: (sendTimes.at(-1) - sendTimes[0]) / intervals.length,
    minIntervalMs: sorted[0], p95IntervalMs: percentile(0.95), p99IntervalMs: percentile(0.99),
    maxIntervalMs: sorted.at(-1), finalDrainMs: finishedAt - sendTimes.at(-1),
    maxCumulativeDriftMs: Math.max(...sendTimes.map((time, index) => time - startedAt - index * AUDIO_CADENCE_FRAME_MS)),
    partialOverrunFrames: deadlineLatenessMs.filter(value => value > 0 && value < AUDIO_CADENCE_FRAME_MS).length,
    wholeFrameOverruns: deadlineLatenessMs.filter(value => value >= AUDIO_CADENCE_FRAME_MS).length,
    maxDeadlineLatenessMs: Math.max(...deadlineLatenessMs), earlyWakeups,
    cpuMs, cpuPercentOfOneCore: cpuMs / elapsedMs * 100,
  }
}

export function assertAudioSendCadence(measurement, maxPacingCorrectionMs) {
  const details = summarizeAudioSendCadence(measurement)
  try {
    assert.ok(Number.isFinite(maxPacingCorrectionMs) && maxPacingCorrectionMs >= 0
      && maxPacingCorrectionMs < AUDIO_CADENCE_FRAME_MS, 'Invalid packaged audio pacing correction')
    assert.ok(details.minIntervalMs >= AUDIO_CADENCE_FRAME_MS - maxPacingCorrectionMs,
      'Audio cadence compressed frames below the production wire spacing')
    assert.ok(details.finalDrainMs >= AUDIO_CADENCE_FRAME_MS, 'Audio cadence shortened the final frame drain')
    assert.ok(details.elapsedMs >= details.targetElapsedMs, 'Audio cadence ran ahead of the PCM sample clock')
    assert.ok(details.driftRatio <= AUDIO_CADENCE_MAX_DRIFT_RATIO,
      `Audio cadence is too slow: ${details.elapsedMs.toFixed(1)} ms for ${details.targetElapsedMs} ms of PCM; average interval ${details.averageIntervalMs.toFixed(2)} ms`)
  } catch (error) {
    error.audioCadence = details
    throw error
  }
  return details
}

export async function checkAudioSendCadence(policy) {
  const { AUDIO_SEND_POLICY, nextAudioFrameDeadline, audioFrameWireDeadline, scheduleAudioFrame } = policy
  for (const helper of [nextAudioFrameDeadline, audioFrameWireDeadline, scheduleAudioFrame]) {
    assert.equal(typeof helper, 'function', 'Packaged audio scheduling helper is missing')
  }
  const sendTimes = [], deadlineLatenessMs = []
  let earlyWakeups = 0, finishedAt
  const cpuStarted = process.cpuUsage()
  const startedAt = performance.now()
  await new Promise((resolvePromise, reject) => {
    let deadline = startedAt, wireDeadline = 0, timer, terminal = false
    const finish = error => {
      if (terminal) return
      terminal = true
      clearTimeout(timer)
      clearTimeout(watchdog)
      if (error) reject(error)
      else resolvePromise()
    }
    const watchdog = setTimeout(() => finish(new Error('Packaged audio cadence measurement exceeded 30 seconds')), 30000)
    const arm = () => { timer = scheduleAudioFrame(tick, { deadline, wireDeadline }) }
    const tick = () => {
      if (terminal) return
      try {
        const sentAt = performance.now()
        // Match the sender's guard: a timer wakeup is not permission to send
        // before either the nominal sample clock or the wire-spacing deadline.
        if (sentAt < Math.max(deadline, wireDeadline)) { earlyWakeups++; arm(); return }
        if (sendTimes.length === AUDIO_CADENCE_FRAME_COUNT) {
          finishedAt = sentAt
          finish()
          return
        }
        sendTimes.push(sentAt)
        deadlineLatenessMs.push(sentAt - deadline)
        deadline = nextAudioFrameDeadline(deadline, sentAt, AUDIO_CADENCE_FRAME_MS)
        wireDeadline = audioFrameWireDeadline(sentAt, AUDIO_CADENCE_FRAME_MS,
          sendTimes.length === AUDIO_CADENCE_FRAME_COUNT)
        arm()
      } catch (error) { finish(error) }
    }
    try { arm() } catch (error) { finish(error) }
  })
  const cpu = process.cpuUsage(cpuStarted)
  return assertAudioSendCadence({ startedAt, finishedAt, sendTimes, deadlineLatenessMs, earlyWakeups,
    cpuUserMicros: cpu.user, cpuSystemMicros: cpu.system }, AUDIO_SEND_POLICY?.maxPacingCorrectionMs)
}

export function parseArguments(argv) {
  const options = { localPreflight: false }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--local-preflight') options.localPreflight = true
    else if (arg === '--backend-root' || arg === '--report') {
      const value = argv[++index]
      if (!value || value.startsWith('--')) throw new Error('Missing value for ' + arg)
      options[arg === '--backend-root' ? 'backendRoot' : 'reportPath'] = resolve(value)
    } else throw new Error('Unknown argument: ' + arg)
  }
  if (!options.backendRoot) throw new Error('--backend-root is required')
  if (!options.reportPath) throw new Error('--report is required')
  return options
}

export function assertContained(root, candidate, label = 'Native dependency') {
  const child = relative(resolve(root), resolve(candidate))
  if (!child || child === '..' || child.startsWith('..' + sep) || isAbsolute(child)) {
    throw new Error(label + ' resolved outside the exact packaged dependency tree')
  }
  return child.split(sep).join('/')
}

export function validateRuntime({ platform, arch, electron }, localPreflight = false) {
  if (localPreflight) return { releaseQualified: false, reason: 'Explicit local preflight; Windows packaged runtime remains unverified' }
  if (platform !== 'win32') throw new Error('Release verification requires the packaged Windows executable')
  if (!electron) throw new Error('Release verification requires Electron via ELECTRON_RUN_AS_NODE=1, not system Node')
  if (arch && arch !== 'x64') throw new Error('This release verification requires the Windows x64 application')
  return { releaseQualified: true }
}

export function normalizedOcrText(text) {
  return String(text || '').normalize('NFKC').replace(/\s+/g, '').toUpperCase()
}

export function assertRecognition(result) {
  if (!result || normalizedOcrText(result.text) !== normalizedOcrText(SYNTHETIC_TEXT)) {
    throw new Error('Synthetic OCR did not recognize the deterministic test phrase')
  }
  if (!Number.isFinite(result.score) || result.score < 0.65) throw new Error('Synthetic OCR confidence is below 0.65')
  return { recognitionMatched: true, confidence: result.score, boxCount: result.boxes }
}

export function assertPcm16Mono(buffer, { samples = 3200, rate = 16000, frequency = 997 } = {}) {
  assert.equal(buffer.length, samples * 2, 'Decoded PCM must contain exactly the requested 16-bit mono sample count')
  let power = 0, crossings = 0
  for (let index = 0; index < samples; index++) {
    const sample = buffer.readInt16LE(index * 2)
    power += sample * sample
    if (index && sample >= 0 && buffer.readInt16LE((index - 1) * 2) < 0) crossings++
  }
  const rms = Math.sqrt(power / samples)
  const detectedFrequency = crossings * rate / samples
  assert.ok(rms > 100, 'Decoded synthetic tone must not be silence')
  assert.ok(Math.abs(detectedFrequency - frequency) < 40, 'PCM frequency does not match the 16 kHz sample clock')
  return { sampleRate: rate, channels: 1, sampleBytes: 2, samples, bytes: buffer.length, rms, detectedFrequency }
}

export async function runCommand(executable, args, { input, timeoutMs = 30000, maxBytes = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const stdout = [], stderr = []
    let bytes = 0, terminal = false
    const finish = (error, result) => {
      if (terminal) return
      terminal = true
      clearTimeout(timer)
      if (error) { try { child.kill('SIGKILL') } catch {}; reject(error) }
      else resolvePromise(result)
    }
    const collect = list => chunk => {
      bytes += chunk.length
      if (bytes > maxBytes) { finish(new Error('Native tool produced excessive output')); return }
      list.push(chunk)
    }
    const timer = setTimeout(() => finish(new Error('Native tool timed out')), timeoutMs)
    timer.unref?.()
    child.stdout.on('data', collect(stdout))
    child.stderr.on('data', collect(stderr))
    child.once('error', error => finish(error))
    child.once('close', (code, signal) => {
      const errorText = Buffer.concat(stderr).toString('utf8').slice(-2048)
      if (code !== 0) finish(new Error('Native tool failed (' + code + ', ' + (signal || 'no signal') + '): ' + errorText))
      else finish(null, { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) })
    })
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') finish(error) })
    child.stdin.end(input)
  })
}

export async function checkFfmpeg(executable) {
  const directory = await mkdtemp(join(tmpdir(), 'robot-packaged-native-'))
  try {
    const version = await runCommand(executable, ['-version'])
    assert.match(version.stdout.toString('utf8'), /^ffmpeg version /, 'Packaged decoder did not identify as ffmpeg')
    const mp3 = join(directory, 'synthetic.mp3')
    // A seekable MP3 preserves encoder-delay/end-padding metadata. The fixture
    // begins as stereo48kHz so downmixing and resampling are genuinely exercised.
    await runCommand(executable, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
      '-i', 'sine=frequency=997:sample_rate=48000:duration=0.2', '-ac', '2', '-c:a', 'libmp3lame', '-y', mp3])
    const decoded = await runCommand(executable, ['-hide_banner', '-loglevel', 'error', '-nostdin',
      '-i', mp3, '-vn', '-acodec', 'pcm_s16le', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'])
    return { version: version.stdout.toString('utf8').split(/\r?\n/)[0], ...assertPcm16Mono(decoded.stdout) }
  } finally { await rm(directory, { recursive: true, force: true }) }
}

async function importPackaged(root, relativePath) {
  const path = await realpath(join(root, relativePath))
  assertContained(root, path, 'Packaged source')
  return import(pathToFileURL(path).href)
}

async function directOcr(root, image, sharp, ort) {
  const sessions = []
  try {
    const options = { executionProviders: ['cpu'], intraOpNumThreads: 2, interOpNumThreads: 1 }
    const det = await ort.InferenceSession.create(join(root, 'data/models', MODEL_FILES[0]), options)
    sessions.push(det)
    const rec = await ort.InferenceSession.create(join(root, 'data/models', MODEL_FILES[1]), options)
    sessions.push(rec)
    const { preprocessForDetection, preprocessForRecognition } = await importPackaged(root, 'src/phase2/ocr/preprocess.js')
    const { extractTextLineBoxes } = await importPackaged(root, 'src/phase2/ocr/postprocess.js')
    const { CTCDecoder } = await importPackaged(root, 'src/phase2/ocr/decoder.js')
    const decoder = new CTCDecoder(join(root, 'data/models', MODEL_FILES[2]))
    const { tensor, dims, ...imageInfo } = await preprocessForDetection(image)
    const output = await det.run({ [det.inputNames[0]]: new ort.Tensor('float32', tensor, dims) })
    const boxes = extractTextLineBoxes(output[det.outputNames[0]], imageInfo).sort((a, b) =>
      Math.abs(a.top - b.top) > 10 ? a.top - b.top : a.left - b.left)
    assert.ok(boxes.length > 0, 'Packaged detector found no synthetic text')
    const recognized = []
    for (const box of boxes) {
      const crop = await sharp(image).extract({
        left: Math.round(box.left), top: Math.round(box.top), width: Math.round(box.width), height: Math.round(box.height),
      }).png().toBuffer()
      const input = await preprocessForRecognition(crop)
      const results = await rec.run({ [rec.inputNames[0]]: new ort.Tensor('float32', input.tensor, input.dims) })
      const result = results[rec.outputNames[0]]
      const decoded = decoder.decode(result.data, result.dims)
      if (decoded.text.trim()) recognized.push(decoded)
    }
    const result = {
      text: recognized.map(item => item.text).join(' '),
      score: recognized.reduce((sum, item) => sum + item.score, 0) / Math.max(1, recognized.length),
      boxes: recognized.length,
    }
    return { ...assertRecognition(result), dictionaryClasses: decoder.size, detectorInput: det.inputNames[0], recognizerInput: rec.inputNames[0] }
  } finally {
    for (const session of sessions.reverse()) await session.release?.()
  }
}

export async function verifyPackagedRuntime({ backendRoot, localPreflight = false, reportPath = null } = {}) {
  const runtime = {
    platform: process.platform, arch: process.arch, node: process.versions.node,
    electron: process.versions.electron || null, modules: process.versions.modules, napi: process.versions.napi,
  }
  const report = { schemaVersion: 1, status: 'failed', startedAt: new Date().toISOString(), runtime, checks: [] }
  const snapshot = async () => {
    if (!reportPath) return
    await mkdir(dirname(reportPath), { recursive: true })
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
  }
  // A fatal native DLL/model crash must not leave a previous passing report.
  // Completed checks survive in a still-failed report, identifying the last
  // stage reached even when JavaScript cannot catch a native process failure.
  await snapshot()
  let root = resolve(backendRoot || '.'), requireBackend, sharp, ort, image
  const cleanError = error => ({
    code: typeof error?.code === 'string' ? error.code : 'CHECK_FAILED',
    message: String(error?.message || error).split(root).join('[backend]').split(process.cwd()).join('[cwd]').slice(0, 1024),
  })
  const check = async (name, action) => {
    const started = performance.now()
    try {
      const details = await action()
      report.checks.push({ name, status: details?.notRun ? 'not-run' : 'passed', durationMs: performance.now() - started, details })
      await snapshot()
      return true
    } catch (error) {
      report.checks.push({ name, status: 'failed', durationMs: performance.now() - started, error: cleanError(error),
        ...(name === 'audio-send-cadence' && error.audioCadence ? { details: error.audioCadence } : {}) })
      await snapshot()
      return false
    }
  }
  const dependency = async name => {
    if (!requireBackend) throw new Error('Packaged dependency root is unavailable')
    const modulePath = await realpath(requireBackend.resolve(name))
    const packagedPath = assertContained(join(root, 'node_modules'), modulePath, name)
    const version = JSON.parse(await readFile(join(root, 'node_modules', name, 'package.json'), 'utf8')).version
    return { module: requireBackend(name), version, modulePath: 'node_modules/' + packagedPath }
  }
  await check('runtime', async () => {
    const details = validateRuntime(runtime, localPreflight)
    if (!localPreflight) {
      const actual = await realpath(process.execPath)
      const expected = await realpath(resolve(root, '..', '..', 'robot-live-ui.exe'))
      assert.equal(actual.toLowerCase(), expected.toLowerCase(),
        'Invoke the application executable adjacent to the specified resources/backend tree')
    }
    return details
  })
  await check('packaged-layout', async () => {
    root = await realpath(root)
    const required = ['package.json', 'ffplay.exe', 'src/phase2/ocr/index.js', 'src/phase2/ocr/worker.js',
      ...MODEL_FILES.map(name => 'data/models/' + name)]
    const files = []
    for (const name of required) {
      const file = await realpath(join(root, name))
      assertContained(root, file, 'Packaged seed')
      const info = await stat(file)
      assert.ok(info.isFile() && info.size > 0, 'Missing or empty packaged file: ' + name)
      files.push({ name, bytes: info.size })
    }
    requireBackend = createRequire(join(root, 'package.json'))
    return { files }
  })
  await check('audio-send-cadence', async () => {
    // Measure the exact packaged production helper before native OCR work. This
    // exercises real Windows/Electron timers, with no fake or physical receiver.
    return checkAudioSendCadence(await importPackaged(root, 'src/robot/audio-send-policy.js'))
  })
  await check('ffmpeg-pcm', async () => {
    const resolved = await dependency('ffmpeg-static')
    const executable = await realpath(resolved.module)
    const binaryPath = assertContained(join(root, 'node_modules'), executable, 'ffmpeg binary')
    return { ...await checkFfmpeg(executable), packageVersion: resolved.version, modulePath: resolved.modulePath, binaryPath: 'node_modules/' + binaryPath }
  })
  await check('ffplay', async () => {
    const executable = join(root, 'ffplay.exe')
    const descriptor = await open(executable, 'r')
    const header = Buffer.alloc(2)
    try { await descriptor.read(header, 0, 2, 0) } finally { await descriptor.close() }
    assert.equal(header.toString('ascii'), 'MZ', 'Packaged ffplay.exe is not a Windows executable')
    if (process.platform !== 'win32' && localPreflight) return { notRun: true, reason: 'Windows executable checked but cannot run on this host' }
    const output = await runCommand(executable, ['-version'])
    assert.match(output.stdout.toString('utf8'), /^ffplay version /, 'Packaged player did not identify as ffplay')
    return { version: output.stdout.toString('utf8').split(/\r?\n/)[0], executable: 'ffplay.exe' }
  })
  await check('windows-pause-resume', async () => {
    const resolved = await dependency('process-suspend')
    assert.equal(typeof resolved.module.suspend, 'function')
    assert.equal(typeof resolved.module.resume, 'function')
    if (process.platform !== 'win32' && localPreflight) return { notRun: true, reason: 'Windows native pause/resume requires Windows' }
    // This optional npm dependency can be missing despite npm ci succeeding.
    const native = await dependency('ntsuspend')
    assert.equal(typeof native.module.suspend, 'function')
    assert.equal(typeof native.module.resume, 'function')
    return { packageVersion: native.version, modulePath: native.modulePath }
  })
  await check('sharp', async () => {
    const resolved = await dependency('sharp')
    sharp = resolved.module
    const svg = await readFile(FIXTURE_PATH)
    // Every glyph is an inline path. No text/font layout, external URL or capture.
    assert.ok(!/<text\b|<image\b|href=|font-family/i.test(svg.toString('utf8')))
    image = await sharp(svg).png().toBuffer()
    const raster = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    assert.equal(raster.info.width, 720)
    assert.equal(raster.info.height, 120)
    assert.equal(raster.info.channels, 3)
    assert.ok(raster.data.some(value => value < 32), 'Synthetic raster contains no black glyphs')
    assert.ok(raster.data.some(value => value > 224), 'Synthetic raster contains no white background')
    const resized = await sharp(image).resize(360, 60).png().toBuffer()
    assert.equal((await sharp(resized).metadata()).width, 360)
    return { packageVersion: resolved.version, modulePath: resolved.modulePath, vips: sharp.versions.vips,
      fixtureSha256: createHash('sha256').update(svg).digest('hex'), width: 720, height: 120 }
  })
  await check('onnx-models', async () => {
    const resolved = await dependency('onnxruntime-node')
    ort = resolved.module
    if (!image || !sharp) throw new Error('Sharp fixture prerequisite failed')
    return { packageVersion: resolved.version, modulePath: resolved.modulePath, ...await directOcr(root, image, sharp, ort) }
  })
  await check('ocr-pipeline', async () => {
    if (!ort || !image) throw new Error('Native OCR prerequisites failed')
    const originalDirectory = process.cwd()
    let pipeline
    try {
      // Production utility backend uses this same cwd. A real result from the
      // worker-backed public pipeline is mandatory evidence here.
      process.chdir(root)
      pipeline = await importPackaged(root, 'src/phase2/ocr/index.js')
      await pipeline.initOcr()
      const generation = pipeline.startOcrSession()
      return assertRecognition(await pipeline.recognizeText(image, { generation }))
    } finally {
      await pipeline?.shutdownOcr?.()
      process.chdir(originalDirectory)
    }
  })
  await check('packaged-native-bindings', async () => {
    if (!sharp || !ort) throw new Error('Both Sharp and ONNX must have loaded their native bindings')
    const bindings = Object.keys(requireBackend.cache).filter(name => name.endsWith('.node'))
    const names = []
    for (const binding of bindings) {
      if (!/sharp|onnxruntime/i.test(binding)) continue
      names.push('node_modules/' + assertContained(join(root, 'node_modules'), await realpath(binding), 'Native addon'))
    }
    assert.ok(names.some(name => /sharp/i.test(name)), 'No loaded packaged Sharp native addon found')
    assert.ok(names.some(name => /onnxruntime_binding/i.test(name)), 'No loaded packaged ONNX native addon found')
    return { bindings: names.sort() }
  })
  report.finishedAt = new Date().toISOString()
  report.status = report.checks.some(item => item.status === 'failed') ? 'failed'
    : localPreflight || report.checks.some(item => item.status === 'not-run') ? 'partial' : 'passed'
  await snapshot()
  return report
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const report = await verifyPackagedRuntime(options)
  await mkdir(dirname(options.reportPath), { recursive: true })
  await writeFile(options.reportPath, JSON.stringify(report, null, 2) + '\n')
  for (const check of report.checks) console.log('[packaged-runtime] ' + check.name + ': ' + check.status)
  console.log('[packaged-runtime] overall: ' + report.status)
  process.exitCode = report.status === 'passed' || (options.localPreflight && report.status === 'partial') ? 0 : 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error('[packaged-runtime] ' + error.message); process.exitCode = 1 })
}
