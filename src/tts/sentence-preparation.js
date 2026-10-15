import crypto from 'node:crypto'

export function abortError() {
  return Object.assign(new Error('Audio preparation cancelled'), { name: 'AbortError' })
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError()
}

// Sentence punctuation is meaningful; commas are not boundaries. Protect the
// common abbreviations/initials and decimal points before considering a period.
const ABBREVIATIONS = /(?:\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e)|(?:\b[A-Za-z]\.)+[A-Za-z])\.$/i
const CLOSERS = /[”’"'」』）)\]】》]/
const MAX_SENTENCE_CODEPOINTS = 500
const NUMBER_CHARACTER = /[0-9０-９]/u

function splitsNumber(characters, index) {
  const left = characters[index - 1], right = characters[index]
  return (NUMBER_CHARACTER.test(left || '') && /[0-9０-９.,，．]/u.test(right || ''))
    || (/[.,，．]/u.test(left || '') && NUMBER_CHARACTER.test(right || ''))
}

function splitLongSentence(sentence) {
  if (sentence.length <= MAX_SENTENCE_CODEPOINTS) return [sentence]
  // Count code points rather than UTF-16 units, so a fallback cut never splits
  // a surrogate pair. Short sentences retain the existing punctuation rules.
  const characters = Array.from(sentence)
  const parts = []
  let start = 0
  while (characters.length - start > MAX_SENTENCE_CODEPOINTS) {
    const limit = start + MAX_SENTENCE_CODEPOINTS
    const minimum = start + Math.floor(MAX_SENTENCE_CODEPOINTS / 2)
    let end = limit
    let separatorFound = false
    for (let boundary = limit; boundary >= minimum; boundary--) {
      if (/[，,、\s]/u.test(characters[boundary - 1]) && !splitsNumber(characters, boundary)) {
        end = boundary
        separatorFound = true
        break
      }
    }
    if (!separatorFound) {
      // Keep an ordinary decimal/thousands-separated number together when a
      // nearby cut is available. An exceptionally long numeric token is still
      // bounded by the same limit rather than becoming an unbounded TTS unit.
      while (end > minimum && splitsNumber(characters, end)) end--
      if (splitsNumber(characters, end)) end = limit
    }
    // Keep punctuation and all spoken content. Trim only the new boundaries,
    // matching the existing sentence-boundary whitespace normalization and
    // avoiding whitespace-only synthesis requests after a long whitespace run.
    const part = characters.slice(start, end).join('').trim()
    if (part) parts.push(part)
    start = end
  }
  const tail = characters.slice(start).join('').trim()
  if (tail) parts.push(tail)
  return parts
}

export function splitSentences(text) {
  const value = String(text || '').trim()
  if (!value) return []
  const sentences = []
  let start = 0
  for (let index = 0; index < value.length; index++) {
    const char = value[index]
    if (!'。！？!?；;.'.includes(char)) continue
    if (char === '.') {
      if (/\d/.test(value[index - 1] || '') && /\d/.test(value[index + 1] || '')) continue
      if (/[A-Za-z0-9]/.test(value[index + 1] || '')) continue // host names/initials
      if (ABBREVIATIONS.test(value.slice(start, index + 1))) continue
      if (/\b[A-Z]\.$/.test(value.slice(start, index + 1))) continue
    }
    while (index + 1 < value.length && '。！？!?…'.includes(value[index + 1])) index++
    while (index + 1 < value.length && value[index + 1] === '.' && char === '.') index++
    while (index + 1 < value.length && CLOSERS.test(value[index + 1])) index++
    const sentence = value.slice(start, index + 1).trim()
    if (sentence) sentences.push(sentence)
    start = index + 1
  }
  const tail = value.slice(start).trim()
  if (tail) sentences.push(tail)
  return sentences.flatMap(splitLongSentence)
}

export function snapshotVoice(client) {
  // Copy the client, not just its voice name: a settings edit while requests are
  // queued must not change credentials, endpoint, voice or audio parameters.
  return Object.freeze(Object.assign(Object.create(Object.getPrototypeOf(client)), client))
}

export function sentenceCacheKey(text, client) {
  const voice = ['voiceType', 'resourceId', 'cluster', 'speedRatio', 'volumeRatio', 'sampleRate', 'url']
    .map(key => [key, client[key]])
  return crypto.createHash('sha256').update(JSON.stringify({ text, voice, format: 'mp3' })).digest('hex')
}

export class SynthesisScheduler {
  constructor({ concurrency = 2 } = {}) {
    this.concurrency = concurrency
    this.running = 0
    this.queue = []
    this.nextOrder = 0
  }

  enqueue(task, { signal, priority = 0 } = {}) {
    let item
    const promise = new Promise((resolve, reject) => {
      item = { task, signal, priority, resolve, reject, order: this.nextOrder++, started: false }
      item.abort = () => {
        if (item.started) return // running task owns its abortable provider call
        this.queue = this.queue.filter(entry => entry !== item)
        reject(abortError())
      }
      if (signal?.aborted) { reject(abortError()); return }
      signal?.addEventListener('abort', item.abort, { once: true })
      this.queue.push(item)
      // Defer one microtask so simultaneous foreground jobs outrank prefetch.
      queueMicrotask(() => this._pump())
    })
    promise.promote = priority => {
      item.priority = Math.max(item.priority, priority)
      this._pump()
    }
    return promise
  }

  _pump() {
    this.queue.sort((a, b) => b.priority - a.priority || a.order - b.order)
    while (this.running < this.concurrency && this.queue.length) {
      const item = this.queue.shift()
      item.signal?.removeEventListener('abort', item.abort)
      if (item.signal?.aborted) { item.reject(abortError()); continue }
      item.started = true
      this.running++
      Promise.resolve().then(() => item.task()).then(item.resolve, item.reject).finally(() => {
        this.running--
        this._pump()
      })
    }
  }
}

// Compressed synthesis cache is separate from the router's 64 MiB PCM cache.
// Pinned window entries count toward this 8 MiB limit; no unbounded per-tour
// duplicate cache is retained. Capacity failure leaves the current speaker alone.
export class SentenceBufferCache {
  constructor({ maxBytes = 8 * 1024 * 1024 } = {}) {
    this.maxBytes = maxBytes
    this.bytes = 0
    this.entries = new Map()
  }

  acquire(key) {
    const entry = this.entries.get(key)
    if (!entry) return null
    this.entries.delete(key)
    this.entries.set(key, entry)
    entry.refs++
    let released = false
    return { buffer: entry.buffer, release: () => { if (!released) { released = true; entry.refs-- } } }
  }

  insert(key, buffer) {
    if (this.entries.has(key)) return this.acquire(key)
    if (buffer.length > this.maxBytes) throw new Error('单句合成音频超过准备缓存容量')
    for (const [oldKey, old] of this.entries) {
      if (this.bytes + buffer.length <= this.maxBytes) break
      if (old.refs) continue
      this.entries.delete(oldKey)
      this.bytes -= old.buffer.length
    }
    if (this.bytes + buffer.length > this.maxBytes) throw new Error('语音准备缓存已满，请缩短单句或稍后重试')
    this.entries.set(key, { buffer, refs: 0 })
    this.bytes += buffer.length
    return this.acquire(key)
  }
}

export const synthesisScheduler = new SynthesisScheduler()
export const sentenceBufferCache = new SentenceBufferCache()

export function synthesizeSentence(client, text, { signal, maxBytes = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let call, settled = false, bytes = 0
    const chunks = []
    const settle = (fn, value) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', cancel)
      fn(value)
    }
    const cancel = () => {
      settle(reject, abortError())
      try { call?.abort() } catch {}
    }
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) { cancel(); return }
    try {
      call = client.synthesizeStream(text, chunk => {
        if (settled) return
        const copy = Buffer.from(chunk)
        bytes += copy.length
        if (bytes > maxBytes) {
          settle(reject, new Error('单句合成音频超过准备缓存容量'))
          try { call?.abort() } catch {}
          return
        }
        chunks.push(copy)
      }, () => {
        if (!bytes) settle(reject, new Error('TTS 未返回音频'))
        else settle(resolve, Buffer.concat(chunks, bytes))
      }, error => settle(reject, error))
      if (settled) { try { call?.abort() } catch {} }
    } catch (error) { settle(reject, error) }
  })
}

export class PreparedTextSource {
  constructor(text, client, {
    signal, role = 'cruise', scheduler = synthesisScheduler, cache = sentenceBufferCache,
    isCurrent = () => true, diagnostics,
  } = {}) {
    this.text = text
    this.sentences = splitSentences(text)
    this.client = snapshotVoice(client)
    this.role = role
    this.scheduler = scheduler
    this.cache = cache
    this.isCurrent = isCurrent
    this.diagnostics = diagnostics
    this.sessionId = crypto.randomUUID()
    this.controller = new AbortController()
    this.units = new Map()
    this._external = signal
    this._abortExternal = () => this.release()
    signal?.addEventListener('abort', this._abortExternal, { once: true })
    if (signal?.aborted) this.release()
  }

  get signal() { return this.controller.signal }
  get length() { return this.sentences.length }
  priority(speculative) {
    return ({ barrage: 100, cruise: 60, transit: 20 }[this.role] || 0) - (speculative ? 200 : 0)
  }

  get(index, { speculative = false } = {}) {
    if (this.signal.aborted || !this.isCurrent()) return Promise.reject(abortError())
    if (index < 0 || index >= this.length) return Promise.reject(new Error('Invalid sentence index'))
    const existing = this.units.get(index)
    if (existing) {
      if (!speculative) existing.scheduled?.promote(this.priority(false))
      return existing.promise
    }
    const text = this.sentences[index]
    const key = sentenceCacheKey(text, this.client)
    const unit = { handle: null, scheduled: null, promise: null }
    this.units.set(index, unit)
    const cached = this.cache.acquire(key)
    if (cached) {
      unit.handle = cached
      unit.promise = Promise.resolve({ text, index, key, buffer: cached.buffer })
    } else {
      const started = performance.now()
      this.diagnostics?.event?.('prepare-start', { source: this.role === 'cruise' ? 'point' : this.role, sessionId: this.sessionId, sentenceIndex: index })
      unit.scheduled = this.scheduler.enqueue(async () => {
        throwIfAborted(this.signal)
        const reusable = this.cache.acquire(key)
        if (reusable) return reusable
        const buffer = await synthesizeSentence(this.client, text, { signal: this.signal, maxBytes: this.cache.maxBytes })
        throwIfAborted(this.signal)
        return this.cache.insert(key, buffer)
      }, { signal: this.signal, priority: this.priority(speculative) })
      unit.promise = unit.scheduled.then(handle => {
        if (this.signal.aborted || !this.isCurrent() || this.units.get(index) !== unit) {
          handle.release()
          throw abortError()
        }
        unit.handle = handle
        this.diagnostics?.event?.('prepared', { source: this.role === 'cruise' ? 'point' : this.role, sessionId: this.sessionId,
          sentenceIndex: index, synthesisMs: performance.now() - started, bytes: handle.buffer.length })
        return { text, index, key, buffer: handle.buffer }
      })
    }
    unit.promise.catch(() => {}) // Prefetch errors surface when this unit is needed.
    return unit.promise
  }

  prefetch(index) {
    for (let next = index; next < Math.min(this.length, index + 3); next++) {
      this.get(next, { speculative: next !== index }).catch(() => {})
    }
  }

  releaseBefore(index) {
    for (const [oldIndex, unit] of this.units) {
      if (oldIndex >= index) continue
      unit.handle?.release()
      this.units.delete(oldIndex)
    }
  }

  release() {
    this.controller.abort()
    this._external?.removeEventListener('abort', this._abortExternal)
    for (const unit of this.units.values()) unit.handle?.release()
    this.units.clear()
  }
}
