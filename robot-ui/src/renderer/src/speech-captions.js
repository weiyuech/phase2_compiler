/** Caption ownership survives interruption without counting each sentence. */
export class SpeechCaptions {
  constructor() { this.entries = new Map(); this.currentId = null; this.order = 0 }
  start(data) {
    const id = data.utteranceId || 'legacy'
    const isNew = !this.entries.has(id)
    this.entries.set(id, { ...data, id, order: this.order++, text: data.text || `[MP3] ${data.mp3_file || ''}` })
    this.currentId = id
    return isNew
  }
  sentence(data) {
    const entry = this.entries.get(data.utteranceId)
    if (!entry) return // stale updates never resurrect a completed utterance
    entry.text = data.text || ''
    this.currentId = entry.id
  }
  end(data = {}) {
    if (data.utteranceId) this.entries.delete(data.utteranceId)
    else if (data.source) {
      for (const [id, entry] of this.entries) if (entry.source === data.source) this.entries.delete(id)
    } else this.entries.clear()
    if (!this.entries.has(this.currentId)) {
      const priority = { barrage: 3, point: 2, transit: 1 }
      const next = [...this.entries.values()].sort((a, b) =>
        (priority[b.source] || 0) - (priority[a.source] || 0) || b.order - a.order)[0]
      this.currentId = next?.id || null
    }
  }
  get text() { return this.entries.get(this.currentId)?.text || '' }
}
