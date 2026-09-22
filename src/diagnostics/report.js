import { readAudioHistory } from './audio-diagnostics.js'
import { HISTORY_BYTES, readRollingLog } from './rolling-log.js'

/** A portable text/JSON container. Default export excludes raw backend logs. */
export async function createDiagnosticsReport({ directory, metadata = {}, includeBackendLogs = false }) {
  let events = [], readError = false
  try { events = await readAudioHistory({ directory }) } catch { readError = true }
  const safe = {}
  for (const key of ['appVersion', 'electronVersion', 'nodeVersion']) {
    if (typeof metadata[key] === 'string' && /^v?\d+(?:\.\d+){1,3}(?:[-+][a-z0-9.-]{1,30})?$/i.test(metadata[key])) safe[key] = metadata[key]
  }
  if (['darwin', 'win32', 'linux'].includes(metadata.platform)) safe.platform = metadata.platform
  if (['x64', 'arm64', 'ia32', 'arm'].includes(metadata.arch)) safe.arch = metadata.arch
  if (['running', 'exited', 'not-running', 'external'].includes(metadata.backendStatus)) safe.backendStatus = metadata.backendStatus
  for (const key of ['packaged', 'backendEntryExists', 'dependenciesExist', 'ffplayBundled']) {
    if (typeof metadata[key] === 'boolean') safe[key] = metadata[key]
  }
  const report = {
    schemaVersion: 1, generatedAt: new Date().toISOString(), metadata: safe,
    limits: { audioHistoryBytes: HISTORY_BYTES, backendHistoryBytes: HISTORY_BYTES },
    audio: { readError, retainedFrom: events[0]?.ts ?? null, retainedUntil: events.at(-1)?.ts ?? null, events },
    limitations: ['Sender timing is measured; robot receive/playout and AV synchronization are not measured.',
      'History is rolling and oldest records are discarded; the last unflushed records can be lost on a crash.'],
    backendLogsIncluded: includeBackendLogs === true,
  }
  if (includeBackendLogs === true) {
    report.privacyWarning = 'Raw backend output may contain spoken/OCR text, document contents, paths or URLs. Review before sharing.'
    try { report.backendHistory = await readRollingLog({ directory, name: 'backend.log' }) }
    catch { report.backendHistory = '(backend history unavailable)' }
  }
  return JSON.stringify(report, null, 2)
}
