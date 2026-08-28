import { WebSocketServer } from 'ws'
import { writeSync }       from 'node:fs'

// 弹幕识别开着时，每秒都会收到一帧截图和若干条消息。
// 把这些逐帧日志一直写进 backend.log，一天就是几 MB，排障时还得从里面翻。
// 默认关掉，需要现场调试时设 DEBUG_WS=1 打开。
const DEBUG_WS = process.env.DEBUG_WS === '1'

let wss        = null
let paused     = false
let duckVolume = 0.3
let fadeMs     = 800
let tunnelUrl  = null

const handlers = {
  // Audio
  onPause:         null,
  onResume:        null,
  onTestSpeech:    null,
  onSetDuckVolume: null,
  onSetFadeMs:     null,
  // Tour
  onStartTour:     null,
  onPauseTour:     null,
  onResumeTour:    null,
  onStopTour:      null,
  onSetTourList:   null,
  onSkipPoint:     null,
  // Queries (reply to specific client)
  onGetTourList:   null,
  onGetKbMaps:     null,
  onGetKbList:     null,
  onGetKbPaths:    null,
  // KB mutations
  onSaveKbEntry:   null,
  onDeleteKbEntry: null,
  onImportKb:      null,
  // Phase 1 — map selection
  onSelectMap:          null,
  // Ducking (from renderer mic detection)
  onDuckStart:          null,
  onDuckEnd:            null,
  // Barrage OCR (Phase 2)
  onBarrageStart:       null,
  onBarrageStop:        null,
  onBarrageTextRead:    null,
  onBarrageImage:       null,
  // Barrage Reply (Phase 3)
  onGetBarrageConfig:   null,
  onSetBarrageConfig:   null,
  onGetBarrageConcepts: null,
  onSaveBarrageConcept: null,
  onDeleteBarrageConcept: null,
  // Settings — hot-reload
  onReloadBannedWords:  null,
  onReloadPrompt:       null,
  // Transit audio config
  onGetTransitConfig:   null,
  onSetTransitConfig:   null,
  // Playback destination (local computer / robot speaker)
  onGetAudioOutputConfig: null,
  onSetAudioOutputConfig: null,
  // Cruising point audio files
  onGetCruisingAudioFiles: null,
  onUploadCruisingAudio:   null,
  onDeleteCruisingAudio:   null,
  onGetTtsCacheList:       null,
  onPreviewTtsCache:      null,
  onDeleteTtsCacheEntry:   null,
  // Called when a new UI client connects — used to push current state snapshot
  onNewClient:          null,
}

// 实际监听到的端口。首选 3001；被占用时由系统另分配一个空闲端口，
// 再把真实端口告诉主进程 → 界面据此连接，所以端口冲突不再是致命问题。
let actualPort = null

export function start(preferredPort = 3001) {
  listen(preferredPort, /* isFallback */ false)
}

function listen(port, isFallback) {
  // 只监听回环地址：这个通道服务的是同一台机器上的 Electron 界面。
  // 机器人不走这个端口（ROBOT_URL 是往外拨号的），不受影响。
  // 之前监听全部网卡且没有任何鉴权，同一个 Wi-Fi 下的任何设备都能发指令。
  wss = new WebSocketServer({ port, host: '127.0.0.1' })

  let listening = false
  wss.on('listening', () => {
    listening = true
    actualPort = wss.address().port          // port 为 0 时这里才是系统分配的真实端口
    console.log(`[UI] 控制台通道已就绪，端口 ${actualPort}`)
    // 告诉主进程真实端口，由它转给渲染进程。
    // 开发模式下没有 parentPort（后端是手动 npm start 起的），界面回退到 3001。
    try { process.parentPort?.postMessage({ type: 'UI_PORT', port: actualPort }) } catch {}
  })

  // 没有这个监听器时，listen 失败会以未捕获异常直接杀掉整个后端进程，
  // 界面上只剩一个"未连接"，日志里也只有一段看不懂的堆栈。
  wss.on('error', (err) => {
    if (!listening) {
      // 首选端口被占用 → 换一个系统分配的空闲端口重来，而不是让用户
      // 自己去找并关掉占用端口的程序（对方可能根本关不掉）。
      if (err.code === 'EADDRINUSE' && !isFallback) {
        // 用 console.log（stdout）而不是 warn（stderr）：这是已经处理掉的正常情况。
        // 界面在后端退出时展示的是 stderr 末尾几行，把这条写进 stderr 的话，
        // 以后真的因为别的原因崩溃时，用户会看到"端口被占用"这条陈旧信息。
        console.log(`[UI] 端口 ${port} 已被占用，改用系统自动分配的空闲端口`)
        try { wss.close() } catch {}
        listen(0, true)
        return
      }
      // writeSync 而不是 console.error：管道 stderr 在 macOS 上是异步写，
      // 紧跟 process.exit() 会把这条唯一的线索截掉
      try {
        writeSync(2, `[UI] 控制台通道启动失败: ${err.message}\n`)
      } catch {}
      process.exit(3)
    }
    // 已经在监听之后出现的错误不致命，记录即可
    console.error('[UI] 控制台通道错误:', err.message)
  })

  wss.on('connection', (ws) => {
    // 每次连接记一行（不是每条消息）。排障时这一行能直接回答
    // "界面到底连上后端没有"，CI 的冒烟测试也用它判断窗口是否真的起来了。
    console.log('[UI] 界面已连接')
    ws.on('close', () => console.log('[UI] 界面已断开'))

    const sendTo = (type, data) => ws.send(JSON.stringify({ type, data, ts: Date.now() }))
    sendTo('STATUS', { paused, duckVolume, fadeMs })
    if (tunnelUrl) sendTo('TUNNEL_URL', { url: tunnelUrl })
    handlers.onNewClient?.(sendTo)

    // 单个连接上的协议错误如果没人监听，EventEmitter 会把它抛成未捕获异常，
    // 整个后端就没了。一个客户端出问题不应该影响其它客户端。
    ws.on('error', (err) => {
      console.error('[UI] 客户端连接错误:', err.message)
    })

    ws.on('message', (data, isBinary) => {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      
      // Strict PNG Signature Check: 89 50 4E 47
      const isPng = buffer.length > 8 && 
                    buffer[0] === 0x89 && buffer[1] === 0x50 && 
                    buffer[2] === 0x4E && buffer[3] === 0x47;

      if (isPng) {
        if (DEBUG_WS) console.log(`[DEBUG] [WS] Received valid PNG image packet (${buffer.length} bytes)`);
        handlers.onBarrageImage?.(buffer)
        return
      }

      // If it's binary but not PNG, it might be a malformed frame or raw Buffer
      if (isBinary) {
        // Only log if it's clearly not a short JSON message
        if (buffer.length > 100) {
          console.warn(`[DEBUG] [WS] Binary frame received (${buffer.length} bytes), but not a valid PNG.`);
        }
      }

      // Handle JSON messages
      handleJson(buffer.toString())

      function handleJson(str) {
        let msg
        try {
          msg = JSON.parse(str)
        } catch (err) {
          return
        }

        // 解析成功之后仍然可能炸：msg 可能是 null，msgData 可能缺字段
        // （{"type":"SELECT_MAP"} 就够了），handler 自己也可能抛。
        // 这里不兜住的话，一条畸形消息就能让整个后端退出。
        try {
          dispatch(msg)
        } catch (err) {
          console.error('[UI] 处理消息失败:', err?.stack || err)
        }
      }

      function dispatch(msg) {
        const { type, data: msgData } = msg ?? {}

        if (DEBUG_WS && type !== 'BARRAGE_IMAGE') {
          console.log('[DEBUG] [WS Incoming]:', type, JSON.stringify(msgData))
        }

        switch (type) {
          // ── Audio controls ──────────────────────────────────────────────────
          case 'PAUSE':
            paused = true
            broadcast('PAUSED', {})
            handlers.onPause?.()
            break
          case 'RESUME':
            paused = false
            broadcast('RESUMED', {})
            handlers.onResume?.()
            break
          case 'SET_DUCK_VOLUME':
            duckVolume = msgData.volume
            handlers.onSetDuckVolume?.(duckVolume)
            break
          case 'SET_FADE_MS':
            fadeMs = msgData.fadeMs
            handlers.onSetFadeMs?.(fadeMs)
            break
          case 'TEST_SPEECH':
            handlers.onTestSpeech?.(msgData.text)
            break

          // ── Tour controls ───────────────────────────────────────────────────
          case 'START_TOUR':
            handlers.onStartTour?.({ repeatCount: msgData.repeatCount })
            break
          case 'PAUSE_TOUR':
            handlers.onPauseTour?.()
            break
          case 'RESUME_TOUR':
            handlers.onResumeTour?.()
            break
          case 'STOP_TOUR':
            handlers.onStopTour?.()
            break
          case 'SET_TOUR_LIST':
            handlers.onSetTourList?.(msgData.items)
            break
          case 'SKIP_POINT':
            handlers.onSkipPoint?.()
            break

          // ── Queries (reply to this client only) ─────────────────────────────
          case 'GET_TOUR_LIST':
          case 'GET_KB_MAPS':
          case 'GET_KB_LIST':
          case 'GET_KB_PATHS': {
            const reply = (type, data) => ws.send(JSON.stringify({ type, data, ts: Date.now() }))
            if (type === 'GET_TOUR_LIST') handlers.onGetTourList?.(reply)
            if (type === 'GET_KB_MAPS')   handlers.onGetKbMaps?.(reply)
            if (type === 'GET_KB_LIST')   handlers.onGetKbList?.(reply)
            if (type === 'GET_KB_PATHS')  handlers.onGetKbPaths?.(msgData, reply)
            break
          }
          case 'GET_BARRAGE_CONFIG':
          case 'GET_BARRAGE_CONCEPTS': {
            const reply = (type, data) => ws.send(JSON.stringify({ type, data, ts: Date.now() }))
            if (type === 'GET_BARRAGE_CONFIG')   handlers.onGetBarrageConfig?.(reply)
            if (type === 'GET_BARRAGE_CONCEPTS') handlers.onGetBarrageConcepts?.(reply)
            break
          }
          case 'GET_BARRAGE_AUDIO_FILES': {
            const reply = (type, data) => ws.send(JSON.stringify({ type, data, ts: Date.now() }))
            handlers.onGetBarrageAudioFiles?.(msgData, reply)
            break
          }
          case 'UPLOAD_BARRAGE_AUDIO':
            handlers.onUploadBarrageAudio?.(msgData)
            break
          case 'DELETE_BARRAGE_AUDIO':
            handlers.onDeleteBarrageAudio?.(msgData)
            break
          case 'GET_CRUISING_AUDIO_FILES': {
            const reply = (type, data) => ws.send(JSON.stringify({ type, data, ts: Date.now() }))
            handlers.onGetCruisingAudioFiles?.(msgData, reply)
            break
          }
          case 'UPLOAD_CRUISING_AUDIO':
            handlers.onUploadCruisingAudio?.(msgData)
            break
          case 'DELETE_CRUISING_AUDIO':
            handlers.onDeleteCruisingAudio?.(msgData)
            break
          case 'SET_BARRAGE_CONFIG':
            handlers.onSetBarrageConfig?.(msgData)
            break
          case 'SAVE_BARRAGE_CONCEPT':
            handlers.onSaveBarrageConcept?.(msgData)
            break
          case 'DELETE_BARRAGE_CONCEPT':
            handlers.onDeleteBarrageConcept?.(msgData)
            break
          case 'SAVE_KB_ENTRY':
            handlers.onSaveKbEntry?.(msgData)
            break
          case 'IMPORT_KB':
            handlers.onImportKb?.(msgData)
            break
          case 'DELETE_KB_ENTRY':
            handlers.onDeleteKbEntry?.(msgData)
            break
          case 'SELECT_MAP':
            handlers.onSelectMap?.(msgData.map_name)
            break
          case 'RELOAD_BANNED_WORDS':
            handlers.onReloadBannedWords?.()
            break
          case 'RELOAD_PROMPT':
            handlers.onReloadPrompt?.()
            break
          case 'GET_TRANSIT_CONFIG': {
            const reply = (type, data) => ws.send(JSON.stringify({ type, data, ts: Date.now() }))
            handlers.onGetTransitConfig?.(reply)
            break
          }
          case 'SET_TRANSIT_CONFIG':
            handlers.onSetTransitConfig?.(msgData)
            break
          case 'GET_AUDIO_OUTPUT_CONFIG': {
            const reply = (type, data) => ws.send(JSON.stringify({ type, data, ts: Date.now() }))
            handlers.onGetAudioOutputConfig?.(reply)
            break
          }
          case 'SET_AUDIO_OUTPUT_CONFIG':
            handlers.onSetAudioOutputConfig?.(msgData)
            break
          case 'GET_TTS_CACHE_LIST': {
            const reply = (type, data) => ws.send(JSON.stringify({ type, data, ts: Date.now() }))
            handlers.onGetTtsCacheList?.(reply)
            break
          }
          case 'PREVIEW_TTS_CACHE': {
            const reply = (type, data) => ws.send(JSON.stringify({ type, data, ts: Date.now() }))
            handlers.onPreviewTtsCache?.(msgData, reply)
            break
          }
          case 'DELETE_TTS_CACHE_ENTRY':
            handlers.onDeleteTtsCacheEntry?.(msgData)
            break
          case 'DUCK_START':
            handlers.onDuckStart?.()
            broadcast('DUCK_START', {})
            break
          case 'DUCK_END':
            handlers.onDuckEnd?.()
            broadcast('DUCK_END', {})
            break
          case 'BARRAGE_START':
            handlers.onBarrageStart?.(msgData)
            broadcast('BARRAGE_START', msgData)
            break
          case 'BARRAGE_STOP':
            handlers.onBarrageStop?.()
            broadcast('BARRAGE_STOP', {})
            break
          case 'BARRAGE_TEXT_READ':
            handlers.onBarrageTextRead?.(msgData.text)
            break
          case 'BARRAGE_IMAGE':
            if (msgData?.base64) handlers.onBarrageImage?.(msgData.base64)
            break
          case 'LOG_MESSAGE':
            console.log(`[UI Logger] ${msgData}`)
            break
        }
      }
    })
  })
}

export function broadcast(type, data = {}) {
  if (!wss) return
  const msg = JSON.stringify({ type, data, ts: Date.now() })
  wss.clients.forEach((c) => { if (c.readyState === 1) c.send(msg) })
}

export function on(event, fn)  { handlers[event] = fn }
export function isPaused()     { return paused }
export function getDuckVolume(){ return duckVolume }
export function getFadeMs()    { return fadeMs }

export function setTunnelUrl(url) {
  tunnelUrl = url
  broadcast('TUNNEL_URL', { url })
}
