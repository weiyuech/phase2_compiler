import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import ffmpeg from 'ffmpeg-static'
import {
  assertAudioSendCadence, assertContained, assertPcm16Mono, assertRecognition, checkFfmpeg, FIXTURE_PATH,
  normalizedOcrText, parseArguments, runCommand, validateRuntime, verifyPackagedRuntime,
} from '../robot-ui/scripts/verify-packaged-runtime.mjs'

test('packaged checker CLI requires explicit backend and report paths', () => {
  const args = parseArguments(['--backend-root', '/test/backend', '--report', '/test/result.json'])
  assert.equal(args.backendRoot, resolve('/test/backend'))
  assert.equal(args.reportPath, resolve('/test/result.json'))
  assert.equal(args.localPreflight, false)
  assert.throws(() => parseArguments(['--backend-root', '/test/backend']), /--report/)
  assert.throws(() => parseArguments(['--backend-root', '--report']), /Missing value/)
  assert.throws(() => parseArguments(['--skip-ocr']), /Unknown argument/)
})

test('release qualification rejects plain Node, non-Windows and wrong architecture', () => {
  assert.throws(() => validateRuntime({ platform: 'win32', arch: 'x64', electron: null }), /not system Node/)
  assert.throws(() => validateRuntime({ platform: 'darwin', arch: 'x64', electron: '41.10.7' }), /Windows/)
  assert.throws(() => validateRuntime({ platform: 'win32', arch: 'arm64', electron: '41.10.7' }), /x64/)
  assert.equal(validateRuntime({ platform: 'win32', arch: 'x64', electron: '41.10.7' }).releaseQualified, true)
  assert.equal(validateRuntime({ platform: 'darwin' }, true).releaseQualified, false)
})

test('dependency containment rejects fallback to a neighboring/system module tree', () => {
  const root = join(tmpdir(), 'packaged', 'node_modules')
  assert.equal(assertContained(root, join(root, 'sharp', 'lib', 'index.js')), 'sharp/lib/index.js')
  assert.throws(() => assertContained(root, root), /outside/)
  assert.throws(() => assertContained(root, join(root, '..', 'system_modules', 'sharp', 'index.js')), /outside/)
  assert.throws(() => assertContained(root, root + '-other/sharp/index.js'), /outside/)
})

test('OCR acceptance requires real recognized text, confidence and both loading stages', () => {
  assert.equal(normalizedOcrText('ROBOT  \n１２３４５'), 'ROBOT12345')
  assert.deepEqual(assertRecognition({ text: 'ROBOT 12345', score: 0.99, boxes: 1 }),
    { recognitionMatched: true, confidence: 0.99, boxCount: 1 })
  assert.throws(() => assertRecognition(null), /did not recognize/)
  assert.throws(() => assertRecognition({ text: 'backend-ready', score: 1 }), /did not recognize/)
  assert.throws(() => assertRecognition({ text: 'ROBOT 12345', score: 0.4 }), /confidence/)
})

test('inline outlined OCR fixture needs no fonts, images, URLs or screen capture', async () => {
  const svg = await readFile(FIXTURE_PATH)
  assert.equal(/<text\b|<image\b|href=|font-family/i.test(svg.toString('utf8')), false)
  const image = await sharp(svg).png().toBuffer()
  const { data, info } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  assert.equal(info.width, 720)
  assert.equal(info.height, 120)
  assert.equal(info.channels, 3)
  assert.ok(data.some(value => value === 0))
  assert.ok(data.some(value => value === 255))
  const resized = await sharp(image).resize(360, 60).png().toBuffer()
  assert.equal((await sharp(resized).metadata()).width, 360)
})

test('real local ffmpeg encodes stereo MP3 and decodes exactly 16kHz mono16-bit PCM', async () => {
  const result = await checkFfmpeg(ffmpeg)
  assert.equal(result.bytes, 6400)
  assert.equal(result.samples, 3200)
  assert.equal(result.sampleRate, 16000)
  assert.equal(result.channels, 1)
  assert.equal(result.sampleBytes, 2)
})

test('PCM verification rejects silence, partial samples and wrong sample count', () => {
  assert.throws(() => assertPcm16Mono(Buffer.alloc(6400)), /silence/)
  assert.throws(() => assertPcm16Mono(Buffer.alloc(6401)), /sample count/)
  assert.throws(() => assertPcm16Mono(Buffer.alloc(12800)), /sample count/)
})

function cadenceMeasurement(intervalMs = 20) {
  return {
    startedAt: 100, finishedAt: 100 + 499 * intervalMs + 20,
    sendTimes: Array.from({ length: 500 }, (_, index) => 100 + index * intervalMs),
    deadlineLatenessMs: Array(500).fill(0), cpuUserMicros: 10000, cpuSystemMicros: 2000,
  }
}

test('audio cadence report accepts bounded jitter and reports actual timer/CPU statistics', () => {
  const measurement = cadenceMeasurement()
  for (let index = 1; index < measurement.sendTimes.length; index += 2) {
    measurement.sendTimes[index] += 5
    measurement.deadlineLatenessMs[index] = 5
  }
  measurement.finishedAt += 5
  const result = assertAudioSendCadence(measurement, 10)
  assert.equal(result.frameCount, 500)
  assert.equal(result.targetElapsedMs, 10000)
  assert.equal(result.elapsedMs, 10005)
  assert.equal(result.minIntervalMs, 15)
  assert.equal(result.p95IntervalMs, 25)
  assert.equal(result.partialOverrunFrames, 250)
  assert.equal(result.wholeFrameOverruns, 0)
  assert.equal(result.cpuMs, 12)
  assert.equal(result.finalDrainMs, 20)
})

test('audio cadence rejects sustained 31ms delivery of 20ms PCM and preserves failure measurements', () => {
  assert.throws(() => assertAudioSendCadence(cadenceMeasurement(31), 10), error => {
    assert.match(error.message, /too slow/)
    assert.equal(error.audioCadence.averageIntervalMs, 31)
    assert.ok(error.audioCadence.driftRatio > 0.5)
    return true
  })
})

test('audio cadence rejects bursts, shortened tails and incomplete measurements', () => {
  const burst = cadenceMeasurement()
  burst.sendTimes[1] = burst.sendTimes[0] + 9
  assert.throws(() => assertAudioSendCadence(burst, 10), /wire spacing/)
  const shortTail = cadenceMeasurement()
  shortTail.finishedAt--
  assert.throws(() => assertAudioSendCadence(shortTail, 10), /final frame drain/)
  const incomplete = cadenceMeasurement()
  incomplete.sendTimes.pop()
  assert.throws(() => assertAudioSendCadence(incomplete, 10), /all 500 frames/)
  const early = cadenceMeasurement()
  early.deadlineLatenessMs[1] = -1
  assert.throws(() => assertAudioSendCadence(early, 10), /before its nominal deadline/)
})

test('native subprocess timeout and output limits are failures, not readiness', async () => {
  await assert.rejects(runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 30 }), /timed out/)
  await assert.rejects(runCommand(process.execPath, ['-e', 'process.stdout.write("x".repeat(2048))'], { maxBytes: 32 }), /excessive/)
  await assert.rejects(runCommand(process.execPath, ['-e', 'process.exit(7)']), /failed/)
})

test('missing packaged OCR/native assets produce a failed report even in local preflight', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'missing-packaged-native-'))
  try {
    const reportPath = join(directory, 'results', 'native.json')
    const report = await verifyPackagedRuntime({ backendRoot: directory, localPreflight: true, reportPath })
    assert.equal(report.status, 'failed')
    assert.deepEqual(report.checks.map(check => check.name), [
      'runtime', 'packaged-layout', 'audio-send-cadence', 'ffmpeg-pcm', 'ffplay', 'windows-pause-resume', 'sharp', 'onnx-models', 'ocr-pipeline', 'packaged-native-bindings',
    ])
    assert.equal(report.checks.find(check => check.name === 'onnx-models').status, 'failed')
    assert.equal(report.checks.find(check => check.name === 'ocr-pipeline').status, 'failed')
    assert.equal(JSON.stringify(report).includes(directory), false, 'failure report redacts the supplied backend path')
    assert.equal(JSON.parse(await readFile(reportPath, 'utf8')).status, 'failed')
  } finally { await rm(directory, { recursive: true, force: true }) }
})
