import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PreparedAudioCache } from '../src/tts/prepared-audio-cache.js'

const moduleUrl = new URL('../src/tts/prepared-audio-cache.js', import.meta.url).href
const pcmName = () => `pcm-${randomUUID()}.pcm`
const options = directory => ({ directory, memoryBytes: 2560, diskBytes: 8192 })

async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pcm-isolation-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

async function prepare(cache, byte = 17) {
  return cache.prepare('held', write => write(Buffer.alloc(4096, byte)))
}

function exitedPid() {
  const child = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' })
  assert.equal(child.status, 0)
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' })
  return child.pid
}

async function seedRun(root, pid, { nonce = randomUUID(), owner, files = {} } = {}) {
  const directory = join(root, `run-${pid}-${nonce}`)
  await mkdir(directory)
  await writeFile(join(directory, 'owner.json'), owner ?? JSON.stringify({ kind: 'robot-pcm-cache-v1', pid, nonce }))
  for (const [name, content] of Object.entries(files)) await writeFile(join(directory, name), content)
  return directory
}

test('legacy live/reused PID and malformed root owners cannot block audio or cause legacy files to be removed', async t => {
  for (const owner of [JSON.stringify({ kind: 'robot-pcm-cache-v1', pid: process.pid, nonce: randomUUID() }), '{partial']) {
    const directory = await temporary(t)
    const legacyPcm = pcmName()
    await writeFile(join(directory, 'owner.json'), owner)
    await writeFile(join(directory, legacyPcm), 'legacy audio still in use')
    await writeFile(join(directory, 'user-recording.mp3'), 'user audio')
    const cache = new PreparedAudioCache(options(directory))
    t.after(() => cache.close())
    const entry = await prepare(cache)
    assert.equal(entry.byteLength, 4096)
    assert.notEqual(cache.directory, directory)
    await cache.close()
    assert.equal(await readFile(join(directory, 'owner.json'), 'utf8'), owner)
    assert.equal(await readFile(join(directory, legacyPcm), 'utf8'), 'legacy audio still in use')
    assert.equal(await readFile(join(directory, 'user-recording.mp3'), 'utf8'), 'user audio')
    assert.deepEqual((await readdir(directory)).sort(), ['owner.json', legacyPcm, 'user-recording.mp3'].sort())
  }
})

test('three caches sharing a root keep independent disk assets and close without interrupting the others', async t => {
  const directory = await temporary(t)
  const caches = Array.from({ length: 3 }, () => new PreparedAudioCache(options(directory)))
  t.after(() => Promise.all(caches.map(cache => cache.close())))
  const entries = await Promise.all(caches.map((cache, index) => prepare(cache, index + 1)))
  assert.equal(new Set(caches.map(cache => cache.directory)).size, 3)
  await caches[0].close()
  for (const index of [1, 2]) {
    assert.deepEqual(await readFile(entries[index].path), Buffer.alloc(4096, index + 1))
    assert.equal(caches[index].stats().diskBytes, 4096)
  }
  await Promise.all(caches.slice(1).map(cache => cache.close()))
  assert.deepEqual(await readdir(directory), [])
})

test('a separate live process is protected; after a forced exit a new cache reclaims its abandoned PCM', async t => {
  const directory = await temporary(t)
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    const { PreparedAudioCache } = await import(${JSON.stringify(moduleUrl)});
    const cache = new PreparedAudioCache(${JSON.stringify(options(directory))});
    const entry = await cache.prepare('held', write => write(Buffer.alloc(4096, 37)));
    process.send({ directory: cache.directory, path: entry.path });
    setInterval(() => {}, 1000);
  `], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  const exited = once(child, 'exit')
  exited.catch(() => {})
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exited
  })
  let timer
  const ready = await Promise.race([
    once(child, 'message').then(([message]) => message),
    exited.then(() => { throw new Error(`cache child exited before readiness: ${stderr}`) }),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('cache child did not become ready')), 10_000) }),
  ]).finally(() => clearTimeout(timer))

  const second = new PreparedAudioCache(options(directory))
  t.after(() => second.close())
  const entry = await prepare(second, 23)
  assert.deepEqual(await readFile(ready.path), Buffer.alloc(4096, 37))
  child.kill('SIGKILL')
  await exited

  // Concurrent startup collectors must also tolerate racing over an old run.
  const next = [new PreparedAudioCache(options(directory)), new PreparedAudioCache(options(directory))]
  t.after(() => Promise.all(next.map(cache => cache.close())))
  await Promise.all(next.map(cache => prepare(cache)))
  await assert.rejects(readFile(ready.path), { code: 'ENOENT' })
  assert.equal((await readdir(directory)).includes(ready.directory.split(/[\\/]/).pop()), false)
  assert.deepEqual(await readFile(entry.path), Buffer.alloc(4096, 23))
})

test('cleanup preserves live/reused PIDs, unknown files and mismatched ownership', async t => {
  const directory = await temporary(t)
  const pid = exitedPid()
  const liveFile = pcmName(), deadFile = pcmName(), mismatchedFile = pcmName()
  const live = await seedRun(directory, process.pid, { files: { [liveFile]: 'live' } })
  const dead = await seedRun(directory, pid, { files: { [deadFile]: 'stale', 'notes.txt': 'keep' } })
  const mismatched = await seedRun(directory, pid, {
    owner: JSON.stringify({ kind: 'robot-pcm-cache-v1', pid, nonce: randomUUID() }),
    files: { [mismatchedFile]: 'unknown owner' },
  })
  const partial = await seedRun(directory, pid, { owner: '{partial', files: { [pcmName()]: 'unknown' } })
  const cache = new PreparedAudioCache(options(directory))
  t.after(() => cache.close())
  await prepare(cache)
  assert.equal(await readFile(join(live, liveFile), 'utf8'), 'live')
  await assert.rejects(readFile(join(dead, deadFile)), { code: 'ENOENT' })
  assert.equal(await readFile(join(dead, 'notes.txt'), 'utf8'), 'keep')
  assert.equal(await readFile(join(mismatched, mismatchedFile), 'utf8'), 'unknown owner')
  assert.equal(await readFile(join(partial, 'owner.json'), 'utf8'), '{partial')
})

test('cleanup never traverses a run-shaped symlink or Windows junction', async t => {
  const directory = await temporary(t)
  const outside = await temporary(t)
  const pid = exitedPid(), nonce = randomUUID(), file = pcmName()
  await writeFile(join(outside, 'owner.json'), JSON.stringify({ kind: 'robot-pcm-cache-v1', pid, nonce }))
  await writeFile(join(outside, file), 'outside cache root')
  await symlink(outside, join(directory, `run-${pid}-${nonce}`), process.platform === 'win32' ? 'junction' : 'dir')
  const cache = new PreparedAudioCache(options(directory))
  t.after(() => cache.close())
  await prepare(cache)
  await cache.close()
  assert.equal(await readFile(join(outside, file), 'utf8'), 'outside cache root')
})
