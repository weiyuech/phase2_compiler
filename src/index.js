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
import { applyAudioOutputConfig }      from './tts/audio-output-config.js'
import { SpeechCoordinator }           from './tts/speech-coordinator.js'
import { AudioDiagnostics }            from './diagnostics/audio-diagnostics.js'
import { startBackendLogCapture }      from './diagnostics/backend-log.js'
import { TransitAudioManager }         from './transit/manager.js'
import { RobotListener }               from './robot/listener.js'
import { TaskManager }                 from './task/manager.js'
import { CruiseController }            from './task/cruise-controller.js'
import { createPointNarrator }          from './task/point-narrator.js'
import { getTourState, registerTourControls } from './task/ui-controls.js'
import * as uiBridge                   from './ui-bridge.js'
import { startTunnel, stopTunnel }     from './tunnel.js'
import { initPhase2 }                  from './phase2/index.js'
import { barrageProvider }             from './knowledge/barrage-provider.js'
import { safeJoin }                    from './safe-path.js'

// ── Initialise modules ────────────────────────────────────────────────────────

const diagnosticsDirectory = process.env.USER_DATA_DIR || join(process.cwd(), 'data')
const backendLogCapture = startBackendLogCapture({ directory: diagnosticsDirectory })
const audioDiagnostics = new AudioDiagnostics({ directory: diagnosticsDirectory })
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
  diagnostics: audioDiagnostics,
})
audioDiagnostics.event('runtime', { ...audioOutput.getConfig(), connected: robot.isConnected() })

const speechCoordinator = new SpeechCoordinator({ diagnostics: audioDiagnostics })
const tts = new TTSEngine({ audioOutput, coordinator: speechCoordinator, role: 'cruise', diagnostics: audioDiagnostics })

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
  coordinator: speechCoordinator,
  role: 'barrage',
  diagnostics: audioDiagnostics,
  TTS_APP_ID: process.env.BARRAGE_TTS_APP_ID,
  TTS_ACCESS_TOKEN: process.env.BARRAGE_TTS_ACCESS_TOKEN,
  TTS_API_KEY: process.env.BARRAGE_TTS_API_KEY,
  TTS_AUTH_MODE: process.env.BARRAGE_TTS_AUTH_MODE,
  TTS_VOICE_TYPE: process.env.BARRAGE_TTS_VOICE_TYPE,
  TTS_CLUSTER: process.env.BARRAGE_TTS_CLUSTER,
  TTS_RESOURCE_ID: process.env.BARRAGE_TTS_RESOURCE_ID,
  TTS_TIMEOUT_MS: process.env.BARRAGE_TTS_TIMEOUT_MS
})

const transitTts = new TTSEngine({ audioOutput, coordinator: speechCoordinator, role: 'transit', diagnostics: audioDiagnostics })
const transitAudio = new TransitAudioManager({
  filePath: join(DATA_DIR, 'transit-audio.json'),
  audioOutput,
  tts: transitTts,
})

// Speaking state driven by renderer mic detection (via DUCK_START / DUCK_END commands on ws:3001)
let isSpeaking = false
let isHostSpeaking = false
let audioOutputGeneration = 0

function updateCruisingDucking() {
  // Automatic source priority is owned by the coordinator. Only immediate
  // host/operator reasons pause an unfinished TTS sentence.
  speechCoordinator.setPauseReason('host', ['cruise', 'transit', 'barrage'], isHostSpeaking)
  speechCoordinator.setPauseReason('tour', ['cruise', 'transit'], tour.isPaused)
}

const tour  = new TaskManager({ filePath: join(DATA_DIR, 'tour-list.json') })
const pointNarrator = createPointNarrator({
  kb, llm, tts, dataDir: DATA_DIR, broadcast: uiBridge.broadcast,
  // Barrage arbitration belongs exclusively to the coordinator. A barrage
  // sequence can be preparing its next action while point speech continues.
  isSpeechBlocked: () => isHostSpeaking || tour.isPaused,
  getOutputGeneration: () => audioOutputGeneration,
})

// Selection is explicit: a tour may not silently switch the robot's map.
let currentMap     = null
let robotConnected = false
let lastMapList    = null   // cached so new UI clients get the list immediately
let lastPaths      = null   // { map_name, paths } — cached path list for current map
let lastHeartbeat  = null   // most recent heartbeat, used for same-map short-circuit
const cruise = new CruiseController({
  robot, tour, getSelectedMap: () => currentMap, playPoint,
  stopSpeech: () => tts.stop(),
  startTransit: () => transitAudio.start(transitTts, llm),
  stopTransit: () => { transitAudio.stop(); transitTts.stop() },
  isTransitRunning: () => transitAudio.isRunning(),
  syncAudioPause: updateCruisingDucking,
  deferTransitUntilSpeech: () => true,
  finishTransitSentence: () => transitAudio.finishCurrentSentence(),
  broadcast: (type, data) => uiBridge.broadcast(type, data),
})

// -- Phase 2 Sandbox Initialization --
const phase2 = initPhase2({
  robot,
  tour,
  llm: barrageLlm,
  tts: barrageTts,
  uiBridge,
  transitAudio,
  checkGoalHandling: () => cruise.isHandlingGoal,
  checkIsSpeaking: () => isSpeaking,
  onBarrageSpeechStart: updateCruisingDucking,
  onBarrageSpeechEnd: updateCruisingDucking,
})

// ── State snapshot for late-joining UI clients ────────────────────────────────

uiBridge.on('onNewClient', (sendTo) => {
  sendTo('TOUR_STATE', getTourState(tour))
  sendTo('AUDIO_DIAGNOSTICS', { snapshot: audioDiagnostics.snapshot() })
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

registerTourControls({ uiBridge, tour, tts })
uiBridge.on('onPause', () => speechCoordinator.setPauseReason('operator', ['cruise', 'transit', 'barrage'], true))
uiBridge.on('onResume', () => speechCoordinator.setPauseReason('operator', [], false))
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
  if (tour.isRunning) {
    uiBridge.broadcast('ERROR', { message: '请先停止巡游，再切换地图；暂停巡游不会停止机器人底盘' })
    return
  }

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
  currentMap = null
  lastPaths = null

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

uiBridge.on('onStartTour', (payload) => {
  // Payload is either {repeatCount:N} from new UI, or undefined from legacy clients
  const repeatCount = (payload && typeof payload === 'object') ? payload.repeatCount : payload
  cruise.start(repeatCount)
})

uiBridge.on('onPauseTour', () => {
  cruise.pause()
})

uiBridge.on('onResumeTour', () => {
  cruise.resume()
})

uiBridge.on('onStopTour', () => {
  audioDiagnostics.event('stop', { source: 'point', reason: 'stop' })
  cruise.stop()
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
    uiBridge.broadcast('BARRAGE_CONFIG_SAVED', await barrageProvider.getConfig())
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
uiBridge.on('onGetAudioDiagnostics', reply => reply('AUDIO_DIAGNOSTICS', { snapshot: audioDiagnostics.snapshot() }))
uiBridge.on('onMarkAudioGlitch', reply => {
  audioDiagnostics.event('user-marker', {})
  reply('AUDIO_DIAGNOSTICS', { snapshot: audioDiagnostics.snapshot() })
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
    let destinationChanged = false
    const saved = applyAudioOutputConfig({ audioOutput, config, onDestinationChange: () => {
      // Never leave a previous destination playing after the user switches.
      // Volume-only changes are applied by the router without cancelling speech.
      destinationChanged = true
      audioOutputGeneration++
      speechCoordinator.cancelAll()
      tts.stop()
      barrageTts.stop()
      transitAudio.stop()
      transitTts.stop()
      phase2.barrageManager?.cancelPendingSpeech?.()
    } })
    if (destinationChanged) {
      audioDiagnostics.event('destination-change', { destination: saved.destination, generation: audioOutputGeneration })
    }
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

uiBridge.on('onSkipPoint', () => {
  audioDiagnostics.event('stop', { source: 'point', reason: 'skip' })
  cruise.skip()
})

// ── TaskManager events ────────────────────────────────────────────────────────

tour.on('list-changed', (items) => {
  uiBridge.broadcast('TOUR_LIST_CHANGED', { items })
})

tour.on('current-removed', ({ nextIndex }) => {
  cruise.currentRemoved(nextIndex)
})

// ── Robot events ──────────────────────────────────────────────────────────────

robot.on('connected', () => {
  audioDiagnostics.event('connected', { destination: audioOutput.getConfig().destination, connected: true, connectionGeneration: robot.connectionGeneration })
  if (audioOutput.isRobotDestination()) invalidateRobotSpeech()
  // Server mode can replace a connection without a disconnected event from
  // the old socket. Invalidate any narration belonging to that old session.
  if (tour.isRunning) {
    cruise.stop()
    uiBridge.broadcast('ERROR', { message: '机器人连接已更换，巡游已停止，请重新选择地图' })
  }
  robotConnected = true
  currentMap     = null
  lastMapList    = null
  lastPaths      = null
  lastHeartbeat  = null
  uiBridge.broadcast('ROBOT_CONNECTED', {})
  uiBridge.broadcast('AUDIO_OUTPUT_STATUS', { robotConnected: true })
  robot.sendGetMapList()
})

robot.on('disconnected', () => {
  audioDiagnostics.event('disconnected', { destination: audioOutput.getConfig().destination, connected: false, connectionGeneration: robot.connectionGeneration })
  if (audioOutput.isRobotDestination()) invalidateRobotSpeech()
  robotConnected = false
  currentMap     = null
  lastMapList    = null
  lastPaths      = null
  lastHeartbeat  = null
  uiBridge.broadcast('ROBOT_DISCONNECTED', {})
  uiBridge.broadcast('AUDIO_OUTPUT_STATUS', { robotConnected: false })
  if (tour.isRunning) {
    cruise.stop()
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
 * Look up KB content and play the point using the item's play_mode.
 */
async function playPoint(item, point, context = {}) {
  return pointNarrator(item, point, context)
}

function invalidateRobotSpeech() {
  audioOutputGeneration++
  speechCoordinator.cancelAll()
  tts.stop()
  barrageTts.stop()
  transitAudio.stop()
  transitTts.stop()
  phase2.barrageManager?.cancelPendingSpeech?.()
}

// ── Shutdown ──────────────────────────────────────────────────────────────────

let shuttingDown = false
async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  phase2.barrageManager?.stop?.()
  speechCoordinator.cancelAll()
  cruise.stop()
  transitAudio.stop()
  transitTts.destroy()
  tts.destroy()
  barrageTts.destroy()
  const audioCleanup = audioOutput.destroy()
  robot.stop()
  await Promise.race([
    Promise.allSettled([audioCleanup, audioDiagnostics.destroy(), backendLogCapture?.destroy?.(), phase2.destroy?.()]),
    new Promise(resolve => setTimeout(resolve, 1000)),
  ])
  // stopTunnel().finally(() => process.exit(0))
  process.exit(0)
}
process.on('SIGINT',  shutdown)
process.on('SIGTERM', shutdown)
