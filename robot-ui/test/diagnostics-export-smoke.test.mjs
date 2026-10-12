import test from 'node:test'
import assert from 'node:assert/strict'
import { verifyDiagnosticExport } from '../scripts/diagnostics-export-smoke.mjs'

const expected = { machineId: 2, packaged: true, appVersion: '1.1.0-test.5' }
const runId = 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa'
function fixture() {
  return {
    metadata: { ...expected, backendStatus: 'running', diagnosticsFlush: 'flushed' },
    backendLogsIncluded: false,
    robot: { schemaVersion: 1, available: true, readError: false, incidentReadError: false,
      events: [{ type: 'robot-recorder-start', runId }, { type: 'robot-connection-open', runId }] },
  }
}

test('packaged diagnostic smoke accepts the real Windows BOM/CRLF export envelope', () => {
  const raw = '\uFEFF' + JSON.stringify(fixture(), null, 2).replace(/\n/g, '\r\n')
  assert.deepEqual(verifyDiagnosticExport(raw, expected), {
    machineId: 2, runId, eventCount: 2, diagnosticsFlush: 'flushed', backendLogsIncluded: false,
  })
})

test('package gate rejects absent recorder startup, failed flush, wrong machine and raw logs', () => {
  for (const mutate of [
    report => { report.robot.events.shift() },
    report => { report.robot.events.pop() },
    report => { report.metadata.diagnosticsFlush = 'timeout' },
    report => { report.metadata.diagnosticsFlush = 'failed' },
    report => { report.metadata.machineId = 1 },
    report => { report.metadata.packaged = false },
    report => { report.metadata.appVersion = '1.1.0-test.4' },
    report => { report.robot.available = false },
    report => { report.backendHistory = 'raw backend output' },
    report => { report.robot.events[1].runId = 'bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb' },
    report => { report.robot.events[1].receivedMap = 'fixture-map-2' },
  ]) {
    const report = fixture()
    mutate(report)
    assert.throws(() => verifyDiagnosticExport(JSON.stringify(report), expected))
  }
})
