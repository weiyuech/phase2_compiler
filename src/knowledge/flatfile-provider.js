import fs   from 'fs/promises'
import path from 'path'
import { safeJoin } from '../safe-path.js'

export class FlatFileProvider {
  constructor({ dir }) {
    this.dir = dir
  }

  // Derive filename from goalId + optional goalObject
  _filename(goalId, goalObject) {
    return goalObject ? `${goalId}-${goalObject}.json` : `${goalId}.json`
  }

  // Parse a filename back to { goalId, goalObject }
  _parseFilename(name) {
    const base = name.replace('.json', '')
    const dashIdx = base.indexOf('-')
    if (dashIdx === -1) return { goalId: base, goalObject: null }
    return { goalId: base.slice(0, dashIdx), goalObject: base.slice(dashIdx + 1) }
  }

  /**
   * Lookup order: {goalId}-{goalObject}.json → {goalId}.json (generic fallback)
   */
  async getContent(mapName, pathName, goalId, goalObject = null) {
    const candidates = []
    try {
      if (goalObject) candidates.push(safeJoin(this.dir, mapName, pathName, `${goalId}-${goalObject}.json`))
      candidates.push(safeJoin(this.dir, mapName, pathName, `${goalId}.json`))
    } catch {
      return null   // 名字非法 → 当作查不到，读取路径不该因此抛错
    }

    for (const filePath of candidates) {
      try {
        const raw = await fs.readFile(filePath, 'utf8')
        return JSON.parse(raw)
      } catch (err) {
        if (err.code !== 'ENOENT') console.error(`[知识库] 读取出错 ${filePath}:`, err.message)
      }
    }
    return null
  }

  async listMaps() {
    try {
      const entries = await fs.readdir(this.dir, { withFileTypes: true })
      return entries.filter(e => e.isDirectory()).map(e => e.name)
    } catch (err) {
      console.error('[知识库] 无法读取地图列表:', err.message)
      return []
    }
  }

  async listPaths(mapName) {
    const mapDir = path.join(this.dir, mapName)
    try {
      const entries = await fs.readdir(mapDir, { withFileTypes: true })
      return entries.filter(e => e.isDirectory()).map(e => e.name)
    } catch (err) {
      console.error(`[知识库] 无法读取路径列表 (${mapName}):`, err.message)
      return []
    }
  }

  /**
   * Returns composite keys: "1" for generic, "1-car" for object-specific.
   */
  async listPoints(mapName, pathName) {
    const pathDir = path.join(this.dir, mapName, pathName)
    try {
      const files = await fs.readdir(pathDir)
      return files
        .filter(f => f.endsWith('.json'))
        .map(f => f.replace('.json', ''))
        .sort((a, b) => {
          const { goalId: aId, goalObject: aObj } = this._parseFilename(a + '.json')
          const { goalId: bId, goalObject: bObj } = this._parseFilename(b + '.json')
          const idDiff = Number(aId) - Number(bId)
          if (idDiff !== 0) return idDiff
          if (!aObj && bObj) return -1   // generic before specific
          if (aObj && !bObj) return 1
          return (aObj || '').localeCompare(bObj || '')
        })
    } catch (err) {
      console.error(`[知识库] 无法读取点位列表 (${mapName}/${pathName}):`, err.message)
      return []
    }
  }

  /**
   * goal_object present → saves to {goalId}-{goal_object}.json
   * goal_object absent  → saves to {goalId}.json (generic)
   */
  async saveEntry(mapName, pathName, goalId, { goal_object, body }) {
    // 地图名/路径名来自控制台消息，必须做包含性校验，否则 ".." 可以写到
    // 数据目录之外（曾经可以覆盖 config/admin.json）
    const dir      = safeJoin(this.dir, mapName, pathName)
    const filename = this._filename(goalId, goal_object || null)
    const filePath = safeJoin(dir, filename)
    await fs.mkdir(dir, { recursive: true })
    const content = {}
    if (goal_object) content.goal_object = goal_object
    if (body)        content.body        = body
    await fs.writeFile(filePath, JSON.stringify(content, null, 2), 'utf8')
  }

  async deleteEntry(mapName, pathName, goalId, goalObject = null) {
    const filename = this._filename(goalId, goalObject)
    const filePath = safeJoin(this.dir, mapName, pathName, filename)
    try { await fs.unlink(filePath) }
    catch (err) { if (err.code !== 'ENOENT') throw err }
  }

  async healthCheck() {
    try { await fs.mkdir(this.dir, { recursive: true }); return true }
    catch { return false }
  }
}
