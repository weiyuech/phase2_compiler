import fs   from 'fs/promises'
import path from 'path'

export class BannedWordFilter {
  constructor(filePath) {
    this.filePath = filePath
    this.words    = []
  }

  async load() {
    try {
      const raw  = await fs.readFile(this.filePath, 'utf8')
      this.words = raw
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'))
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error('[禁词] 加载出错:', err.message)
      }
    }
  }

  clean(text, fallbackText, bannedWords = this.words) {
    if (!bannedWords.length) return { text, hadViolation: false, matched: [] }

    const matched = bannedWords.filter(word =>
      text.toLowerCase().includes(word.toLowerCase())
    )

    if (matched.length > 0) {
      return { text: fallbackText, hadViolation: true, matched }
    }

    return { text, hadViolation: false, matched: [] }
  }
}
