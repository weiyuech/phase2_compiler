import './crash-guard.js'
import 'dotenv/config'
import { join } from 'node:path'
import fs from 'fs/promises'

// Support running inside packaged Electron via utilityProcess.fork()
if (process.env.PROJECT_ROOT) process.chdir(process.env.PROJECT_ROOT)

// 可写数据和配置目录：打包模式用 Electron userData，开发模式用当前目录
const DATA_DIR = process.env.USER_DATA_DIR
  ? join(process.env.USER_DATA_DIR, 'data')
  : './data'

const CONFIG_DIR = process.env.USER_DATA_DIR
  ? join(process.env.USER_DATA_DIR, 'config')
  : './config'

process.env.BANNED_WORDS_FILE = join(CONFIG_DIR, 'banned-words.txt')

import { reloadPrompt }               from './llm/prompt.js'
import { createKnowledgeBaseProvider } from './knowledge/index.js'
import { LLMRewriter }                 from './llm/index.js'
import { TTSEngine }                   from './tts/index.js'
import { AudioOutputRouter }           from './tts/audio-output-router.js'
import { TransitAudioManager }         from './transit/manager.js'
import { RobotListener }               from './robot/listener.js'
import { TaskManager }                 from './task/manager.js'
import * as uiBridge                   from './ui-bridge.js'
import { startTunnel, stopTunnel }     from './tunnel.js'
import { initPhase2 }                  from './phase2/index.js'
import { barrageProvider }             from './knowledge/barrage-provider.js'
import { safeJoin }                    from './safe-path.js'

// ── Initialise modules ────────────────────────────────────────────────────────

uiBridge.start()

const kb = await createKnowledgeBaseProvider({
  KB_FLATFILE_DIR: join(DATA_DIR, 'flatfiles'),
  KB_SQLITE_PATH:  join(DATA_DIR, 'knowledge.db'),
})

// Initialize the Barrage Provider (stores in DATA_DIR/barrage-knowledge)
barrageProvider.dir = join(DATA_DIR, 'barrage-knowledge')
barrageProvider.configPath = join(barrageProvider.dir, 'config.json')
barrageProvider.conceptsDir = join(barrageProvider.dir, 'concepts')
barrageProvider.docsDir = join(barrageProvider.dir, 'documents')
await barrageProvider.initialize()
const healthy = await kb.healthCheck()
if (!healthy) process.exit(1)

const llm = new LLMRewriter()
await llm.init()

const robot = new RobotListener(
  process.env.ROBOT_URL
    ? { url: process.env.ROBOT_URL }
    : { port: parseInt(process.env.ROBOT_PORT || '8765') }
)

const audioOutput = new AudioOutputRouter({
  robot,
  filePath: join(DATA_DIR, 'audio-output.json'),
})

const tts = new TTSEngine({ audioOutput })

// -- Separate Barrage (弹幕) LLM & TTS Clients --
const barrageLlm = new LLMRewriter({
  DOUBAO_API_KEY: process.env.BARRAGE_DOUBAO_API_KEY,
  DOUBAO_MODEL: process.env.BARRAGE_DOUBAO_MODEL,
  DEEPSEEK_API_KEY: process.env.BARRAGE_DEEPSEEK_API_KEY,
  DEEPSEEK_MODEL: process.env.BARRAGE_DEEPSEEK_MODEL,
  LLM_TIMEOUT_MS: process.env.BARRAGE_LLM_TIMEOUT_MS,
  LLM_MAX_TOKENS: process.env.BARRAGE_LLM_MAX_TOKENS,
  BANNED_WORDS_FILE: process.env.BANNED_WORDS_FILE || './config/banned-words.txt'
})
await barrageLlm.init()

const barrageTts = new TTSEngine({
  audioOutput,
  TTS_APP_ID: process.env.BARRAGE_TTS_APP_ID,
  TTS_ACCESS_TOKEN: process.env.BARRAGE_TTS_ACCESS_TOKEN,
  TTS_API_KEY: process.env.BARRAGE_TTS_API_KEY,
  TTS_AUTH_MODE: process.env.BARRAGE_TTS_AUTH_MODE,
  TTS_PROTOCOL: process.env.BARRAGE_TTS_PROTOCOL,
  TTS_VOICE_TYPE: process.env.BARRAGE_TTS_VOICE_TYPE,
  TTS_CLUSTER: process.env.BARRAGE_TTS_CLUSTER,
  TTS_RESOURCE_ID: process.env.BARRAGE_TTS_RESOURCE_ID,
  TTS_TIMEOUT_MS: process.env.BARRAGE_TTS_TIMEOUT_MS
})

const transitAudio = new TransitAudioManager({
  filePath: join(DATA_DIR, 'transit-audio.json'),
  audioOutput,
})

// Speaking state driven by renderer mic detection (via DUCK_START / DUCK_END commands on ws:3001)
let isSpeaking = false
let isHostSpeaking = false
let isBarrageSpeaking = false

function updateCruisingDucking() {
  const shouldPause = isHostSpeaking || isBarrageSpeaking
  if (shouldPause) {
    tts.player.pause()
    transitAudio.pause()
  } else {
    tts.player.resume()
    transitAudio.resume()
  }
}

const tour  = new TaskManager({ filePath: join(DATA_DIR, 'tour-list.json') })

// -- Phase 2 Sandbox Initialization --
const phase2 = initPhase2({
  robot,
  tour,
  llm: barrageLlm,
  tts: barrageTts,
  uiBridge,
  transitAudio,
  checkGoalHandling: () => _goalHandling,
  checkIsSpeaking: () => isSpeaking,
  onBarrageSpeechStart: () => {
    isBarrageSpeaking = true
    updateCruisingDucking()
  },
  onBarrageSpeechEnd: () => {
    isBarrageSpeaking = false
    updateCruisingDucking()
  }
})

// Track the map currently loaded on the robot so we only switch when it changes
let currentMap     = null
let robotConnected = false
let lastMapList    = null   // cached so new UI clients get the list immediately
let lastPaths      = null   // { map_name, paths } — cached path list for current map
let lastHeartbeat  = null   // most recent heartbeat, used for same-map short-circuit
let _goalHandling  = false  // prevents concurrent goal-reached processing
let _session       = 0      // incremented by skip/stop/disconnect to invalidate in-flight goal-reached

// ── State snapshot for late-joining UI clients ────────────────────────────────

uiBridge.on('onNewClient', (sendTo) => {
  sendTo('TRANSIT_CONFIG', transitAudio.getConfig())
  sendTo('AUDIO_OUTPUT_CONFIG', {
    ...audioOutput.getConfig(),
    robotConnected,
  })
  if (robotConnected) {
    sendTo('ROBOT_CONNECTED', {})
    if (lastMapList)  sendTo('MAP_LIST',  { maps: lastMapList })
    if (currentMap)   sendTo('MAP_SWITCHED', { map_name: currentMap })
    if (lastPaths)    sendTo('PATH_LIST', lastPaths)
  } else {
    sendTo('ROBOT_DISCONNECTED', {})
  }
})

// ── UI Bridge commands ────────────────────────────────────────────────────────

uiBridge.on('onTestSpeech',    async (text) => {
  try {
    const res = await tts.speak(text)
    if (res && res.ok === false) {
      uiBridge.broadcast('ERROR', { message: `手动播报测试失败: ${res.error.message}` })
    }
  } catch (err) {
    console.error('[系统] 手动播报测试失败:', err.message)
    uiBridge.broadcast('ERROR', { message: `手动播报测试失败: ${err.message}` })
  }
})
uiBridge.on('onDuckStart', () => {
  console.log('[Ducking Debug] 🎤 DUCK_START received (Co-host speaking). Pausing cruising TTS & stopping barrage speech.')
  isHostSpeaking = true
  isSpeaking = true
  updateCruisingDucking()
  if (phase2 && phase2.barrageManager) {
    phase2.barrageManager.stopSpeech()
  }
})
uiBridge.on('onDuckEnd', () => {
  console.log('[Ducking Debug] 🤫 DUCK_END received (Co-host quiet). Resuming cruising TTS.')
  isHostSpeaking = false
  isSpeaking = false
  updateCruisingDucking()
})

uiBridge.on('onSelectMap', async (mapName) => {
  if (!mapName) return

  // ── 短路：机器人已在该地图且 ready，无需发切换命令 ─────────────────────────
  const hbMap = lastHeartbeat?.map
  if (hbMap?.name === mapName && hbMap?.status === 'ready') {
    console.log(`[系统] 地图已就绪，跳过切换: ${mapName}`)
    currentMap = mapName
    uiBridge.broadcast('MAP_SWITCHED', { map_name: mapName })
    robot.sendGetPathList(mapName)
    let paths
    try {
      paths = await robot.waitForReply('path_list')
    } catch (err) {
      uiBridge.broadcast('ERROR', { message: `获取路径列表超时: ${mapName}` })
      console.error('[系统]', err.message)
      return
    }
    lastPaths = { map_name: mapName, paths }
    uiBridge.broadcast('PATH_LIST', { map_name: mapName, paths })
    return
  }
  // ────────────────────────────────────────────────────────────────────────────

  uiBridge.broadcast('MAP_SWITCHING', { map_name: mapName })

  robot.sendSwitchMap(mapName)
  let switchResult
  try {
    switchResult = await robot.waitForReply('switch_map')
  } catch (err) {
    uiBridge.broadcast('ERROR', { message: `地图切换超时: ${mapName}` })
    console.error('[系统]', err.message)
    return
  }
  if (switchResult !== 'true') {
    uiBridge.broadcast('ERROR', { message: `地图切换失败，机器人上不存在该地图: ${mapName}` })
    return
  }

  try {
    await robot.waitForMapReady(mapName)
  } catch (err) {
    uiBridge.broadcast('ERROR', { message: `地图切换超时（map.name/status 未就绪）: ${mapName}` })
    console.error('[系统]', err.message)
    return
  }

  currentMap = mapName
  uiBridge.broadcast('MAP_SWITCHED', { map_name: mapName })
  console.log(`[系统] 地图已切换: ${mapName}`)

  robot.sendGetPathList(mapName)
  let paths
  try {
    paths = await robot.waitForReply('path_list')
  } catch (err) {
    uiBridge.broadcast('ERROR', { message: `获取路径列表超时: ${mapName}` })
    console.error('[系统]', err.message)
    return
  }
  lastPaths = { map_name: mapName, paths }
  uiBridge.broadcast('PATH_LIST', { map_name: mapName, paths })
  console.log(`[系统] 路径列表: ${paths?.join(', ')}`)
})

uiBridge.on('onStartTour', async (payload) => {
  if (!currentMap) {
    uiBridge.broadcast('ERROR', { message: '请先在点位编辑页选择并切换地图' })
    return
  }
  // Payload is either {repeatCount:N} from new UI, or undefined from legacy clients
  const repeatCount = (payload && typeof payload === 'object') ? payload.repeatCount : payload
  if (tour.start(repeatCount)) {
    uiBridge.broadcast('TOUR_STARTED', { repeatCount: tour.repeatCount })
    await sendNextGoal()
  } else {
    uiBridge.broadcast('ERROR', { message: '巡游清单为空，无法开始' })
  }
})

uiBridge.on('onPauseTour', () => {
  tour.pause()
  uiBridge.broadcast('TOUR_PAUSED', {})
})

uiBridge.on('onResumeTour', async () => {
  tour.resume()
  uiBridge.broadcast('TOUR_RESUMED', {})
  transitAudio.start(tts, llm)  // 继续巡游，机器人导航期间播过渡音频
  await sendNextGoal()
})

uiBridge.on('onStopTour', () => {
  _session++  // invalidate any in-flight goal-reached handler
  tour.stop()
  tts.stop()
  transitAudio.stop()
  uiBridge.broadcast('TOUR_STOPPED', {})
})

uiBridge.on('onSetTourList', (items) => {
  tour.setList(items)
})

uiBridge.on('onGetTourList', (reply) => {
  reply('TOUR_LIST', { items: tour.getList() })
})

uiBridge.on('onGetKbMaps', async (reply) => {
  const maps = await kb.listMaps()
  reply('KB_MAPS', { maps })
})

uiBridge.on('onGetKbPaths', async ({ map_name }, reply) => {
  const paths = await kb.listPaths(map_name)
  reply('KB_PATHS', { map_name, paths })
})

uiBridge.on('onGetKbList', async (reply) => {
  const maps = await kb.listMaps()
  const tree = {}
  for (const mapName of maps) {
    tree[mapName] = {}
    const paths = await kb.listPaths(mapName)
    for (const pathName of paths) {
      const keys = await kb.listPoints(mapName, pathName)
      tree[mapName][pathName] = []
      for (const key of keys) {
        // key is composite: "3" (generic) or "3-car" (specific)
        const dashIdx   = key.indexOf('-')
        const numericId = dashIdx === -1 ? Number(key)              : Number(key.slice(0, dashIdx))
        const goalObj   = dashIdx === -1 ? null                     : key.slice(dashIdx + 1)
        const content   = await kb.getContent(mapName, pathName, numericId, goalObj)
        tree[mapName][pathName].push({ goal_id: numericId, goal_object: goalObj, ...(content || {}) })
      }
    }
  }
  reply('KB_LIST', { tree })
})

uiBridge.on('onSaveKbEntry', async ({ map_name, path_name, goal_id, goal_object, body }) => {
  try {
    await kb.saveEntry(map_name, path_name, goal_id, {
      goal_object: goal_object || null,
      body:        body        || null,
    })
    uiBridge.broadcast('KB_ENTRY_SAVED', { map_name, path_name, goal_id, goal_object: goal_object || null })
  } catch (err) {
    console.error('[系统] 知识库保存失败:', err.message)
    uiBridge.broadcast('ERROR', { message: `知识库保存失败: ${err.message}` })
  }
})

uiBridge.on('onDeleteKbEntry', async ({ map_name, path_name, goal_id, goal_object }) => {
  try {
    await kb.deleteEntry(map_name, path_name, goal_id, goal_object || null)
    uiBridge.broadcast('KB_ENTRY_DELETED', { map_name, path_name, goal_id, goal_object: goal_object || null })
  } catch (err) {
    console.error('[系统] 知识库删除失败:', err.message)
    uiBridge.broadcast('ERROR', { message: `知识库删除失败: ${err.message}` })
  }
})

uiBridge.on('onImportKb', async ({ filePath }) => {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    const entries = JSON.parse(raw)
    if (!Array.isArray(entries)) {
      throw new Error('导入文件格式有误：最外层必须为 JSON 数组 [...]')
    }

    let addedCount = 0
    let skippedCount = 0

    for (const entry of entries) {
      if (!entry.map_name || !entry.path_name || !entry.goal_id) {
        throw new Error('点位数据不完整：每个条目必须包含 map_name, path_name 和 goal_id')
      }

      const filename = entry.goal_object ? `${entry.goal_id}-${entry.goal_object}.json` : `${entry.goal_id}.json`
      const dir = safeJoin(DATA_DIR, 'flatfiles', entry.map_name, entry.path_name)
      const targetPath = safeJoin(dir, filename)

      const exists = await fs.access(targetPath).then(() => true).catch(() => false)
      if (!exists) {
        await fs.mkdir(dir, { recursive: true })
        const content = {
          goal_object: entry.goal_object || null,
          body:        entry.body        || null,
        }
        await fs.writeFile(targetPath, JSON.stringify(content, null, 2), 'utf8')
        addedCount++
      } else {
        skippedCount++
      }
    }

    // 重新扫描并构建最新的知识库树
    const maps = await kb.listMaps()
    const tree = {}
    for (const mapName of maps) {
      tree[mapName] = {}
      const paths = await kb.listPaths(mapName)
      for (const pathName of paths) {
        const keys = await kb.listPoints(mapName, pathName)
        tree[mapName][pathName] = []
        for (const key of keys) {
          const dashIdx   = key.indexOf('-')
          const numericId = dashIdx === -1 ? Number(key)              : Number(key.slice(0, dashIdx))
          const goalObj   = dashIdx === -1 ? null                     : key.slice(dashIdx + 1)
          const content   = await kb.getContent(mapName, pathName, numericId, goalObj)
          tree[mapName][pathName].push({ goal_id: numericId, goal_object: goalObj, ...(content || {}) })
        }
      }
    }

    // 广播更新通知前端刷新 UI
    uiBridge.broadcast('KB_LIST', { tree })
    uiBridge.broadcast('KB_IMPORT_RESULT', { ok: true, addedCount, skippedCount })

  } catch (err) {
    console.error('[系统] 知识库批量导入失败:', err.message)
    uiBridge.broadcast('KB_IMPORT_RESULT', { ok: false, error: err.message })
  }
})

// ── Barrage Knowledge (Phase 3) ────────────────────────────────────────────────
uiBridge.on('onGetBarrageConfig', async (reply) => {
  const config = await barrageProvider.getConfig()
  reply('BARRAGE_CONFIG', config)
})

uiBridge.on('onSetBarrageConfig', async (newConfig) => {
  try {
    const currentConfig = await barrageProvider.getConfig()
    const mergedConfig = { ...currentConfig, ...newConfig }
    await barrageProvider.saveConfig(mergedConfig)
    uiBridge.broadcast('BARRAGE_CONFIG_SAVED', mergedConfig)
  } catch (err) {
    uiBridge.broadcast('ERROR', { message: `弹幕设置保存失败: ${err.message}` })
  }
})

uiBridge.on('onGetBarrageConcepts', async (reply) => {
  const names = await barrageProvider.listConcepts()
  const concepts = {}
  for (const name of names) {
    concepts[name] = await barrageProvider.getConcept(name)
  }
  reply('BARRAGE_CONCEPTS', concepts)
})

uiBridge.on('onSaveBarrageConcept', async ({ name, keywords, priority }) => {
  try {
    await barrageProvider.saveConcept(name, { keywords, priority })
    uiBridge.broadcast('BARRAGE_CONCEPT_SAVED', { name, keywords, priority })
  } catch (err) {
    uiBridge.broadcast('ERROR', { message: `弹幕回复保存失败: ${err.message}` })
  }
})

uiBridge.on('onDeleteBarrageConcept', async ({ name }) => {
  try {
    await barrageProvider.deleteConcept(name)
    uiBridge.broadcast('BARRAGE_CONCEPT_DELETED', { name })
    
    // Also clean up its audio folder if it exists
    const dirPath = safeJoin(DATA_DIR, 'barrage-audio', name)
    await fs.rm(dirPath, { recursive: true, force: true }).catch(() => {})
  } catch (err) {
    uiBridge.broadcast('ERROR', { message: `弹幕回复删除失败: ${err.message}` })
  }
})

async function getBarrageAudioFiles(conceptName) {
  try {
    // safeJoin 放在 try 内：名字非法时和读目录失败一样返回空列表，
    // 不让异常冒到没有 try/catch 的 onGetBarrageAudioFiles 里
    const dirPath = safeJoin(DATA_DIR, 'barrage-audio', conceptName)
    await fs.mkdir(dirPath, { recursive: true })
    const files = await fs.readdir(dirPath)
    return files.filter(f => f.toLowerCase().endsWith('.mp3'))
  } catch (err) {
    return []
  }
}

uiBridge.on('onGetBarrageAudioFiles', async ({ conceptName }, reply) => {
  const files = await getBarrageAudioFiles(conceptName)
  reply('BARRAGE_AUDIO_FILES', { conceptName, files })
})

uiBridge.on('onUploadBarrageAudio', async ({ conceptName, filePaths }) => {
  try {
    const dirPath = safeJoin(DATA_DIR, 'barrage-audio', conceptName)
    await fs.mkdir(dirPath, { recursive: true })
    for (const filePath of filePaths) {
      const fileName = filePath.replace(/\\/g, '/').split('/').pop()
      const destPath = safeJoin(dirPath, fileName)
      await fs.copyFile(filePath, destPath)
    }
    const files = await getBarrageAudioFiles(conceptName)
    uiBridge.broadcast('BARRAGE_AUDIO_FILES_UPDATED', { conceptName, files })
  } catch (err) {
    uiBridge.broadcast('ERROR', { message: `音频文件上传失败: ${err.message}` })
  }
})

uiBridge.on('onDeleteBarrageAudio', async ({ conceptName, filename }) => {
  try {
    const filePath = safeJoin(DATA_DIR, 'barrage-audio', conceptName, filename)
    await fs.unlink(filePath).catch(() => {})
    const files = await getBarrageAudioFiles(conceptName)
    uiBridge.broadcast('BARRAGE_AUDIO_FILES_UPDATED', { conceptName, files })
  } catch (err) {
    uiBridge.broadcast('ERROR', { message: `音频文件删除失败: ${err.message}` })
  }
})

// --- Cruising Audio Files (Phase 3 Extension) ---
async function getCruisingAudioFiles(mapName, pathName, goalId) {
  try {
    const dirPath = safeJoin(DATA_DIR, 'cruising-audio', mapName, pathName, String(goalId))
    await fs.mkdir(dirPath, { recursive: true })
    const files = await fs.readdir(dirPath)
    return files.filter(f => f.toLowerCase().endsWith('.mp3'))
  } catch (err) {
    return []
  }
}

uiBridge.on('onGetCruisingAudioFiles', async ({ map_name, path_name, goal_id }, reply) => {
  const files = await getCruisingAudioFiles(map_name, path_name, goal_id)
  reply('CRUISING_AUDIO_FILES', { map_name, path_name, goal_id, files })
})

uiBridge.on('onUploadCruisingAudio', async ({ map_name, path_name, goal_id, filePaths }) => {
  try {
    const dirPath = safeJoin(DATA_DIR, 'cruising-audio', map_name, path_name, String(goal_id))
    await fs.mkdir(dirPath, { recursive: true })
    for (const filePath of filePaths) {
      const fileName = filePath.replace(/\\/g, '/').split('/').pop()
      const destPath = safeJoin(dirPath, fileName)
      await fs.copyFile(filePath, destPath)
    }
    const files = await getCruisingAudioFiles(map_name, path_name, goal_id)
    uiBridge.broadcast('CRUISING_AUDIO_FILES_UPDATED', { map_name, path_name, goal_id, files })
  } catch (err) {
    uiBridge.broadcast('ERROR', { message: `巡游音频文件上传失败: ${err.message}` })
  }
})

uiBridge.on('onDeleteCruisingAudio', async ({ map_name, path_name, goal_id, filename }) => {
  try {
    const filePath = safeJoin(DATA_DIR, 'cruising-audio', map_name, path_name, String(goal_id), filename)
    await fs.unlink(filePath).catch(() => {})
    const files = await getCruisingAudioFiles(map_name, path_name, goal_id)
    uiBridge.broadcast('CRUISING_AUDIO_FILES_UPDATED', { map_name, path_name, goal_id, files })
  } catch (err) {
    uiBridge.broadcast('ERROR', { message: `巡游音频文件删除失败: ${err.message}` })
  }
})

uiBridge.on('onReloadBannedWords', async () => {
  await llm.filter.load()
  uiBridge.broadcast('BANNED_WORDS_RELOADED', {})
})

uiBridge.on('onGetTtsCacheList', async (reply) => {
  try {
    const cacheDir = join(DATA_DIR, 'tts-cache')
    let items = []
    let totalSize = 0
    
    try {
      const files = await fs.readdir(cacheDir)
      
      // Calculate total size of directory
      for (const f of files) {
        const filePath = join(cacheDir, f)
        const stats = await fs.stat(filePath)
        totalSize += stats.size
      }
      
      // Find all txt files and match with mp3s
      const txtFiles = files.filter(f => f.toLowerCase().endsWith('.txt'))
      for (const txtFile of txtFiles) {
        const hash = txtFile.slice(0, -4)
        const txtPath = join(cacheDir, txtFile)
        const mp3Path = join(cacheDir, `${hash}.mp3`)
        
        try {
          const text = await fs.readFile(txtPath, 'utf8')
          const mp3Stats = await fs.stat(mp3Path)
          items.push({
            hash,
            text,
            sizeBytes: mp3Stats.size,
            createdAt: mp3Stats.mtimeMs
          })
        } catch {
          // Ignore missing mp3 or reading errors
        }
      }
    } catch {
      // Directory doesn't exist yet
    }
    
    // Sort by creation time descending (newest first)
    items.sort((a, b) => b.createdAt - a.createdAt)
    
    reply('TTS_CACHE_LIST', { items, totalSize })
  } catch (err) {
    console.error('[index] GET_TTS_CACHE_LIST failed:', err.message)
  }
})

uiBridge.on('onPreviewTtsCache', async ({ hash }, reply) => {
  try {
    const cacheDir = join(DATA_DIR, 'tts-cache')
    const mp3Path = safeJoin(cacheDir, `${hash}.mp3`)
    const buffer = await fs.readFile(mp3Path)
    reply('TTS_CACHE_PREVIEW', { hash, base64: buffer.toString('base64') })
  } catch (err) {
    console.error('[index] PREVIEW_TTS_CACHE failed:', err.message)
  }
})

uiBridge.on('onDeleteTtsCacheEntry', async ({ hash }) => {
  try {
    const cacheDir = join(DATA_DIR, 'tts-cache')
    const mp3Path = safeJoin(cacheDir, `${hash}.mp3`)
    const txtPath = safeJoin(cacheDir, `${hash}.txt`)
    await fs.unlink(mp3Path).catch(() => {})
    await fs.unlink(txtPath).catch(() => {})
    uiBridge.broadcast('TTS_CACHE_DELETED', { ok: true, hash })
  } catch (err) {
    console.error('[index] DELETE_TTS_CACHE_ENTRY failed:', err.message)
  }
})


uiBridge.on('onGetTransitConfig', (reply) => {
  reply('TRANSIT_CONFIG', transitAudio.getConfig())
})

uiBridge.on('onSetTransitConfig', (config) => {
  transitAudio.saveConfig(config)
  uiBridge.broadcast('TRANSIT_CONFIG', transitAudio.getConfig())
})

uiBridge.on('onGetAudioOutputConfig', (reply) => {
  reply('AUDIO_OUTPUT_CONFIG', {
    ...audioOutput.getConfig(),
    robotConnected,
  })
})

uiBridge.on('onSetAudioOutputConfig', (config) => {
  try {
    // Never leave a previous destination playing after the user switches.
    tts.stop()
    barrageTts.stop()
    transitAudio.stop()
    const saved = audioOutput.setConfig(config)
    uiBridge.broadcast('AUDIO_OUTPUT_CONFIG', {
      ...saved,
      robotConnected,
    })
  } catch (err) {
    console.error('[音频输出] 保存设置失败:', err.message)
    uiBridge.broadcast('ERROR', { message: `音频输出设置保存失败: ${err.message}` })
  }
})

uiBridge.on('onReloadPrompt', () => {
  reloadPrompt()
  uiBridge.broadcast('PROMPT_RELOADED', {})
})

uiBridge.on('onSkipPoint', async () => {
  if (!tour.isRunning) return
  _session++      // invalidate any in-flight goal-reached handler
  tts.stop()
  transitAudio.stop()
  tour.resume()   // clear paused state so goal-reached won't be filtered
  const iterationBefore = tour.currentIteration
  const next = tour.advance()
  if (next) {
    if (tour.currentIteration !== iterationBefore) {
      uiBridge.broadcast('TOUR_ITERATION', {
        currentIteration: tour.currentIteration,
        repeatCount:      tour.repeatCount
      })
    }
    transitAudio.start(tts, llm)  // 跳过后机器人导航期间播过渡音频
    await sendNextGoal()
  } else {
    transitAudio.stop()
    uiBridge.broadcast('TOUR_FINISHED', {})
  }
})

// ── TaskManager events ────────────────────────────────────────────────────────

tour.on('list-changed', (items) => {
  uiBridge.broadcast('TOUR_LIST_CHANGED', { items })
})

tour.on('current-removed', async ({ nextIndex }) => {
  _session++      // invalidate any in-flight goal-reached handler
  tts.stop()
  transitAudio.stop()
  if (nextIndex < 0) {
    tour.stop()
    uiBridge.broadcast('TOUR_STOPPED', {})
    return
  }
  tour.setCurrentIndex(nextIndex)
  transitAudio.start(tts, llm)  // 重定向后机器人导航期间播过渡音频
  await sendNextGoal()
})

// ── Robot events ──────────────────────────────────────────────────────────────

robot.on('connected', () => {
  robotConnected = true
  currentMap     = null
  lastMapList    = null
  lastPaths      = null
  uiBridge.broadcast('ROBOT_CONNECTED', {})
  uiBridge.broadcast('AUDIO_OUTPUT_STATUS', { robotConnected: true })
  robot.sendGetMapList()
})

robot.on('disconnected', () => {
  robotConnected = false
  currentMap     = null
  lastMapList    = null
  lastPaths      = null
  uiBridge.broadcast('ROBOT_DISCONNECTED', {})
  uiBridge.broadcast('AUDIO_OUTPUT_STATUS', { robotConnected: false })
  if (tour.isRunning) {
    _session++    // invalidate any in-flight goal-reached handler
    tour.stop()
    tts.stop()
    transitAudio.stop()
    uiBridge.broadcast('ERROR', { message: '机器人断线，巡游已停止' })
  }
})

let _lastHeartbeatBroadcast = 0
robot.on('heartbeat', (msg) => {
  lastHeartbeat = msg
  
  // Throttle UI broadcast to 1Hz to prevent frontend CPU overload
  const now = Date.now()
  if (now - _lastHeartbeatBroadcast >= 1000) {
    _lastHeartbeatBroadcast = now
    uiBridge.broadcast('HEARTBEAT', msg)
  }
})

robot.on('reply', ({ type, data }) => {
  if (type === 'map_list') {
    lastMapList = data
    console.log('[系统] 机器人地图列表:', data)
    uiBridge.broadcast('MAP_LIST', { maps: data })
  }
})

robot.on('goal-reached', async ({ map_name, path_file, goal_id }) => {
  // Only handle if tour is running and not paused
  if (!tour.isRunning || tour.isPaused) return

  // Prevent concurrent handling: robot heartbeats arrive at 1 Hz, and sendSetGoal()
  // resets _lastTriggered which can let a stale heartbeat fire a second event
  if (_goalHandling) {
    console.warn(`[系统] goal-reached 重入，忽略 (${map_name}/${path_file}/${goal_id})`)
    return
  }

  // Verify this matches the current tour item
  const item = tour.currentItem
  if (!item) return
  if (map_name !== item.map_name || path_file !== item.path_name || goal_id !== item.goal_id) {
    console.warn(`[系统] goal-reached 不匹配当前任务，忽略 (${map_name}/${path_file}/${goal_id})`)
    return
  }

  _goalHandling = true
  const mySession = ++_session
  try {
    transitAudio.stop()
    uiBridge.broadcast('POINT_ARRIVED', { map_name, path_file, goal_id })

    // playPoint runs LLM + waits for duck end (if needed) + plays TTS
    // No pre-wait here: LLM can run concurrently while co-host is speaking;
    // the duck wait inside playPoint fires only right before TTS output.
    await playPoint(item, { map_name, path_file, goal_id })

    // Tour may have been stopped/skipped externally while TTS was playing
    if (!tour.isRunning || _session !== mySession) return

    // Advance to next point
    const iterationBefore = tour.currentIteration
    const next = tour.advance()
    if (next) {
      // Rolled over into a new repeat iteration
      if (tour.currentIteration !== iterationBefore) {
        uiBridge.broadcast('TOUR_ITERATION', {
          currentIteration: tour.currentIteration,
          repeatCount:      tour.repeatCount
        })
      }
      // 正确时序：TTS 结束 → 过渡音频开始 → 机器人出发
      transitAudio.start(tts, llm)
      await sendNextGoal()
    } else {
      transitAudio.stop()
      uiBridge.broadcast('TOUR_FINISHED', {})
    }
  } finally {
    _goalHandling = false
  }
})

robot.start()

// ── ngrok tunnel (optional) ───────────────────────────────────────────────
// if (process.env.NGROK_AUTHTOKEN) {
//   console.log('[tunnel] 检测到 NGROK_AUTHTOKEN（前4位）:', process.env.NGROK_AUTHTOKEN.slice(0, 4) + '...')
//   startTunnel(parseInt(process.env.ROBOT_PORT || '8765'), process.env.NGROK_AUTHTOKEN)
//     .then(url => { if (url) uiBridge.setTunnelUrl(url) })
// } else {
//   console.log('[tunnel] 未检测到 NGROK_AUTHTOKEN，跳过')
// }

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Switch map if needed, then send set_goal for the current tour item.
 */
async function sendNextGoal() {
  const item = tour.currentItem
  if (!item) return

  console.log(`[系统] 发布目标点: ${item.path_name}/${item.goal_id} → ${item.goal_object}`)
  robot.sendSetGoal({
    path_name:   item.path_name,
    goal_id:     item.goal_id,
    goal_object: item.goal_object
  })

  uiBridge.broadcast('GOAL_SENT', {
    map_name:  item.map_name,
    path_name: item.path_name,
    goal_id:   item.goal_id
  })

  // Wait for robot to confirm the goal exists
  let goalReply
  try {
    goalReply = await robot.waitForReply('goal')
  } catch (err) {
    uiBridge.broadcast('ERROR', { message: `等待机器人确认目标点超时: ${item.path_name}/${item.goal_id}` })
    console.error('[系统]', err.message)
    tour.pause()
    return
  }

  if (goalReply.goal_check === 'false') {
    const msg = `目标点不存在: ${item.path_name}/${item.goal_id}，巡游已暂停，请跳过或重试`
    console.error('[系统]', msg)
    uiBridge.broadcast('GOAL_CHECK_FAILED', {
      map_name:  item.map_name,
      path_name: item.path_name,
      goal_id:   item.goal_id,
      message:   msg
    })
    tour.pause()
    return
  }
  // 过渡音频由调用方在 TTS 播完后启动（见 goal-reached / onSkipPoint）
}

/**
 * Look up KB content and play the point using the item's play_mode.
 */
async function playPoint(item, { map_name, path_file, goal_id }) {
  const goalObj = item.goal_object || null
  const content = await kb.getContent(map_name, path_file, goal_id, goalObj)
  if (!content) {
    const tried = [
      goalObj ? `${goal_id}-${goalObj}.json` : null,
      `${goal_id}.json`,
    ].filter(Boolean).join(' → ')
    const msg = `没有找到点位内容: ${map_name}/${path_file}/ (尝试了 ${tried})，请检查知识库路径是否与巡游清单一致`
    console.error('[系统]', msg)
    uiBridge.broadcast('ERROR', { message: msg })
    return
  }

  const play_mode = item.play_mode || (content.body ? 'tts' : 'mp3')

  // 如果 LLM 生成期间助播或弹幕开始说话，等说完再开始播
  if (isSpeaking || isBarrageSpeaking) {
    await waitUntil(() => !isSpeaking && !isBarrageSpeaking, 30000)
  }

  if (play_mode === 'mp3') {
    let mp3FileToPlay = null
    try {
      const cruisingAudioDir = join(DATA_DIR, 'cruising-audio', map_name, path_file, String(goal_id))
      const files = await fs.readdir(cruisingAudioDir)
      const mp3Files = files.filter(f => f.toLowerCase().endsWith('.mp3'))
      if (mp3Files.length > 0) {
        const randomFile = mp3Files[Math.floor(Math.random() * mp3Files.length)]
        mp3FileToPlay = join(cruisingAudioDir, randomFile)
      }
    } catch {
      // Ignore reading directory errors
    }

    if (mp3FileToPlay) {
      uiBridge.broadcast('SPEECH_START', { mp3_file: mp3FileToPlay })
      await tts.speakFile(mp3FileToPlay)
    } else {
      // No MP3 files in folder: perform silent arrival (non-blocking)
      console.log(`[系统] 点位 ${map_name}/${path_file}/${goal_id} 没有可播放的音频，执行静音抵达。`)
      uiBridge.broadcast('SPEECH_START', { text: '[静音点位]' })
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
  } else {
    if (content.body) {
      try {
        const result = await llm.rewrite({ ...content, goal_object: item.goal_object ?? null })
        uiBridge.broadcast('SPEECH_START', { text: result.text })
        const res = await tts.speak(result.text)
        if (res && res.ok === false) {
          console.error('[系统] 巡游合成播放失败:', res.error.message)
        }
      } catch (err) {
        console.error('[系统] 巡游合成播放出错:', err.message)
      }
    } else {
      // No body text: perform silent arrival (non-blocking)
      console.log(`[系统] 点位 ${map_name}/${path_file}/${goal_id} 没有配置讲解文本，执行静音抵达。`)
      uiBridge.broadcast('SPEECH_START', { text: '[静音点位]' })
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
  }

  uiBridge.broadcast('SPEECH_END', {})
}

// ── Shutdown ──────────────────────────────────────────────────────────────────

function shutdown() {
  transitAudio.stop()
  tts.destroy()
  barrageTts.destroy()
  audioOutput.destroy()
  robot.stop()
  // stopTunnel().finally(() => process.exit(0))
  process.exit(0)
}
process.on('SIGINT',  shutdown)
process.on('SIGTERM', shutdown)

// ── Helpers ───────────────────────────────────────────────────────────────────

function waitUntil(condition, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const start = Date.now()
    const interval = setInterval(() => {
      if (condition() || Date.now() - start > timeoutMs) {
        clearInterval(interval)
        resolve()
      }
    }, 200)
  })
}
