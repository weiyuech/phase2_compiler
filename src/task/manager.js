import { EventEmitter } from 'events'
import fs   from 'fs'
import path from 'path'

/**
 * TaskManager — tour list data management
 *
 * Stores an ordered array of tour items and persists it to a JSON file.
 * Tracks currentIndex so list mutations during a live tour stay coherent.
 *
 * Each item: { map_name, path_name, goal_id, goal_object, play_mode }
 * play_mode: 'tts' (default) | 'mp3'
 *
 * Events:
 *   'list-changed'    (items)           — emitted after any mutation
 *   'current-removed' ({ nextIndex })   — emitted when the currently-executing
 *                                         item is deleted; nextIndex is where
 *                                         execution should resume (-1 if list empty)
 */
export class TaskManager extends EventEmitter {
  constructor({ filePath = './data/tour-list.json' } = {}) {
    super()
    this._filePath         = filePath
    this._list             = []
    this._currentIndex     = -1     // -1 = not running
    this._running          = false
    this._paused           = false
    this._repeatCount      = 1      // total number of full passes (1 = play once)
    this._currentIteration = 0      // 1-based, incremented at start()
    this._load()
  }

  // ── Accessors ──────────────────────────────────────────────────────────────

  getList() {
    return this._list.map(item => ({ ...item }))
  }

  get currentIndex() {
    return this._currentIndex
  }

  get currentItem() {
    return this._currentIndex >= 0 ? { ...this._list[this._currentIndex] } : null
  }

  get isRunning() { return this._running }
  get isPaused()  { return this._paused  }

  get repeatCount()      { return this._repeatCount }
  get currentIteration() { return this._currentIteration }

  // ── Execution state ────────────────────────────────────────────────────────

  /**
   * Start tour from the beginning.
   * @param {number} [repeatCount=1] - total full passes through the list.
   *   1 = play once (default), 2 = play twice, etc. Values <1 are clamped to 1.
   * @returns {boolean} false if list is empty
   */
  start(repeatCount = 1) {
    if (this._list.length === 0) return false
    const n = Math.floor(Number(repeatCount))
    this._repeatCount      = Number.isFinite(n) && n >= 1 ? n : 1
    this._currentIteration = 1
    this._currentIndex     = 0
    this._running          = true
    this._paused           = false
    return true
  }

  pause() {
    if (!this._running) return
    this._paused = true
  }

  resume() {
    if (!this._running) return
    this._paused = false
  }

  stop() {
    this._currentIndex     = -1
    this._running          = false
    this._paused           = false
    this._currentIteration = 0
  }

  /**
   * Advance to the next item. Returns the new currentItem, or null if the
   * tour is finished (all iterations played through).
   *
   * When past the last item and iterations remain, jumps back to index 0
   * and increments _currentIteration.
   */
  advance() {
    if (!this._running) return null
    this._currentIndex++
    if (this._currentIndex >= this._list.length) {
      if (this._currentIteration < this._repeatCount) {
        this._currentIteration++
        this._currentIndex = 0
        return this.currentItem
      }
      this.stop()
      return null
    }
    return this.currentItem
  }

  /** Called by the execution layer to jump to a specific index. */
  setCurrentIndex(index) {
    this._currentIndex = index
  }

  // ── Mutations ──────────────────────────────────────────────────────────────

  /**
   * Replace the entire list (e.g. after a drag-reorder in the UI).
   * If a tour is running, re-anchors currentIndex by identity match.
   * Emits 'current-removed' if the running item no longer exists.
   */
  setList(items) {
    const prev = this._currentIndex >= 0 ? this._list[this._currentIndex] : null
    const successors = this._list.slice(this._currentIndex + 1)
    const samePoint = (a, b) => a.map_name === b.map_name &&
      a.path_name === b.path_name && a.goal_id === b.goal_id

    this._list = items.map(item => ({ ...item }))

    if (prev !== null) {
      const newIndex = this._list.findIndex(item => samePoint(item, prev))
      if (newIndex === -1) {
        // The UI submits the entire edited list. Deleting the current point
        // must continue with its next surviving successor, not restart at 0.
        let nextIndex = -1
        for (const next of successors) {
          nextIndex = this._list.findIndex(item => samePoint(item, next))
          if (nextIndex !== -1) break
        }
        this._currentIndex = -1
        this._save()
        this.emit('list-changed', this.getList())
        this.emit('current-removed', { nextIndex })
        return
      }
      this._currentIndex = newIndex
    }

    this._save()
    this.emit('list-changed', this.getList())
  }

  /** Append a new item to the end of the list. */
  addItem(item) {
    this._list.push({ ...item })
    this._save()
    this.emit('list-changed', this.getList())
  }

  /**
   * Insert an item at the given index.
   * If the insertion point is at or before currentIndex, shifts currentIndex
   * forward by one so it still points to the same item.
   */
  insertItem(index, item) {
    const i = Math.max(0, Math.min(index, this._list.length))
    this._list.splice(i, 0, { ...item })

    if (this._currentIndex >= 0 && i <= this._currentIndex) {
      this._currentIndex++
    }

    this._save()
    this.emit('list-changed', this.getList())
  }

  /**
   * Remove the item at the given index.
   * - Before current: shifts currentIndex back by one.
   * - Is current:     emits 'current-removed'; nextIndex points to the item
   *                   that slides into this slot (or -1 if list is now empty).
   * - After current:  no index change.
   */
  removeItem(index) {
    if (index < 0 || index >= this._list.length) return

    this._list.splice(index, 1)

    if (this._currentIndex >= 0) {
      if (index < this._currentIndex) {
        this._currentIndex--
        this._save()
        this.emit('list-changed', this.getList())
      } else if (index === this._currentIndex) {
        const nextIndex = index < this._list.length ? index : -1
        this._currentIndex = -1
        this._save()
        this.emit('list-changed', this.getList())
        this.emit('current-removed', { nextIndex })
      } else {
        this._save()
        this.emit('list-changed', this.getList())
      }
    } else {
      this._save()
      this.emit('list-changed', this.getList())
    }
  }

  /** Clear the entire list. Emits 'current-removed' if a tour was running. */
  clear() {
    const wasRunning = this._currentIndex >= 0
    this._list         = []
    this._currentIndex = -1
    this._save()
    this.emit('list-changed', this.getList())
    if (wasRunning) this.emit('current-removed', { nextIndex: -1 })
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  _load() {
    try {
      const raw  = fs.readFileSync(this._filePath, 'utf8')
      this._list = JSON.parse(raw)
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error('[TaskManager] Failed to load tour list:', err.message)
      }
      this._list = []
    }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this._filePath), { recursive: true })
      fs.writeFileSync(this._filePath, JSON.stringify(this._list, null, 2), 'utf8')
    } catch (err) {
      console.error('[TaskManager] Failed to save tour list:', err.message)
    }
  }
}
