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
