import { readAudioHistory } from './audio-diagnostics.js'
import { HISTORY_BYTES, readRollingLog } from './rolling-log.js'
import { ROBOT_DIAGNOSTICS_VERSION, readRobotHistory, readRobotIncidents, robotDiagnosticFindings } from './robot-diagnostics.js'

/** A portable text/JSON container. Default export excludes raw backend logs. */
export async function createDiagnosticsReport({ directory, metadata = {}, includeBackendLogs = false }) {
  let events = [], readError = false
  try { events = await readAudioHistory({ directory }) } catch { readError = true }
  let robotEvents = [], robotIncidents = [], robotReadError = false, incidentReadError = false
  await Promise.all([
    readRobotHistory({ directory }).then(value => { robotEvents = value }).catch(() => { robotReadError = true }),
    readRobotIncidents({ directory }).then(value => { robotIncidents = value }).catch(() => { incidentReadError = true }),
  ])
  const safe = {}
  for (const key of ['appVersion', 'electronVersion', 'nodeVersion']) {
    if (typeof metadata[key] === 'string' && /^v?\d+(?:\.\d+){1,3}(?:[-+][a-z0-9.-]{1,30})?$/i.test(metadata[key])) safe[key] = metadata[key]
  }
  if (['darwin', 'win32', 'linux'].includes(metadata.platform)) safe.platform = metadata.platform
  if (['x64', 'arm64', 'ia32', 'arm'].includes(metadata.arch)) safe.arch = metadata.arch
  if (['running', 'exited', 'not-running', 'external'].includes(metadata.backendStatus)) safe.backendStatus = metadata.backendStatus
  if ([1, 2, 3].includes(metadata.machineId)) safe.machineId = metadata.machineId
  if (['flushed', 'unavailable', 'timeout', 'failed'].includes(metadata.diagnosticsFlush)) safe.diagnosticsFlush = metadata.diagnosticsFlush
  for (const key of ['packaged', 'backendEntryExists', 'dependenciesExist', 'ffplayBundled']) {
    if (typeof metadata[key] === 'boolean') safe[key] = metadata[key]
  }
  const report = {
    schemaVersion: 1, generatedAt: new Date().toISOString(), metadata: safe,
    limits: { audioHistoryBytes: HISTORY_BYTES, backendHistoryBytes: HISTORY_BYTES,
      robotHistoryBytes: HISTORY_BYTES, robotIncidentHistoryBytes: HISTORY_BYTES },
    audio: { readError, retainedFrom: events[0]?.ts ?? null, retainedUntil: events.at(-1)?.ts ?? null, events },
    robot: { schemaVersion: ROBOT_DIAGNOSTICS_VERSION,
      available: robotEvents.length > 0 || robotIncidents.length > 0,
      readError: robotReadError, incidentReadError,
      retainedFrom: robotEvents[0]?.ts ?? null, retainedUntil: robotEvents.at(-1)?.ts ?? null,
      events: robotEvents, incidents: robotIncidents, findings: robotDiagnosticFindings(robotEvents, robotIncidents),
      note: robotEvents.length || robotIncidents.length
        ? '结构化机器人记录默认包含；标识仅能在同一次运行内比较。未记录故障不等于完整历史无故障。'
        : '没有可用的结构化机器人记录；旧版本不记录此类信息，缺少记录不代表连接或导航正常。',
    },
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
