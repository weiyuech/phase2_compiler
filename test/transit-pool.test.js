import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { TransitAudioManager, normalizeTransitConfig } from '../src/transit/manager.js'

const nextTurn = () => new Promise(resolve => setImmediate(resolve))

test('arrival retires prepared transit TTS after its sentence without starting another loop', async () => {
  let finish, options, plays = 0, released = false
  const tts = {
    enabled: true, stop() {},
    async prepareText() { return { release() { released = true } } },
    speakPreparedText(_source, opts) {
      plays++
      options = opts
      return new Promise(resolve => { finish = resolve })
    },
  }
  const manager = new TransitAudioManager({ filePath: null, tts })
  manager.saveConfig({ enabled: true, type: 'tts', text: '当前句。后续句。' })
  await manager.start(tts, { rewrite: async () => ({ text: '当前句。后续句。' }) })
  await nextTurn()
  const finished = manager.finishCurrentSentence()
  assert.equal(options.shouldFinish(), true)
  assert.equal(options.signal.aborted, false)
  assert.equal(manager.isRunning(), true)
  finish({ ok: true })
  await finished
  assert.equal(plays, 1)
  assert.equal(released, true)
  assert.equal(manager.isRunning(), false)
})

function makeHarness(t, { random = () => 0, failing = new Set() } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'transit-pool-test-'))
  const files = ['a.mp3', 'b.mp3', 'c.mp3'].map(name => join(dir, name))
  // Only a mocked player consumes these fixture paths; no decoder or speaker runs.
  for (const file of files) writeFileSync(file, 'mock MP3')
  const played = []
  let pending = null
  let time = 0
  let paused = false
  const player = {
    async playFile(file) {
      played.push(file)
      if (failing.has(file)) throw new Error('simulated bad clip')
      await new Promise(resolve => { pending = resolve })
    },
    stop() { const resolve = pending; pending = null; resolve?.() },
    pause() { paused = true },
    resume() { paused = false },
  }
  const manager = new TransitAudioManager({ filePath: join(dir, 'config.json'), player, random, now: () => time })
  t.after(() => {
    manager.stop()
    rmSync(dir, { recursive: true, force: true })
  })
  return {
    dir, files, played, player, manager,
    get paused() { return paused },
    async finish() {
      assert.ok(pending, 'there should be one pending clip')
      time += 1000
      const resolve = pending
      pending = null
      resolve()
      await nextTurn()
    },
  }
}

test('legacy single-file config migrates with repeat semantics and round-trips', t => {
  const h = makeHarness(t)
  h.manager.saveConfig({ enabled: true, type: 'mp3', mp3_file: h.files[1] })
  const config = h.manager.getConfig()
  assert.equal(config.mp3_mode, 'repeat')
  assert.equal(config.mp3_file, h.files[1])
  assert.deepEqual(config.mp3_files, [h.files[1]])
  const reloaded = new TransitAudioManager({ filePath: join(h.dir, 'config.json'), player: h.player })
  assert.deepEqual(reloaded.getConfig(), config)
  assert.deepEqual(JSON.parse(readFileSync(join(h.dir, 'config.json'), 'utf8')), config)
  config.mp3_files.push('outside-mutation.mp3')
  assert.deepEqual(h.manager.getConfig().mp3_files, [h.files[1]])
})

test('pool normalization validates, deduplicates, and treats an empty pool as explicit removal', () => {
  const config = normalizeTransitConfig({
    enabled: 'true', type: 'invalid', text: 9, mp3_mode: 'invalid',
    mp3_file: '/music/b.mp3',
    mp3_files: [' /music/a.mp3 ', '/music/../music/a.mp3', null, 12, '', '/music/a.txt', '/bad\0.mp3', '/music/b.mp3'],
  })
  assert.deepEqual(config, {
    enabled: false, type: 'tts', text: '', mp3_mode: 'repeat',
    mp3_file: '/music/b.mp3', mp3_files: ['/music/a.mp3', '/music/b.mp3'],
  })
  assert.deepEqual(normalizeTransitConfig({ mp3_file: '/music/old.mp3', mp3_files: [] }).mp3_files, [])
  assert.equal(normalizeTransitConfig({ mp3_file: '/music/old.mp3', mp3_files: [] }).mp3_file, '')
  assert.deepEqual(normalizeTransitConfig(null).mp3_files, [])
})

test('legacy WAV/OGG/M4A settings retain every format accepted by the existing picker', async t => {
  const h = makeHarness(t)
  for (const extension of ['wav', 'ogg', 'm4a']) {
    const file = join(h.dir, `legacy.${extension}`)
    writeFileSync(file, 'mock audio')
    h.manager.saveConfig({ enabled: true, type: 'mp3', mp3_file: file })
    assert.equal(h.manager.getConfig().mp3_file, file)
    assert.deepEqual(h.manager.getConfig().mp3_files, [file])
    await h.manager.start()
    assert.equal(h.played.at(-1), file)
    h.manager.stop()
    await nextTurn()
  }
  assert.deepEqual(normalizeTransitConfig({ mp3_files: ['/music/a.WAV', '/music/b.ogg', '/music/c.m4a'] }).mp3_files,
    ['/music/a.WAV', '/music/b.ogg', '/music/c.m4a'])
})

test('repeat mode loops the selected track even when the pool has several files', async t => {
  const h = makeHarness(t)
  h.manager.saveConfig({ enabled: true, type: 'mp3', mp3_files: h.files, mp3_file: h.files[1] })
  await h.manager.start()
  await h.finish()
  await h.finish()
  assert.deepEqual(h.played, [h.files[1], h.files[1], h.files[1]])
})

test('shuffle visits every clip once per bag and avoids repeats at bag boundaries', async t => {
  const draws = [0, 0, 0.5, 0.99, 0.8, 0.1]
  let index = 0
  const h = makeHarness(t, { random: () => draws[index++ % draws.length] })
  h.manager.saveConfig({ enabled: true, type: 'mp3', mp3_files: h.files, mp3_mode: 'shuffle' })
  await h.manager.start()
  for (let i = 0; i < 8; i++) await h.finish()
  for (let i = 0; i < h.played.length; i += 3) assert.equal(new Set(h.played.slice(i, i + 3)).size, 3)
  for (let i = 1; i < h.played.length; i++) assert.notEqual(h.played[i], h.played[i - 1])
})

test('shuffle with one available clip repeats it and skips missing files/directories', async t => {
  const h = makeHarness(t)
  const directory = join(h.dir, 'directory.mp3')
  mkdirSync(directory)
  const missing = join(h.dir, 'missing.mp3')
  h.manager.saveConfig({ enabled: true, type: 'mp3', mp3_files: [missing, directory, h.files[0]], mp3_mode: 'shuffle' })
  await h.manager.start()
  await h.finish()
  assert.deepEqual(h.played, [h.files[0], h.files[0]])
  assert.deepEqual(h.manager.getConfig().mp3_files, [missing, directory, h.files[0]], 'missing entries should stay editable')
})

test('a file removed during playback is skipped on subsequent selections', async t => {
  const h = makeHarness(t)
  h.manager.saveConfig({ enabled: true, type: 'mp3', mp3_files: h.files.slice(0, 2), mp3_mode: 'shuffle' })
  await h.manager.start()
  assert.equal(h.played[0], h.files[0])
  rmSync(h.files[1])
  await h.finish()
  assert.deepEqual(h.played, [h.files[0], h.files[0]])
})

test('decoder/player errors skip failed clips and an exhausted pool terminates', async t => {
  const failing = new Set()
  const h = makeHarness(t, { failing })
  failing.add(h.files[0])
  h.manager.saveConfig({ enabled: true, type: 'mp3', mp3_files: h.files.slice(0, 2), mp3_file: h.files[0] })
  await h.manager.start()
  await nextTurn()
  assert.deepEqual(h.played, h.files.slice(0, 2))
  failing.add(h.files[1])
  await h.finish()
  assert.equal(h.manager.isRunning(), false)
  assert.deepEqual(h.played, [h.files[0], h.files[1], h.files[1]])
})

test('empty or entirely unavailable pools finish without invoking the player', async t => {
  const h = makeHarness(t)
  for (const mp3_files of [[], [join(h.dir, 'gone.mp3')]]) {
    h.manager.saveConfig({ enabled: true, type: 'mp3', mp3_files })
    await h.manager.start()
    assert.equal(h.manager.isRunning(), false)
  }
  assert.deepEqual(h.played, [])
})

test('pause/resume delegates to the same active clip; stop prevents another selection', async t => {
  const h = makeHarness(t)
  h.manager.saveConfig({ enabled: true, type: 'mp3', mp3_files: h.files, mp3_mode: 'shuffle' })
  await h.manager.start()
  const run = h.manager._runId
  await h.manager.pause()
  assert.equal(h.paused, true)
  await h.manager.resume()
  assert.equal(h.paused, false)
  assert.equal(h.manager._runId, run)
  assert.equal(h.played.length, 1)
  h.manager.stop()
  await nextTurn()
  assert.equal(h.manager.isRunning(), false)
  assert.equal(h.played.length, 1)
})

test('saving changes leaves the current run intact and new starts use the new pool', async t => {
  const h = makeHarness(t)
  h.manager.saveConfig({ enabled: true, type: 'mp3', mp3_file: h.files[0] })
  await h.manager.start()
  const run = h.manager._runId
  h.manager.saveConfig({ enabled: true, type: 'mp3', mp3_file: h.files[1] })
  await h.finish()
  assert.equal(h.manager._runId, run)
  assert.deepEqual(h.played, [h.files[0], h.files[0]])
  await h.manager.start()
  await nextTurn()
  assert.equal(h.played.at(-1), h.files[1])
  assert.equal(h.manager.isRunning(), true, 'old run completion must not stop its replacement')
})

test('a disabled config takes effect on the next start and retires the previous loop', async t => {
  const h = makeHarness(t)
  h.manager.saveConfig({ enabled: true, type: 'mp3', mp3_file: h.files[0] })
  await h.manager.start()
  const oldRun = h.manager._runId
  h.manager.saveConfig({ ...h.manager.getConfig(), enabled: false })
  assert.equal(h.manager._runId, oldRun, 'saving must not interrupt the current clip')
  assert.equal(h.manager.isRunning(), true)
  await h.manager.start()
  await nextTurn()
  assert.equal(h.manager.isRunning(), false)
  assert.deepEqual(h.played, [h.files[0]], 'retired callbacks must not start another clip')
})

test('stopping during transit TTS synthesis prevents late playback', async t => {
  const h = makeHarness(t)
  let finishSynthesis
  let synthesized = 0
  let bufferedPlays = 0
  h.player.play = async () => { bufferedPlays++ }
  h.manager.saveConfig({ enabled: true, type: 'tts', text: '过渡片段' })
  await h.manager.start({
    enabled: true,
    synthesizeBuffer() {
      synthesized++
      return new Promise(resolve => { finishSynthesis = resolve })
    },
  }, { rewrite: async ({ body }) => ({ text: body }) })
  await nextTurn()
  assert.equal(synthesized, 1)
  h.manager.stop()
  finishSynthesis(Buffer.from('cached audio'))
  await nextTurn()
  assert.equal(bufferedPlays, 0)
  assert.equal(h.manager.isRunning(), false)
})

test('TTS still synthesizes once and loops the same cached buffer', async t => {
  const h = makeHarness(t)
  const buffer = Buffer.from('cached audio')
  let rewrites = 0
  let syntheses = 0
  h.player.play = h.player.playFile
  h.manager.saveConfig({ enabled: true, type: 'tts', text: '过渡片段' })
  await h.manager.start({
    enabled: true,
    async synthesizeBuffer() { syntheses++; return buffer },
  }, { async rewrite({ body }) { rewrites++; return { text: body } } })
  await nextTurn()
  await h.finish()
  await h.finish()
  assert.equal(rewrites, 1)
  assert.equal(syntheses, 1)
  assert.equal(h.played.length, 3)
  for (const played of h.played) assert.equal(played, buffer)
})

test('enabled transit reports missing TTS configuration through the UI error hook', async () => {
  const errors = []
  const tts = { enabled: false, stop() {} }
  const manager = new TransitAudioManager({ filePath: null, tts, onError: message => errors.push(message) })
  manager.saveConfig({ enabled: true, type: 'tts', text: '下一展区' })
  await manager.start(tts, {})
  assert.equal(manager.isRunning(), false)
  assert.equal(errors.length, 1)
  assert.match(errors[0], /TTS 未配置/)
})

test('prepared transit failures surface to the UI and release their run', async () => {
  const errors = []
  const tts = { enabled: true, stop() {}, async prepareText() { throw new Error('decoder unavailable') } }
  const manager = new TransitAudioManager({ filePath: null, tts, onError: message => errors.push(message) })
  manager.saveConfig({ enabled: true, type: 'tts', text: '下一展区' })
  await manager.start(tts, { rewrite: async ({ body }) => ({ text: body }) })
  await nextTurn()
  assert.equal(manager.isRunning(), false)
  assert.equal(errors.length, 1)
  assert.match(errors[0], /decoder unavailable/)
})
