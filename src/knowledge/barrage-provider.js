import fs from 'fs/promises'
import path from 'path'
import { safeJoin } from '../safe-path.js'

export class BarrageProvider {
  constructor({ dir = './data/barrage' } = {}) {
    this.dir = dir
    this.configPath = path.join(this.dir, 'config.json')
    this.conceptsDir = path.join(this.dir, 'concepts')
    this.docsDir = path.join(this.dir, 'documents')
  }

  async initialize() {
    await fs.mkdir(this.dir, { recursive: true })
    await fs.mkdir(this.conceptsDir, { recursive: true })
    await fs.mkdir(this.docsDir, { recursive: true })
    
    // Create default config if it doesn't exist
    try {
      await fs.access(this.configPath)
    } catch {
      await this.saveConfig({ mode: 'llm-strict' }) // default mode
    }
  }

  // --- Global Config Management ---

  async getConfig() {
    try {
      const raw = await fs.readFile(this.configPath, 'utf8')
      const config = JSON.parse(raw)
      if (typeof config.cooldown !== 'number') {
        config.cooldown = 0
      }
      return config
    } catch (err) {
      console.error('[BarrageProvider] Failed to read config:', err.message)
      return { mode: 'llm-strict', cooldown: 0 }
    }
  }

  async saveConfig(config) {
    const { mode, document_name = '', document_path = '', priority_mode = false, random_reply = false, cooldown = 0 } = config
    let docName = document_name
    
    if (document_path) {
      const ext = path.extname(document_path)
      const localDocName = `universal_doc${ext}`
      const destPath = path.join(this.docsDir, localDocName)
      
      try {
        await fs.mkdir(this.docsDir, { recursive: true })
        // Clean any old universal docs (to prevent multiple file types mapping)
        const files = await fs.readdir(this.docsDir)
        for (const file of files) {
          if (file.startsWith('universal_doc')) {
            await fs.unlink(path.join(this.docsDir, file)).catch(() => {})
          }
        }
        await fs.copyFile(document_path, destPath)
        docName = localDocName
      } catch (err) {
        console.error(`[BarrageProvider] Failed to copy universal document file:`, err.message)
        throw err
      }
    }

    let parsedCooldown = parseInt(cooldown, 10)
    if (isNaN(parsedCooldown) || parsedCooldown < 0) {
      parsedCooldown = 0
    } else if (parsedCooldown > 3000) {
      parsedCooldown = 3000
    }
    
    const configData = {
      mode,
      document_name: docName,
      priority_mode,
      random_reply,
      cooldown: parsedCooldown
    }
    
    try {
      await fs.mkdir(this.dir, { recursive: true })
      await fs.writeFile(this.configPath, JSON.stringify(configData, null, 2), 'utf8')
    } catch (err) {
      console.error('[BarrageProvider] Failed to save config:', err.message)
      throw err
    }
  }

  // --- Concept Management ---

  async listConcepts() {
    try {
      const files = await fs.readdir(this.conceptsDir)
      return files
        .filter(f => f.endsWith('.json'))
        .map(f => f.replace('.json', ''))
    } catch (err) {
      console.error('[BarrageProvider] Failed to list concepts:', err.message)
      return []
    }
  }

  async getConcept(conceptName) {
    const filePath = safeJoin(this.conceptsDir, `${conceptName}.json`)
    try {
      const raw = await fs.readFile(filePath, 'utf8')
      return JSON.parse(raw)
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error(`[BarrageProvider] Failed to read concept ${conceptName}:`, err.message)
      }
      return null
    }
  }

  async saveConcept(conceptName, { keywords = [], priority = false }) {
    const filePath = safeJoin(this.conceptsDir, `${conceptName}.json`)
    const data = {
      keywords: Array.isArray(keywords) ? keywords : keywords.split(',').map(k => k.trim()).filter(Boolean),
      priority
    }
    
    try {
      await fs.mkdir(this.conceptsDir, { recursive: true })
      await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8')
    } catch (err) {
      console.error(`[BarrageProvider] Failed to save concept ${conceptName}:`, err.message)
      throw err
    }
  }

  async deleteConcept(conceptName) {
    const filePath = safeJoin(this.conceptsDir, `${conceptName}.json`)
    try {
      await fs.unlink(filePath)
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
  }
}

// Export a singleton instance
export const barrageProvider = new BarrageProvider()
