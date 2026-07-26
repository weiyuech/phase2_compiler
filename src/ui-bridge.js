import { WebSocketServer } from 'ws'

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

export function start(port = 3001) {
  wss = new WebSocketServer({ port })

  wss.on('connection', (ws) => {
    const sendTo = (type, data) => ws.send(JSON.stringify({ type, data, ts: Date.now() }))
    sendTo('STATUS', { paused, duckVolume, fadeMs })
    if (tunnelUrl) sendTo('TUNNEL_URL', { url: tunnelUrl })
    handlers.onNewClient?.(sendTo)

    ws.on('message', (data, isBinary) => {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      
      // Strict PNG Signature Check: 89 50 4E 47
      const isPng = buffer.length > 8 && 
                    buffer[0] === 0x89 && buffer[1] === 0x50 && 
                    buffer[2] === 0x4E && buffer[3] === 0x47;

      if (isPng) {
        console.log(`[DEBUG] [WS] Received valid PNG image packet (${buffer.length} bytes)`);
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
        
        const { type, data: msgData } = msg
        
        if (type !== 'BARRAGE_IMAGE') {
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
