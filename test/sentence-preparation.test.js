import test from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { getEventListeners } from 'node:events'
import {
  splitSentences, snapshotVoice, sentenceCacheKey, SynthesisScheduler,
  SentenceBufferCache, PreparedTextSource, synthesizeSentence,
} from '../src/tts/sentence-preparation.js'

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('sentence splitting preserves natural punctuation, quotes and comma phrases', () => {
  assert.deepEqual(splitSentences('欢迎，先看这里。“这是第一站！” 然后去哪？一段没有句号的尾句'), [
    '欢迎，先看这里。', '“这是第一站！”', '然后去哪？', '一段没有句号的尾句',
  ])
  assert.deepEqual(splitSentences('Dr. Smith paid 3.14 dollars. Visit the U.S.A. site, e.g. example.com. Done!'), [
    'Dr. Smith paid 3.14 dollars.', 'Visit the U.S.A. site, e.g. example.com.', 'Done!',
  ])
  assert.deepEqual(splitSentences('One, two, three with no final punctuation'), ['One, two, three with no final punctuation'])
})

test('frozen voice snapshot and cache keys include synthesis settings', () => {
  const client = { voiceType: 'first', resourceId: 'r1', speedRatio: 1, volumeRatio: 1, sampleRate: 24000, url: 'test' }
  const snapshot = snapshotVoice(client)
  const initial = sentenceCacheKey('hello', snapshot)
  for (const key of ['voiceType', 'resourceId', 'speedRatio', 'volumeRatio', 'sampleRate', 'url']) {
    assert.notEqual(sentenceCacheKey('hello', { ...client, [key]: 'changed' }), initial)
  }
  client.voiceType = 'second'
  assert.equal(snapshot.voiceType, 'first')
  assert.equal(sentenceCacheKey('hello', snapshot), initial)
})

test('global scheduler caps synthesis at two and foreground barrage outranks speculation', async () => {
  const scheduler = new SynthesisScheduler({ concurrency: 2 })
  const blockers = [deferred(), deferred()]
  const order = []
  const first = scheduler.enqueue(() => { order.push('first'); return blockers[0].promise })
  const second = scheduler.enqueue(() => { order.push('second'); return blockers[1].promise })
  await nextTurn()
  const speculative = scheduler.enqueue(() => { order.push('speculative') }, { priority: -200 })
  const barrage = scheduler.enqueue(() => { order.push('barrage') }, { priority: 100 })
  assert.equal(scheduler.running, 2)
  blockers[0].resolve()
  await nextTurn()
  assert.deepEqual(order.slice(0, 3), ['first', 'second', 'barrage'])
  blockers[1].resolve()
  await Promise.all([first, second, speculative, barrage])
})

test('queued cancellation never opens a synthesis call', async () => {
  const scheduler = new SynthesisScheduler({ concurrency: 1 })
  const block = deferred(), cancel = new AbortController()
  const active = scheduler.enqueue(() => block.promise)
  await nextTurn()
  let called = false
  const queued = scheduler.enqueue(() => { called = true }, { signal: cancel.signal })
  cancel.abort()
  await assert.rejects(queued, { name: 'AbortError' })
  block.resolve()
  await active
  await nextTurn()
  assert.equal(called, false)
})

test('cache pins count toward capacity, unused LRU entries evict and releases are idempotent', () => {
  const cache = new SentenceBufferCache({ maxBytes: 8 })
  const a = cache.insert('a', Buffer.alloc(6))
  assert.throws(() => cache.insert('b', Buffer.alloc(4)), /缓存已满/)
  a.release(); a.release()
  const b = cache.insert('b', Buffer.alloc(4))
  assert.equal(cache.acquire('a'), null)
  assert.equal(cache.bytes, 4)
  b.release()
  assert.throws(() => cache.insert('oversized', Buffer.alloc(9)), /超过/)
})

test('sentence preparation aborts only its own call and ignores late callbacks', async () => {
  const controller = new AbortController()
  let callbacks, aborted = 0
  const client = { synthesizeStream(_text, chunk, finish, error) {
    callbacks = { chunk, finish, error }
    return { abort() { aborted++ } }
  } }
  const pending = synthesizeSentence(client, 'sentence', { signal: controller.signal })
  callbacks.chunk(Buffer.from('one'))
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  callbacks.chunk(Buffer.from('late')); callbacks.finish(); callbacks.error(new Error('late'))
  assert.equal(aborted, 1)
})

test('empty and oversized sentences fail before exposing a prepared buffer', async () => {
  await assert.rejects(synthesizeSentence({ synthesizeStream(_t, _c, done) { done(); return { abort() {} } } }, 'empty'), /未返回/)
  await assert.rejects(synthesizeSentence({ synthesizeStream(_t, chunk, done) { chunk(Buffer.alloc(10)); done(); return { abort() {} } } }, 'large', { maxBytes: 5 }), /超过/)
})

test('prepared source bounds its window and reuses frozen voice cache across loops', async () => {
  const calls = []
  const cache = new SentenceBufferCache({ maxBytes: 1024 })
  const client = { voiceType: 'initial', synthesizeStream(text, chunk, finish) {
    calls.push({ text, voice: this.voiceType }); chunk(Buffer.from(text)); finish(); return { abort() {} }
  } }
  const source = new PreparedTextSource('一。二。三。四。', client, { cache, scheduler: new SynthesisScheduler() })
  source.prefetch(0)
  client.voiceType = 'changed'
  await Promise.all([source.get(0), source.get(1), source.get(2)])
  assert.equal(calls.length, 3)
  assert.equal(source.units.size, 3)
  assert.ok(calls.every(call => call.voice === 'initial'))
  source.releaseBefore(2)
  source.prefetch(2)
  await source.get(3)
  source.releaseBefore(4)
  await source.get(0)
  assert.equal(calls.length, 4, 'loop used cached first sentence')
  source.release()
  await assert.rejects(source.get(1), { name: 'AbortError' })
  assert.ok([...cache.entries.values()].every(entry => entry.refs === 0))
})

test('retiring a reusable source window cancels active and queued synthesis without retaining listeners', async t => {
  const calls = []
  const cache = new SentenceBufferCache({ maxBytes: 1024 })
  const scheduler = new SynthesisScheduler({ concurrency: 1 })
  const client = { synthesizeStream(text, chunk, finish, error) {
    const call = { text, aborted: 0, ready() { chunk(Buffer.from(text)); finish() }, error,
      abort() { this.aborted++ } }
    calls.push(call)
    return call
  } }
  const source = new PreparedTextSource('一。二。三。', client, { cache, scheduler })
  t.after(() => source.release())
  source.prefetch(0)
  const first = source.get(0), second = source.get(1)
  const discarded = [assert.rejects(first, { name: 'AbortError' }), assert.rejects(second, { name: 'AbortError' })]
  await nextTurn()
  assert.deepEqual(calls.map(call => call.text), ['一。'])
  assert.equal(scheduler.queue.length, 2)
  source.releaseBefore(2)
  await Promise.all(discarded)
  await nextTurn()
  assert.equal(calls[0].aborted, 1)
  assert.deepEqual(calls.map(call => call.text), ['一。', '三。'], 'retired queued sentence must never open a provider call')
  assert.equal(scheduler.running, 1)
  assert.equal(scheduler.queue.length, 0)
  assert.equal(source.signal.aborted, false, 'window retirement must preserve the reusable source')
  calls[0].ready(); calls[0].error(new Error('late retired response'))
  calls[1].ready()
  assert.equal((await source.get(2)).text, '三。')
  assert.equal(cache.entries.size, 1, 'late cancelled audio must not enter the voice cache')
  assert.equal(getEventListeners(source.signal, 'abort').length, 0)
  source.releaseBefore(source.length)
  assert.ok([...cache.entries.values()].every(entry => entry.refs === 0))

  const retry = source.get(0)
  await nextTurn()
  assert.equal(calls.length, 3)
  calls[2].ready()
  assert.equal((await retry).text, '一。', 'a cancelled unit may be freshly prepared on the next loop')
  assert.equal(getEventListeners(source.signal, 'abort').length, 0)
})
