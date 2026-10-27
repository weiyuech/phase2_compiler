import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PreparedAudioCache } from '../src/tts/prepared-audio-cache.js'

class ObservedCache extends PreparedAudioCache {
  scans = { memory: 0, disk: 0 }
  _unused(kind) { this.scans[kind]++; return super._unused(kind) }
}

async function cacheFor(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pcm-reservations-'))
  const cache = new ObservedCache({ directory, memoryBytes: 2560, diskBytes: 8192, ...options })
  t.after(async () => { await cache.close(); await rm(directory, { recursive: true, force: true }) })
  await cache._ready
  return cache
}

const prepare = (cache, key, bytes, value = 17) => cache.prepare(key, write => write(Buffer.alloc(bytes, value)))

test('repeated decode chunks avoid LRU enumeration while both reservations fit', async t => {
  const cache = await cacheFor(t, { memoryBytes: 8192, diskBytes: 16384 })
  for (const [key, chunkBytes] of [['first', 256], ['second', 128]]) {
    const entry = await cache.prepare(key, async write => {
      for (let chunk = 0; chunk < 16; chunk++) await write(Buffer.alloc(chunkBytes, chunk))
    })
    assert.equal(entry.byteLength, 16 * chunkBytes)
    assert.ok(entry.buffer)
    for (let chunk = 0; chunk < 16; chunk++) {
      assert.deepEqual(entry.buffer.subarray(chunk * chunkBytes, (chunk + 1) * chunkBytes), Buffer.alloc(chunkBytes, chunk))
    }
    cache.release(entry)
  }
  assert.deepEqual(cache.scans, { memory: 0, disk: 0 })
  assert.equal(cache.memoryBytes, 6144)
  assert.equal(cache.diskBytes, 0)
  assert.deepEqual(await readdir(cache.directory), ['owner.json'])
})

test('disk pressure still evicts only the oldest unused entry and preserves held PCM', async t => {
  const cache = await cacheFor(t)
  const oldest = await prepare(cache, 'oldest', 2048, 1)
  const newer = await prepare(cache, 'newer', 2048, 2)
  const held = await prepare(cache, 'held', 4096, 3)
  cache.release(oldest); oldest.used = 1
  cache.release(newer); newer.used = 2
  const oldPath = oldest.path
  await prepare(cache, 'replacement', 2048, 4)
  assert.deepEqual(cache.scans, { memory: 0, disk: 1 })
  assert.equal(cache.entries.has('oldest'), false)
  assert.equal(cache.entries.get('newer'), newer)
  assert.equal(cache.entries.get('held'), held)
  assert.equal(cache.diskBytes, 8192)
  await assert.rejects(readFile(oldPath), { code: 'ENOENT' })
  assert.deepEqual(await readFile(newer.path), Buffer.alloc(2048, 2))
  assert.deepEqual(await readFile(held.path), Buffer.alloc(4096, 3))
})

test('memory pressure still evicts only the oldest unused entry within the same budget', async t => {
  const cache = await cacheFor(t)
  const oldest = await prepare(cache, 'oldest', 512, 1)
  const newer = await prepare(cache, 'newer', 512, 2)
  const held = await prepare(cache, 'held', 1024, 3)
  cache.release(oldest); oldest.used = 1
  cache.release(newer); newer.used = 2
  const replacement = await prepare(cache, 'replacement', 1024, 4)
  assert.deepEqual(cache.scans, { memory: 1, disk: 0 })
  assert.equal(cache.entries.has('oldest'), false)
  assert.deepEqual(newer.buffer, Buffer.alloc(512, 2))
  assert.deepEqual(held.buffer, Buffer.alloc(1024, 3))
  assert.deepEqual(replacement.buffer, Buffer.alloc(1024, 4))
  assert.equal(cache.memoryBytes, 2560)
  assert.equal(cache.diskBytes, 0)
})

test('an impossible disk reservation fails without evicting warm PCM or leaking its partial spool', async t => {
  const cache = await cacheFor(t)
  const warm = await prepare(cache, 'warm', 4096, 7)
  cache.release(warm)
  const files = (await readdir(cache.directory)).sort()
  await assert.rejects(prepare(cache, 'oversized', 8194), { code: 'AUDIO_CACHE_LIMIT' })
  assert.deepEqual(cache.scans, { memory: 0, disk: 0 })
  assert.equal(cache.entries.get('warm'), warm)
  assert.equal(warm.refs, 0)
  assert.equal(cache.diskBytes, 4096)
  assert.deepEqual((await readdir(cache.directory)).sort(), files)
  assert.deepEqual(await readFile(warm.path), Buffer.alloc(4096, 7))
  assert.equal(await cache.prepare('warm', () => { throw new Error('warm cache was needlessly decoded') }), warm)
})

test('impossible optional and mandatory memory reservations preserve warm buffers and accounting', async t => {
  const cache = await cacheFor(t)
  const warm = await prepare(cache, 'warm', 1024, 7)
  cache.release(warm)
  assert.equal(await cache.reserveMemory(2561, true), false)
  await assert.rejects(cache.reserveMemory(2561), { code: 'AUDIO_CACHE_LIMIT' })
  assert.deepEqual(cache.scans, { memory: 0, disk: 0 })
  assert.equal(cache.entries.get('warm'), warm)
  assert.equal(warm.refs, 0)
  assert.equal(cache.memoryBytes, 1024)
  assert.deepEqual(warm.buffer, Buffer.alloc(1024, 7))
})
