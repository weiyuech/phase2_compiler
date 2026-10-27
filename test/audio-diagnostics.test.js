import assert from 'node:assert/strict'
import test from 'node:test'
import { appendFile, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { AudioDiagnostics, readAudioHistory } from '../src/diagnostics/audio-diagnostics.js'
import { RollingLog, HISTORY_BYTES, SEGMENT_BYTES, readRollingLog, utf8Tail } from '../src/diagnostics/rolling-log.js'
import { createDiagnosticsReport } from '../src/diagnostics/report.js'
import { startBackendLogCapture } from '../src/diagnostics/backend-log.js'

async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'audio-diagnostics-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}
async function size(path) { try { return (await stat(path)).size } catch { return 0 } }
function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

test('audio metrics whitelist drops content, paths, URLs, secrets and raw session IDs', async t => {
  const directory = await temporary(t)
  const diagnostics = new AudioDiagnostics({ directory, runtimeMetrics: false })
  t.after(() => diagnostics.destroy())
  const forbidden = 'PRIVATE_SECRET_https://host.example/token_/Users/person/private.mp3_私密播报文字'
  diagnostics.event('prepare-start', { sessionId: forbidden, destination: 'robot', source: 'tts',
    text: forbidden, path: forbidden, url: forbidden, token: forbidden, error: forbidden,
    durationMs: 50, reason: forbidden, errorCode: forbidden })
  diagnostics.event(forbidden, { bytes: 99 })
  for (let i = 0; i < 10; i++) diagnostics.packet({ sessionId: forbidden, seq: i + 1, bytes: 640,
    scheduledAtMs: i * 20, sentAtMs: i * 20 + (i === 5 ? 60 : 0), bufferedBytes: 10, text: forbidden })
  assert.equal(diagnostics.snapshot().totals.frames, 10)
  await diagnostics.flush()
  const saved = await readRollingLog({ directory, name: 'audio-diagnostics.log' })
  assert.equal(saved.includes(forbidden), false)
  assert.equal(JSON.stringify(diagnostics.snapshot()).includes(forbidden), false)
  const events = await readAudioHistory({ directory })
  assert.equal(events.find(event => event.type === 'prepare-start').sessionId, 's1')
  const summary = events.find(event => event.type === 'packet-summary')
  assert.equal(summary.frames, 10)
  assert.equal(summary.bytes, 6400)
  assert.equal(summary.maxGapMs, 80)
  assert.equal(summary.maxLatenessMs, 60)
})

test('packet hot path does not queue one disk record per packet; pauses reset gap attribution', async t => {
  const directory = await temporary(t)
  const diagnostics = new AudioDiagnostics({ directory, runtimeMetrics: false })
  t.after(() => diagnostics.destroy())
  await diagnostics.flush()
  for (let i = 0; i < 100; i++) diagnostics.packet({ sessionId: 1, seq: i + 1, bytes: 640, sentAtMs: i * 20 })
  assert.equal(diagnostics.writer.queuedBytes, 0)
  diagnostics.event('pause', { sessionId: 1, reason: 'host' })
  diagnostics.event('resume', { sessionId: 1 })
  diagnostics.packet({ sessionId: 1, seq: 101, bytes: 640, sentAtMs: 9000 })
  assert.equal(diagnostics.snapshot().totals.maxGapMs, 20)
  await diagnostics.flush()
  const summaries = (await readAudioHistory({ directory })).filter(event => event.type === 'packet-summary')
  assert.equal(summaries.length, 1)
  assert.equal(summaries[0].frames, 101)
})

test('real sentence/coordinator/transport aliases retain safe waiting and preparation metadata', async t => {
  const directory = await temporary(t)
  const diagnostics = new AudioDiagnostics({ directory, runtimeMetrics: false })
  t.after(() => diagnostics.destroy())
  const secret = '/private/voice/path?token=secret'
  diagnostics.event('sentence_wait', { utteranceId: secret, role: 'cruise', index: 2, reason: 'preparation', prepared: false, text: secret })
  diagnostics.event('sentence-boundary', { sessionId: secret, role: 'cruise', kind: 'tts' })
  diagnostics.event('robot_audio_prepared', { bytes: 32000, durationMs: 1000, preparationMs: 42, storage: 'disk', generation: 2, path: secret })
  diagnostics.event('robot_audio_read_ahead_wait', { sessionId: 5, offset: 640 })
  diagnostics.event('robot_audio_failed', { sessionId: 5, message: secret })
  diagnostics.event('audio_cache_ready', { bytes: 32000, storage: 'memory', memoryBytes: 64000, diskBytes: 0, entries: 2, activeDecodes: 1 })
  await diagnostics.flush()
  const events = await readAudioHistory({ directory })
  const wait = events.find(event => event.type === 'waiting' && event.reason === 'preparation')
  assert.equal(wait.source, 'point')
  assert.equal(wait.sentenceIndex, 2)
  assert.equal(wait.sessionId, 's1')
  assert.equal(events.find(event => event.type === 'prepared' && event.destination === 'robot').prepareMs, 42)
  assert.equal(events.find(event => event.reason === 'read-ahead').offsetBytes, 640)
  assert.equal(events.find(event => event.entries === 2).storage, 'memory')
  assert.equal(JSON.stringify(events).includes(secret), false)
})

test('socket completion measurements never double-count scheduled packets', async t => {
  const directory = await temporary(t)
  const diagnostics = new AudioDiagnostics({ directory, runtimeMetrics: false })
  t.after(() => diagnostics.destroy())
  for (let seq = 1; seq <= 3; seq++) {
    diagnostics.packet({ sessionId: 7, seq, bytes: 640, stage: 'scheduled_send', gapMs: 20, latenessMs: 2,
      robotVolumePercent: 150, clippedSamples: seq })
    diagnostics.packet({ sessionId: 7, seq, bytes: 640, stage: 'socket_write', writeMs: 4, bufferedAmount: 200,
      payloadBytes: 950, staleConnection: seq === 3, failed: seq === 3 })
  }
  diagnostics.event('pause', { reason: 'host' })
  diagnostics.packet({ sessionId: 7, seq: 4, bytes: 640, stage: 'scheduled_send', gapMs: 2000, clippedSamples: 4 })
  const totals = diagnostics.snapshot().totals
  assert.equal(totals.frames, 4)
  assert.equal(totals.bytes, 2560)
  assert.equal(totals.socketWrites, 3)
  assert.equal(totals.failedWrites, 1)
  assert.equal(totals.staleWrites, 1)
  assert.equal(totals.maxPayloadBytes, 950)
  assert.equal(totals.maxSendCallbackMs, 4)
  assert.equal(totals.maxBufferedBytes, 200)
  assert.equal(totals.maxGapMs, 20)
  assert.equal(totals.clippedSamples, 10)
  await diagnostics.flush()
  const summary = (await readAudioHistory({ directory })).find(event => event.type === 'packet-summary')
  assert.equal(summary.frames, 4)
  assert.equal(summary.socketWrites, 3)
  assert.equal(summary.staleWrites, 1)
  assert.equal(summary.p99GapMs, 20)
  assert.equal(summary.clippedSamples, 10)
})

test('packet fast path preserves numeric filtering, aliases and producer ownership', async t => {
  const directory = await temporary(t)
  const diagnostics = new AudioDiagnostics({ directory, runtimeMetrics: false, flushMs: 60000 })
  t.after(() => diagnostics.destroy())
  const input = Object.freeze({ utteranceId: '/private/secret.mp3', seq: 1, bytes: 640,
    sentAtMs: 0, bufferedBytes: null, bufferedAmount: 9.87654, sendCallbackMs: null,
    writeMs: 2.34567, pcmBufferedBytes: Infinity, clippedSamples: -1, payloadBytes: '999',
    text: 'PRIVATE_TEXT', pcm: Buffer.from('PRIVATE_PCM') })
  diagnostics.packet(input)
  diagnostics.packet({ ...input, seq: 2, sentAtMs: 20, bufferedBytes: 0, bufferedAmount: 900,
    sendCallbackMs: -1, writeMs: 99, clippedSamples: NaN })
  diagnostics.packet({ stage: 'socket_write', failed: 'true', staleConnection: 1,
    bytes: 1000, payloadBytes: 1e16, bufferedAmount: -1, writeMs: NaN })
  await diagnostics.flush()
  const summary = diagnostics.snapshot().lastSummary
  assert.equal(summary.frames, 2)
  assert.equal(summary.bytes, 1280)
  assert.equal(summary.cadenceSamples, 1)
  assert.equal(summary.maxGapMs, 20)
  assert.equal(summary.maxBufferedBytes, 9.877)
  assert.equal(summary.maxSendCallbackMs, 2.346)
  assert.equal(summary.maxPcmBufferedBytes, 0)
  assert.equal(summary.maxPayloadBytes, 0)
  assert.equal(summary.clippedSamples, 0)
  assert.equal(summary.failedWrites, 0)
  assert.equal(summary.staleWrites, 0)
  assert.equal(input.bufferedBytes, null)
  const saved = await readRollingLog({ directory, name: 'audio-diagnostics.log' })
  assert.equal(saved.includes('PRIVATE_'), false)
  assert.equal(saved.includes('/private/'), false)
})

test('packet fast path excludes inherited and non-enumerable ordinary fields', async t => {
  const directory = await temporary(t)
  const diagnostics = new AudioDiagnostics({ directory, runtimeMetrics: false, flushMs: 60000 })
  t.after(() => diagnostics.destroy())
  const input = Object.create({ bytes: 640, failed: true, stage: 'socket_write' })
  Object.defineProperty(input, 'seq', { value: 1000 })
  Object.defineProperty(input, 'pcmBufferedBytes', { value: 9999 })
  input.bufferedAmount = 25
  diagnostics.packet(input)
  const totals = diagnostics.snapshot().totals
  assert.equal(totals.frames, 1)
  assert.equal(totals.bytes, 0)
  assert.equal(totals.socketWrites, 0)
  assert.equal(totals.maxPcmBufferedBytes, 0)
  assert.equal(totals.maxBufferedBytes, 25)
})

test('live PCM summary measures post-gain frames before completion with weighted RMS and no callback duplication', async t => {
  const directory = await temporary(t)
  const diagnostics = new AudioDiagnostics({ directory, runtimeMetrics: false, flushMs: 60000 })
  t.after(() => diagnostics.destroy())
  const first = { sessionId: 'private-audio.mp3', stage: 'scheduled_send', seq: 1, bytes: 640,
    sentAtMs: 0, pcmPeak: 100, pcmSumSquares: 320 * 100 ** 2, pcmSamples: 320,
    pcmNonzeroSamples: 320, robotVolumePercent: 125 }
  const second = { ...first, seq: 2, bytes: 320, sentAtMs: 20, pcmPeak: 300,
    pcmSumSquares: 160 * 300 ** 2, pcmSamples: 160, pcmNonzeroSamples: 160 }
  diagnostics.packet(first)
  diagnostics.packet({ ...first, stage: 'socket_write' })
  diagnostics.packet(second)
  diagnostics.packet({ ...second, stage: 'socket_write' })
  await diagnostics.flush()
  const summary = diagnostics.snapshot().lastSummary
  assert.equal(summary.frames, 2)
  assert.equal(summary.socketWrites, 2)
  assert.equal(summary.pcmSamples, 480)
  assert.equal(summary.pcmNonzeroSamples, 480)
  assert.equal(summary.pcmPeak, 300)
  assert.equal(summary.pcmRms, Math.sqrt((320 * 100 ** 2 + 160 * 300 ** 2) / 480))
  assert.equal(summary.robotVolumePercent, 125)
  assert.equal(summary.pcmSumSquares, undefined)
  assert.equal(diagnostics.snapshot().events.some(event => event.type === 'playback-end'), false)
  const saved = (await readAudioHistory({ directory })).find(event => event.type === 'packet-summary')
  assert.equal(saved.pcmSamples, 480)
  assert.equal(saved.pcmPeak, 300)
  assert.equal(saved.pcmRms, Math.round(summary.pcmRms * 1000) / 1000)
  assert.equal(JSON.stringify(saved).includes('private-audio.mp3'), false)
  await diagnostics.flush()
  assert.deepEqual(diagnostics.snapshot().lastSummary, summary)
})

test('live PCM windows do not carry previous-session levels across pause, boundary or generation changes', async t => {
  const directory = await temporary(t)
  const diagnostics = new AudioDiagnostics({ directory, runtimeMetrics: false, flushMs: 60000 })
  t.after(() => diagnostics.destroy())
  const packet = (sessionId, level, extra = {}) => diagnostics.packet({
    sessionId, bytes: 640, pcmSamples: 320, pcmNonzeroSamples: level ? 320 : 0,
    pcmPeak: level, pcmSumSquares: 320 * level ** 2, generation: 1, connectionGeneration: 1, ...extra,
  })
  packet('first', 1000)
  diagnostics.event('pause', { sessionId: 'first' })
  diagnostics.event('resume', { sessionId: 'first' })
  packet('first', 100)
  await diagnostics.flush()
  assert.equal(diagnostics.snapshot().lastSummary.pcmPeak, 100)
  assert.equal(diagnostics.snapshot().lastSummary.pcmSamples, 320)
  packet('first', 2000)
  diagnostics.event('boundary', { sessionId: 'first' })
  packet('first', 200)
  packet('second', 0)
  await diagnostics.flush()
  assert.equal(diagnostics.snapshot().lastSummary.pcmRms, 0)
  assert.equal(diagnostics.snapshot().lastSummary.pcmSamples, 320)
  packet('second', 3000)
  packet('second', 300, { generation: 2 })
  packet('second', 30, { generation: 2, connectionGeneration: 2 })
  await diagnostics.flush()
  assert.equal(diagnostics.snapshot().lastSummary.pcmPeak, 30)
  assert.equal(diagnostics.snapshot().lastSummary.pcmSamples, 320)
  packet('second', 4000)
  diagnostics.event('boundary', { sessionId: 'second' })
  diagnostics.packet({ sessionId: 'second', bytes: 640 })
  await diagnostics.flush()
  assert.equal(diagnostics.snapshot().lastSummary.pcmSamples, undefined)
})

test('invalid or incomplete PCM metadata is omitted rather than reported as silence', async t => {
  const directory = await temporary(t)
  const diagnostics = new AudioDiagnostics({ directory, runtimeMetrics: false, flushMs: 60000 })
  t.after(() => diagnostics.destroy())
  const valid = { bytes: 640, pcmSamples: 320, pcmNonzeroSamples: 320,
    pcmPeak: 100, pcmSumSquares: 320 * 100 ** 2 }
  for (const patch of [
    { pcmSamples: 100 }, { pcmSamples: -1 }, { pcmNonzeroSamples: 321 },
    { pcmPeak: 32769 }, { pcmPeak: NaN }, { pcmSumSquares: Infinity },
    { pcmSumSquares: 10 }, { pcmSumSquares: 1e14 }, { pcmSumSquares: undefined },
    { pcmNonzeroSamples: 0 }, { pcmPeak: 0, pcmSumSquares: 0 },
  ]) diagnostics.packet({ ...valid, ...patch })
  await diagnostics.flush()
  assert.equal(diagnostics.snapshot().lastSummary.frames, 11)
  assert.equal(diagnostics.snapshot().lastSummary.pcmSamples, undefined)
  assert.equal(diagnostics.snapshot().lastSummary.pcmPeak, undefined)
  assert.equal(diagnostics.snapshot().lastSummary.pcmRms, undefined)
})

test('recent cadence measures slow continuous sends and recovers independently of cumulative maxima', async t => {
  const directory = await temporary(t)
  const diagnostics = new AudioDiagnostics({ directory, runtimeMetrics: false, flushMs: 60000 })
  t.after(() => diagnostics.destroy())
  for (let i = 0; i < 21; i++) diagnostics.packet({ sessionId: 'voice', seq: i + 1, bytes: 640, sentAtMs: i * 25 })
  await diagnostics.flush()
  const slow = diagnostics.snapshot().lastSummary
  assert.equal(slow.audioDurationMs, 420)
  assert.equal(slow.cadenceSamples, 20)
  assert.equal(slow.cadenceAudioMs, 400)
  assert.equal(slow.activeSendMs, 500)
  assert.equal(slow.sendRateRatio, 0.8)
  assert.equal(slow.sendLagMs, 100)
  assert.ok(slow.capturedAt <= diagnostics.snapshot().capturedAt)

  for (let i = 1; i <= 20; i++) diagnostics.packet({ sessionId: 'voice', seq: 21 + i, bytes: 640, sentAtMs: 500 + i * 20 })
  await diagnostics.flush()
  const normal = diagnostics.snapshot().lastSummary
  assert.equal(normal.sendRateRatio, 1)
  assert.equal(normal.sendLagMs, 0)
  assert.equal(normal.maxGapMs, 20)
  assert.equal(diagnostics.snapshot().totals.maxGapMs, 25)
  const saved = (await readAudioHistory({ directory })).filter(event => event.type === 'packet-summary')
  assert.equal(saved[0].sendRateRatio, 0.8)
  assert.equal(saved[1].cadenceSamples, 20)
  assert.equal(saved[1].capturedAt, normal.capturedAt)
})

test('pacing summaries carry run totals across windows without counting recovered lag or socket callbacks twice', async t => {
  const directory = await temporary(t)
  const diagnostics = new AudioDiagnostics({ directory, runtimeMetrics: false, flushMs: 60000 })
  t.after(() => diagnostics.destroy())
  await diagnostics.flush()
  const packet = (seq, sentAtMs, extra = {}) => {
    const fields = { sessionId: 'voice', seq, bytes: 640, sentAtMs, ...extra }
    diagnostics.packet({ ...fields, stage: 'scheduled_send' })
    diagnostics.packet({ ...fields, stage: 'socket_write' })
  }
  packet(1, 0, { pacingCorrectionMs: 0, pacingRebaseMs: 0 })
  packet(2, 40)
  assert.equal(diagnostics.writer.queuedBytes, 0)
  await diagnostics.flush()
  const slow = diagnostics.snapshot().lastSummary
  assert.equal(slow.sendLagMs, 20)
  assert.equal(slow.totalActiveSendMs, 40)
  assert.equal(slow.totalCadenceAudioMs, 20)
  assert.equal(slow.totalCadenceSamples, 1)

  packet(3, 50, { pacingCorrectionMs: 10 })
  packet(4, 60, { pacingCorrectionMs: 10 })
  await diagnostics.flush()
  const recovered = diagnostics.snapshot().lastSummary
  assert.equal(recovered.pacingCorrections, 2)
  assert.equal(recovered.pacingCorrectionMs, 20)
  assert.equal(recovered.pacingRebases, 0)
  assert.equal(recovered.totalPacingCorrectionMs, 20)
  assert.equal(recovered.totalActiveSendMs, 60)
  assert.equal(recovered.totalCadenceAudioMs, 60)
  assert.equal(recovered.totalCadenceSamples, 3)
  // The first window had 20 ms of lag, all repaid by this faster window.
  assert.equal(recovered.totalActiveSendMs - recovered.totalCadenceAudioMs, 0)
  assert.equal(recovered.sendLagMs, 0)
  assert.equal(recovered.runStartedAt, diagnostics.startedAt)

  packet(5, 360, { pacingRebaseMs: 280 })
  await diagnostics.flush()
  const rebased = diagnostics.snapshot().lastSummary
  assert.equal(rebased.pacingCorrections, 0)
  assert.equal(rebased.pacingCorrectionMs, 0)
  assert.equal(rebased.pacingRebases, 1)
  assert.equal(rebased.pacingRebaseMs, 280)
  assert.equal(rebased.totalPacingCorrectionMs, 20)
  assert.equal(rebased.totalPacingRebases, 1)
  assert.equal(rebased.totalPacingRebaseMs, 280)
  assert.equal(rebased.totalActiveSendMs - rebased.totalCadenceAudioMs, 280)
  assert.equal(diagnostics.snapshot().totals.pacingCorrections, 2)
  assert.equal(diagnostics.snapshot().totals.pacingRebases, 1)
})

test('run cadence excludes session and pause gaps while a new diagnostics run starts fresh counters', async t => {
  const directory = await temporary(t)
  const first = new AudioDiagnostics({ directory, runtimeMetrics: false, flushMs: 60000 })
  t.after(() => first.destroy())
  const packet = (sessionId, seq, sentAtMs, extra = {}) =>
    first.packet({ sessionId, seq, sentAtMs, bytes: 640, ...extra })
  packet('first', 1, 0)
  packet('first', 2, 30)
  first.event('pause', { sessionId: 'first' })
  first.event('resume', { sessionId: 'first' })
  packet('first', 3, 10000)
  packet('first', 4, 10010, { pacingCorrectionMs: 10 })
  packet('second', 1, 20000)
  packet('second', 2, 20020)
  await first.flush()
  const summary = first.snapshot().lastSummary
  assert.equal(summary.totalActiveSendMs, 60)
  assert.equal(summary.totalCadenceAudioMs, 60)
  assert.equal(summary.totalCadenceSamples, 3)
  assert.equal(summary.totalPacingCorrectionMs, 10)
  assert.equal(summary.totalPacingRebases, 0)
  await first.destroy()

  const second = new AudioDiagnostics({ directory, runtimeMetrics: false, flushMs: 60000 })
  t.after(() => second.destroy())
  second.packet({ sessionId: 'first', seq: 1, sentAtMs: 0, bytes: 640 })
  await second.flush()
  assert.notEqual(second.runId, first.runId)
  const fresh = second.snapshot().lastSummary
  for (const field of ['totalActiveSendMs', 'totalCadenceAudioMs', 'totalCadenceSamples',
    'totalPacingCorrectionMs', 'totalPacingRebases', 'totalPacingRebaseMs']) assert.equal(fresh[field], 0)
  assert.equal(fresh.runStartedAt, second.startedAt)
  const saved = (await readAudioHistory({ directory })).filter(event => event.type === 'packet-summary')
  assert.equal(saved.at(-1).runId, second.runId)
  assert.equal(saved.at(-1).totalCadenceSamples, 0)
  assert.equal(saved.at(-2).runId, first.runId)
  assert.equal(saved.at(-2).totalCadenceSamples, 3)
})

test('pacing telemetry rejects invalid numbers, private metadata and caller-supplied lifetime totals', async t => {
  const directory = await temporary(t)
  const diagnostics = new AudioDiagnostics({ directory, runtimeMetrics: false, flushMs: 60000 })
  t.after(() => diagnostics.destroy())
  const secret = 'PRIVATE_PACING_https://secret.example/token_/private/audio.mp3'
  for (const value of [-1, NaN, Infinity, 1e16, '10', secret]) {
    diagnostics.packet({ sessionId: secret, bytes: 640, pacingCorrectionMs: value, pacingRebaseMs: value,
      pacingRebaseReason: secret, totalPacingRebases: 999, totalActiveSendMs: 999, runStartedAt: secret })
  }
  const inherited = Object.create({ pacingCorrectionMs: 10, pacingRebaseMs: 250 })
  inherited.bytes = 640
  diagnostics.packet(inherited)
  diagnostics.packet({ bytes: 640, pacingCorrectionMs: 1.23456, pacingRebaseMs: 250.98765 })
  await diagnostics.flush()
  const summary = diagnostics.snapshot().lastSummary
  assert.equal(summary.pacingCorrections, 1)
  assert.equal(summary.pacingCorrectionMs, 1.235)
  assert.equal(summary.pacingRebases, 1)
  assert.equal(summary.pacingRebaseMs, 250.988)
  assert.equal(summary.totalPacingRebases, 1)
  assert.equal(summary.runStartedAt, diagnostics.startedAt)
  const saved = await readRollingLog({ directory, name: 'audio-diagnostics.log' })
  assert.equal(saved.includes(secret), false)
  assert.equal(JSON.stringify(diagnostics.snapshot()).includes(secret), false)
})

test('diagnostics export retains lifetime pacing counters after the early packet summaries rotate away', async t => {
  const directory = await temporary(t)
  const diagnostics = new AudioDiagnostics({ directory, runtimeMetrics: false, flushMs: 60000 })
  t.after(() => diagnostics.destroy())
  diagnostics.packet({ sessionId: 'voice', seq: 1, sentAtMs: 0, bytes: 640 })
  diagnostics.packet({ sessionId: 'voice', seq: 2, sentAtMs: 250, bytes: 640, pacingRebaseMs: 230 })
  diagnostics.packet({ sessionId: 'voice', seq: 3, sentAtMs: 260, bytes: 640, pacingCorrectionMs: 10 })
  await diagnostics.flush()
  // Exercise the real bounded writer, without a per-packet persistence path.
  for (let i = 0; i < 4096; i++) {
    diagnostics.event('runtime', { eventLoopP99Ms: 20, eventLoopMaxMs: 40, cpuPercent: 10,
      rssBytes: 134217728, heapBytes: 67108864, diagnosticDroppedRecords: 0,
      diagnosticDiscardedBytes: 0, diagnosticTruncatedRecords: 0, diagnosticStoredBytes: HISTORY_BYTES })
    if (i % 64 === 63) await diagnostics.flush()
  }
  assert.equal((await readAudioHistory({ directory })).some(event => event.type === 'packet-summary'), false)
  diagnostics.packet({ sessionId: 'voice', seq: 4, sentAtMs: 280, bytes: 640 })
  await diagnostics.flush()
  const report = JSON.parse(await createDiagnosticsReport({ directory }))
  const summaries = report.audio.events.filter(event => event.type === 'packet-summary')
  assert.equal(summaries.length, 1)
  const retained = summaries[0]
  assert.equal(retained.frames, 1)
  assert.equal(retained.pacingCorrections, 0)
  assert.equal(retained.pacingRebases, 0)
  assert.equal(retained.runStartedAt, diagnostics.startedAt)
  assert.equal(retained.runId, diagnostics.runId)
  assert.equal(retained.totalActiveSendMs, 280)
  assert.equal(retained.totalCadenceAudioMs, 60)
  assert.equal(retained.totalCadenceSamples, 3)
  assert.equal(retained.totalPacingCorrectionMs, 10)
  assert.equal(retained.totalPacingRebases, 1)
  assert.equal(retained.totalPacingRebaseMs, 230)
  assert.equal(diagnostics.writer.droppedRecords, 0)
  assert.ok(await size(join(directory, 'audio-diagnostics.log')) + await size(join(directory, 'audio-diagnostics.log.1')) <= HISTORY_BYTES)
})

test('compensated timing jitter is not a sustained send shortfall and the final partial frame is not counted as an interval', async t => {
  const directory = await temporary(t)
  const diagnostics = new AudioDiagnostics({ directory, runtimeMetrics: false, flushMs: 60000 })
  t.after(() => diagnostics.destroy())
  let sentAtMs = 0
  diagnostics.packet({ sessionId: 'voice', seq: 1, bytes: 640, sentAtMs })
  const gaps = [60, 12, 12, 12, 12, 12]
  for (let i = 0; i < 24; i++) {
    sentAtMs += gaps[i % gaps.length]
    diagnostics.packet({ sessionId: 'voice', seq: i + 2, bytes: 640, sentAtMs })
  }
  diagnostics.packet({ sessionId: 'voice', seq: 26, bytes: 320, sentAtMs: sentAtMs + 20 })
  diagnostics.event('robot_audio_sent', { sessionId: 'voice', audioDurationMs: 510, elapsedMs: 510, playbackAcknowledged: false })
  await diagnostics.flush()
  const summary = diagnostics.snapshot().lastSummary
  assert.equal(summary.maxGapMs, 60)
  assert.equal(summary.late50Count, 4)
  assert.equal(summary.audioDurationMs, 510)
  assert.equal(summary.cadenceSamples, 25)
  assert.equal(summary.cadenceAudioMs, 500)
  assert.equal(summary.activeSendMs, 500)
  assert.equal(summary.sendRateRatio, 1)
  assert.equal(summary.sendLagMs, 0)
})

test('cadence uses preceding partial-frame duration and excludes pauses, session and connection boundaries', async t => {
  const directory = await temporary(t)
  const diagnostics = new AudioDiagnostics({ directory, runtimeMetrics: false, flushMs: 60000 })
  t.after(() => diagnostics.destroy())
  const packet = (sessionId, seq, bytes, sentAtMs, connectionGeneration = 1) =>
    diagnostics.packet({ sessionId, seq, bytes, sentAtMs, connectionGeneration })
  packet('first', 1, 640, 0)
  packet('first', 2, 320, 20)
  packet('first', 3, 640, 30)
  diagnostics.event('pause', { sessionId: 'first' })
  diagnostics.event('resume', { sessionId: 'first' })
  packet('first', 4, 640, 9030)
  packet('first', 5, 640, 9050)
  packet('second', 1, 640, 10000)
  packet('second', 2, 640, 10020)
  packet('second', 3, 640, 20000, 2)
  packet('second', 4, 640, 20020, 2)
  diagnostics.event('boundary', { sessionId: 'second' })
  packet('second', 5, 640, 30000, 2)
  packet('second', 6, 640, 30020, 2)
  await diagnostics.flush()
  const summary = diagnostics.snapshot().lastSummary
  assert.equal(summary.cadenceSamples, 6)
  assert.equal(summary.cadenceAudioMs, 110)
  assert.equal(summary.activeSendMs, 110)
  assert.equal(summary.sendRateRatio, 1)
  assert.equal(summary.sendLagMs, 0)
  assert.equal(summary.maxGapMs, 20)
})

test('idle windows and late socket callbacks preserve the dated last send sample without double-counting audio', async t => {
  const directory = await temporary(t)
  const diagnostics = new AudioDiagnostics({ directory, runtimeMetrics: false, flushMs: 60000 })
  t.after(() => diagnostics.destroy())
  diagnostics.packet({ sessionId: 'voice', seq: 1, bytes: 640, sentAtMs: 0 })
  diagnostics.packet({ sessionId: 'voice', seq: 2, bytes: 640, sentAtMs: 20 })
  await diagnostics.flush()
  const summary = diagnostics.snapshot().lastSummary
  await diagnostics.flush()
  assert.deepEqual(diagnostics.snapshot().lastSummary, summary)
  diagnostics.packet({ sessionId: 'voice', seq: 2, bytes: 640, stage: 'socket_write', writeMs: 7 })
  await diagnostics.flush()
  assert.deepEqual(diagnostics.snapshot().lastSummary, summary)
  assert.equal(diagnostics.snapshot().totals.audioDurationMs, 40)
  assert.equal(diagnostics.snapshot().totals.cadenceSamples, 1)
})

test('finished-session PCM summaries retain numeric evidence without accepting content or claiming playback', async t => {
  const directory = await temporary(t)
  const diagnostics = new AudioDiagnostics({ directory, runtimeMetrics: false, flushMs: 60000 })
  t.after(() => diagnostics.destroy())
  diagnostics.event('robot_audio_sent', { sessionId: 'private-file.mp3', audioDurationMs: 250,
    elapsedMs: 275, robotVolumePercent: 150, pcmPeak: 30000, pcmRms: 1234.567,
    pcmNonzeroSamples: 3500, pcmSamples: 4000, playbackAcknowledged: false,
    pcm: 'DO_NOT_STORE', text: 'DO_NOT_STORE' })
  await diagnostics.flush()
  const finish = (await readAudioHistory({ directory })).find(event => event.type === 'playback-end')
  assert.equal(finish.audioDurationMs, 250)
  assert.equal(finish.robotVolumePercent, 150)
  assert.equal(finish.pcmPeak, 30000)
  assert.equal(finish.pcmRms, 1234.567)
  assert.equal(finish.pcmNonzeroSamples, 3500)
  assert.equal(finish.pcmSamples, 4000)
  assert.equal(finish.playbackAcknowledged, false)
  assert.equal(JSON.stringify(finish).includes('DO_NOT_STORE'), false)
  assert.equal(JSON.stringify(finish).includes('private-file.mp3'), false)
})

test('opaque utterance correlation survives different sentence sessions and bounded ID eviction', async t => {
  const directory = await temporary(t)
  const diagnostics = new AudioDiagnostics({ directory, runtimeMetrics: false })
  t.after(() => diagnostics.destroy())
  const utteranceId = '/private/transcript?secret=DO_NOT_RETAIN'
  diagnostics.event('prepare-start', { sessionId: utteranceId })
  for (let i = 0; i < 140; i++) {
    diagnostics.event('prepared', { sessionId: `private-sentence-${i}`, utteranceId })
  }
  const snapshot = diagnostics.snapshot()
  assert.ok(snapshot.events.filter(event => event.type === 'prepared').every(event => event.utteranceId === 's1'))
  assert.ok(snapshot.events.filter(event => event.type === 'prepared').every(event => event.sessionId !== event.utteranceId))
  assert.equal(JSON.stringify(snapshot).includes(utteranceId), false)
  await diagnostics.flush()
  const events = await readAudioHistory({ directory })
  assert.ok(events.filter(event => event.type === 'prepared').every(event => event.utteranceId === 's1'))
  assert.equal(JSON.stringify(events).includes('private-sentence-'), false)
})

test('consecutive ID shortcut preserves LRU eviction and never reuses an evicted opaque ID', async t => {
  const directory = await temporary(t)
  const diagnostics = new AudioDiagnostics({ directory, runtimeMetrics: false, flushMs: 60000 })
  t.after(() => diagnostics.destroy())
  diagnostics.event('prepared', { sessionId: 'long-session' })
  for (let i = 0; i < 127; i++) diagnostics.event('prepared', { sessionId: `other-${i}` })
  for (let i = 0; i < 100; i++) diagnostics.packet({ sessionId: 'long-session', bytes: 640 })
  diagnostics.event('prepared', { sessionId: 'new-session' })
  diagnostics.event('prepared', { sessionId: 'long-session' })
  assert.equal(diagnostics.snapshot().events.at(-1).sessionId, 's1')
  diagnostics.event('prepared', { sessionId: 'other-0' })
  assert.equal(diagnostics.snapshot().events.at(-1).sessionId, 's130')
  diagnostics.event('prepared', { sessionId: 'other-0' })
  assert.equal(diagnostics.snapshot().events.at(-1).sessionId, 's130')
  assert.equal(diagnostics._ids.size, 128)
})

test('two segments stay under the TOTAL category cap and discard oldest history', async t => {
  const directory = await temporary(t)
  const writer = new RollingLog({ directory, name: 'audio-diagnostics.log' })
  t.after(() => writer.destroy())
  for (let i = 0; i < 140; i++) {
    writer.append(`${String(i).padStart(4, '0')}:${'x'.repeat(12000)}`)
    await writer.flush()
    assert.ok(await size(join(directory, 'audio-diagnostics.log')) <= SEGMENT_BYTES)
    assert.ok(await size(join(directory, 'audio-diagnostics.log.1')) <= SEGMENT_BYTES)
  }
  const stored = await readRollingLog({ directory, name: 'audio-diagnostics.log' })
  assert.ok(Buffer.byteLength(stored) <= HISTORY_BYTES)
  assert.equal(stored.includes('0000:'), false)
  assert.equal(stored.includes('0139:'), true)
  assert.ok(writer.snapshot().discardedBytes > 0)
})

test('legacy large backend histories migrate newest-first without touching unrelated files', async t => {
  const directory = await temporary(t)
  await writeFile(join(directory, 'backend.log.1'), 'old\n'.repeat(350000))
  await writeFile(join(directory, 'backend.log'), 'new\n'.repeat(350000) + 'LATEST-MARKER\n')
  await writeFile(join(directory, 'recording.mp3'), 'unrelated user recording')
  const writer = new RollingLog({ directory, name: 'backend.log' })
  t.after(() => writer.destroy())
  await writer.flush()
  assert.ok(await size(join(directory, 'backend.log')) <= SEGMENT_BYTES)
  assert.ok(await size(join(directory, 'backend.log.1')) <= SEGMENT_BYTES)
  assert.ok(writer.snapshot().storedBytes <= HISTORY_BYTES)
  assert.ok((await readRollingLog({ directory, name: 'backend.log' })).endsWith('LATEST-MARKER\n'))
  assert.equal(await readFile(join(directory, 'recording.mp3'), 'utf8'), 'unrelated user recording')
  assert.equal((await readdir(directory)).some(file => file.endsWith('.tmp')), false)
})

test('oversized Unicode entries are bounded without replacement characters and queue overflow drops oldest', async t => {
  const directory = await temporary(t)
  const writer = new RollingLog({ directory, name: 'backend.log', recordBytes: 1024, queueBytes: 2048 })
  t.after(() => writer.destroy())
  writer.append('最旧'.repeat(1000))
  writer.append('中间'.repeat(1000))
  writer.append('最新😀'.repeat(1000))
  assert.ok(writer.snapshot().queuedBytes <= 2048)
  assert.ok(writer.snapshot().droppedRecords >= 1)
  assert.equal(writer.snapshot().truncatedRecords, 3)
  await writer.flush()
  const text = await readRollingLog({ directory, name: 'backend.log' })
  assert.equal(text.includes('\ufffd'), false)
  assert.equal(text.includes('最旧'), false)
  assert.equal(text.includes('最新'), true)
  assert.ok(Buffer.byteLength(utf8Tail('你好😀', 6)) <= 6)
})

test('a stalled async write never blocks append or packet processing; overflow retains newest records', { timeout: 3000 }, async t => {
  const directory = await temporary(t)
  const gate = deferred(), entered = deferred()
  const diagnostics = new AudioDiagnostics({ directory, runtimeMetrics: false, flushMs: 60000 })
  // Replace the already-drained writer, so the injectable writer remains the
  // sole owner of this category throughout the actual stall experiment.
  await diagnostics.writer.destroy()
  let writes = 0
  const writer = diagnostics.writer = new RollingLog({
    directory, name: 'audio-diagnostics.log', queueBytes: 4096, recordBytes: 512, flushMs: 60000,
    appendFile: async (...args) => {
      writes++
      if (writes === 1) { entered.resolve(); await gate.promise }
      return appendFile(...args)
    },
  })
  t.after(async () => { gate.resolve(); await diagnostics.destroy() })
  diagnostics.event('prepared', { sentenceIndex: 0 })
  let flushed = false
  const pending = writer.flush().then(() => { flushed = true })
  await entered.promise

  for (let index = 1; index <= 400; index++) diagnostics.event('prepared', { sentenceIndex: index })
  const queuedBeforePackets = writer.snapshot().queuedBytes
  for (let seq = 1; seq <= 200; seq++) diagnostics.packet({ sessionId: 'stall-test', seq, bytes: 640, sentAtMs: seq * 20 })
  // A separate event-loop turn and all packet calls finish while disk I/O is
  // still deliberately unresolved. This is not a timing/latency benchmark.
  await nextTurn()
  assert.equal(flushed, false)
  assert.equal(writes, 1)
  assert.equal(diagnostics.snapshot().totals.frames, 200)
  assert.equal(writer.snapshot().queuedBytes, queuedBeforePackets)
  assert.ok(queuedBeforePackets <= 4096)
  assert.ok(writer.snapshot().droppedRecords > 0)

  gate.resolve()
  await pending
  await writer.flush()
  const events = await readAudioHistory({ directory })
  assert.ok(events.some(event => event.type === 'prepared' && event.sentenceIndex === 0))
  assert.equal(events.some(event => event.type === 'prepared' && event.sentenceIndex === 1), false)
  assert.ok(events.some(event => event.type === 'prepared' && event.sentenceIndex === 400))
  assert.ok(await size(join(directory, 'audio-diagnostics.log')) <= SEGMENT_BYTES)
  assert.equal(writer.snapshot().queuedBytes, 0)
})

for (const partialBytes of [0, 128]) {
  test(`ENOSPC ${partialBytes ? 'after a partial append' : 'before any append'} disables later writes and keeps the category bounded`, async t => {
    const directory = await temporary(t)
    const current = join(directory, 'backend.log'), previous = `${current}.1`
    await writeFile(current, Buffer.alloc(SEGMENT_BYTES - 1024, 120))
    await writeFile(previous, Buffer.alloc(SEGMENT_BYTES, 121))
    let writes = 0
    const writer = new RollingLog({ directory, name: 'backend.log', flushMs: 60000,
      appendFile: async (file, value) => {
        writes++
        if (partialBytes) await appendFile(file, Buffer.from(value).subarray(0, partialBytes))
        throw Object.assign(new Error('private filesystem path must not leak'), { code: 'ENOSPC' })
      },
    })
    t.after(() => writer.destroy())
    writer.append('failed-record:' + 'x'.repeat(880))
    await writer.flush()
    const afterFailure = await size(current)
    assert.equal(afterFailure, SEGMENT_BYTES - 1024 + partialBytes)
    assert.equal(writer.snapshot().status, 'error')
    assert.equal(writer.snapshot().errorCode, 'ENOSPC')
    assert.equal(writer.snapshot().droppedRecords, 1)
    assert.equal(writer.initialized, false)
    assert.equal(JSON.stringify(writer.snapshot()).includes('private filesystem'), false)

    for (let index = 0; index < 1000; index++) writer.append(`discard-${index}:` + 'z'.repeat(900))
    assert.ok(writer.snapshot().queuedBytes <= writer.queueLimit)
    await writer.flush()
    assert.equal(writes, 1)
    assert.equal(await size(current), afterFailure)
    assert.equal(writer.snapshot().droppedRecords, 1001)
    assert.equal(writer.snapshot().queuedBytes, 0)
    assert.equal(writer.snapshot().errorCode, 'ENOSPC')
    assert.ok(afterFailure <= SEGMENT_BYTES)
    assert.ok(afterFailure + await size(previous) <= HISTORY_BYTES)
  })
}

test('audio and backend categories are independently bounded', async t => {
  const directory = await temporary(t)
  const writers = ['backend.log', 'audio-diagnostics.log'].map(name => new RollingLog({ directory, name }))
  t.after(async () => { await Promise.all(writers.map(writer => writer.destroy())) })
  for (let i = 0; i < 90; i++) {
    for (const writer of writers) writer.append('metric\n'.repeat(2000))
    await Promise.all(writers.map(writer => writer.flush()))
  }
  for (const writer of writers) assert.ok(writer.snapshot().storedBytes <= HISTORY_BYTES)
  assert.ok(writers.reduce((sum, writer) => sum + writer.snapshot().storedBytes, 0) > HISTORY_BYTES)
})

test('default crash-safe export omits raw logs and rejects unexpected persisted audio fields', async t => {
  const directory = await temporary(t)
  const secret = 'DO_NOT_EXPORT_PRIVATE_TRANSCRIPT'
  await writeFile(join(directory, 'backend.log'), secret)
  await writeFile(join(directory, 'audio-diagnostics.log'), JSON.stringify({ type: 'prepared', ts: Date.now(), durationMs: 100, text: secret, sessionId: secret }) + '\n{partial')
  const metadata = { appVersion: '1.0.1', platform: 'win32', arch: 'x64', backendStatus: 'exited', USER_DATA_DIR: secret, ROBOT_URL: secret }
  const report = await createDiagnosticsReport({ directory, metadata })
  assert.equal(report.includes(secret), false)
  assert.equal(JSON.parse(report).metadata.backendStatus, 'exited')
  assert.equal(JSON.parse(report).audio.events.length, 1)
  const raw = JSON.parse(await createDiagnosticsReport({ directory, metadata, includeBackendLogs: true }))
  assert.equal(raw.backendHistory, secret)
  assert.ok(raw.privacyWarning)
})

test('failed/symlink targets are surfaced without writing through them', async t => {
  const directory = await temporary(t)
  const outside = join(directory, 'unrelated.txt')
  await writeFile(outside, 'keep')
  await symlink(outside, join(directory, 'backend.log'))
  const writer = new RollingLog({ directory, name: 'backend.log' })
  t.after(() => writer.destroy())
  writer.append('must not follow link')
  await writer.flush()
  assert.equal(writer.snapshot().status, 'error')
  assert.equal(writer.snapshot().errorCode, 'UNSAFE_LOG_PATH')
  assert.equal(await readFile(outside, 'utf8'), 'keep')
})

test('packaged marker prevents a duplicate backend writer; dev tee restores console', async t => {
  const directory = await temporary(t)
  const old = process.env.BACKEND_LOG_OWNER
  t.after(() => { if (old === undefined) delete process.env.BACKEND_LOG_OWNER; else process.env.BACKEND_LOG_OWNER = old })
  process.env.BACKEND_LOG_OWNER = 'electron'
  const packaged = startBackendLogCapture({ directory })
  assert.equal(packaged.snapshot().owner, 'electron')
  assert.equal(await size(join(directory, 'backend.log')), 0)
  delete process.env.BACKEND_LOG_OWNER
  const original = console.log
  const dev = startBackendLogCapture({ directory })
  console.log('dev diagnostic test record')
  await dev.destroy()
  assert.equal(console.log, original)
  assert.ok((await readRollingLog({ directory, name: 'backend.log' })).includes('dev diagnostic test record'))
})
