import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('api', {
  getShellState: () => ipcRenderer.invoke('shell-get-state'),
  enterMachines: () => ipcRenderer.invoke('shell-enter'),
  selectMachine: id => ipcRenderer.invoke('shell-select-machine', id),
  toggleMachineTabs: () => ipcRenderer.invoke('shell-toggle-tabs'),
  setMachineLayout: layout => ipcRenderer.invoke('shell-set-layout', layout),
  selectMachinePane: (pane, id) => ipcRenderer.invoke('shell-select-pane', pane, id),
  onShellState: callback => {
    const listener = (_event, state) => callback(state)
    ipcRenderer.on('shell-state', listener)
    return () => ipcRenderer.removeListener('shell-state', listener)
  },
  // File picker
  selectMp3File: () => ipcRenderer.invoke('select-mp3-file'),
  selectJsonFile: () => ipcRenderer.invoke('select-json-file'),
  selectMultipleMp3Files: () => ipcRenderer.invoke('select-multiple-mp3-files'),
  selectDocumentFile: () => ipcRenderer.invoke('select-document-file'),
  downloadBarrageLog: () => ipcRenderer.invoke('download-barrage-log'),
  exportStationaryAudio: (groupId, recordingId) => ipcRenderer.invoke('export-stationary-audio', groupId, recordingId),
  exportTtsAudio: (hash, defaultFilename) => ipcRenderer.invoke('export-tts-audio', hash, defaultFilename),

  // Banned words
  readBannedWords:  ()      => ipcRenderer.invoke('read-banned-words'),
  writeBannedWords: (words) => ipcRenderer.invoke('write-banned-words', words),

  // LLM Prompt
  readLlmPrompt:  ()     => ipcRenderer.invoke('read-llm-prompt'),
  writeLlmPrompt: (text) => ipcRenderer.invoke('write-llm-prompt', text),
  readStationaryPrompt: () => ipcRenderer.invoke('read-stationary-prompt'),
  writeStationaryPrompt: (text, stylePrompt, customEnabled) => ipcRenderer.invoke('write-stationary-prompt', text, stylePrompt, customEnabled),
  readBarragePromptName:  ()     => ipcRenderer.invoke('read-barrage-prompt-name'),
  writeBarragePromptName: (text) => ipcRenderer.invoke('write-barrage-prompt-name', text),
  readBarragePromptGeneral:  ()     => ipcRenderer.invoke('read-barrage-prompt-general'),
  readBarragePromptJudge: () => ipcRenderer.invoke('read-barrage-prompt-judge'),
  writeBarragePromptJudge: text => ipcRenderer.invoke('write-barrage-prompt-judge', text),
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
  writeSpeechProfile: (pwd, profile, changes) => ipcRenderer.invoke('write-speech-profile', pwd, profile, changes),

  // Restart backend (picks up new .env without quitting the app)
  restartBackend: () => ipcRenderer.invoke('restart-backend'),

  // Backend health — fired when the backend process dies, so the UI can show why
  onBackendExit: (callback) => ipcRenderer.on('backend-exit', (_event, info) => callback(info)),
  getBackendStatus: () => ipcRenderer.invoke('get-backend-status'),
  getUiPort: () => ipcRenderer.invoke('get-ui-port'),
  onUiPort: (callback) => ipcRenderer.on('ui-port', (_event, port) => callback(port)),
  exportDiagnostics: (options = {}) => ipcRenderer.invoke('export-diagnostics', { includeBackendLogs: options?.includeBackendLogs === true }),

  // Barrage Overlay
  openBarrageOverlay: () => ipcRenderer.invoke('open-barrage-overlay'),
  closeBarrageOverlay: (rect) => ipcRenderer.invoke('close-barrage-overlay', rect),
  onBarrageRegionSelected: (callback) => {
    const listener = (_event, rect) => callback(rect)
    ipcRenderer.on('barrage-region-selected', listener)
    return () => ipcRenderer.removeListener('barrage-region-selected', listener)
  },
  captureScreenRegion: (rect) => ipcRenderer.invoke('capture-screen-region', rect),
  getScreenSourceId: () => ipcRenderer.invoke('get-screen-source-id'),
  openScreenRecordingSettings: () => ipcRenderer.invoke('open-screen-recording-settings')
})
