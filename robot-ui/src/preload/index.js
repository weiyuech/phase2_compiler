import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('api', {
  // File picker
  selectMp3File: () => ipcRenderer.invoke('select-mp3-file'),
  selectJsonFile: () => ipcRenderer.invoke('select-json-file'),
  selectMultipleMp3Files: () => ipcRenderer.invoke('select-multiple-mp3-files'),
  selectDocumentFile: () => ipcRenderer.invoke('select-document-file'),
  downloadBarrageLog: () => ipcRenderer.invoke('download-barrage-log'),
  exportTtsAudio: (hash, defaultFilename) => ipcRenderer.invoke('export-tts-audio', hash, defaultFilename),

  // Banned words
  readBannedWords:  ()      => ipcRenderer.invoke('read-banned-words'),
  writeBannedWords: (words) => ipcRenderer.invoke('write-banned-words', words),

  // LLM Prompt
  readLlmPrompt:  ()     => ipcRenderer.invoke('read-llm-prompt'),
  writeLlmPrompt: (text) => ipcRenderer.invoke('write-llm-prompt', text),
  readBarragePromptName:  ()     => ipcRenderer.invoke('read-barrage-prompt-name'),
  writeBarragePromptName: (text) => ipcRenderer.invoke('write-barrage-prompt-name', text),
  readBarragePromptGeneral:  ()     => ipcRenderer.invoke('read-barrage-prompt-general'),
  writeBarragePromptGeneral: (text) => ipcRenderer.invoke('write-barrage-prompt-general', text),

  // Admin password
  adminHasPassword:    ()               => ipcRenderer.invoke('admin-has-password'),
  adminSetPassword:    (newPwd)         => ipcRenderer.invoke('admin-set-password', newPwd),
  adminChangePassword: (oldPwd, newPwd) => ipcRenderer.invoke('admin-change-password', oldPwd, newPwd),

  // Public .env params (no password)
  readPublicEnv:  ()        => ipcRenderer.invoke('read-public-env'),
  writePublicEnv: (changes) => ipcRenderer.invoke('write-public-env', changes),

  // Sensitive .env params (password-protected)
  readSensitiveEnv:  (pwd)         => ipcRenderer.invoke('read-sensitive-env', pwd),
  writeSensitiveEnv: (pwd, changes) => ipcRenderer.invoke('write-sensitive-env', pwd, changes),

  // Restart backend (picks up new .env without quitting the app)
  restartBackend: () => ipcRenderer.invoke('restart-backend'),

  // Backend health — fired when the backend process dies, so the UI can show why
  onBackendExit: (callback) => ipcRenderer.on('backend-exit', (_event, info) => callback(info)),
  getBackendStatus: () => ipcRenderer.invoke('get-backend-status'),
  exportDiagnostics: () => ipcRenderer.invoke('export-diagnostics'),

  // Barrage Overlay
  openBarrageOverlay: () => ipcRenderer.invoke('open-barrage-overlay'),
  closeBarrageOverlay: (rect) => ipcRenderer.invoke('close-barrage-overlay', rect),
  onBarrageRegionSelected: (callback) => ipcRenderer.on('barrage-region-selected', (_event, rect) => callback(rect)),
  captureScreenRegion: (rect) => ipcRenderer.invoke('capture-screen-region', rect),
  getScreenSourceId: () => ipcRenderer.invoke('get-screen-source-id')
})
