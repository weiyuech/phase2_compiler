import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export function verifyDiagnosticExport(raw, { machineId, packaged, appVersion }) {
  const report = JSON.parse(raw.replace(/^\uFEFF/, ''))
  assert.equal(report.metadata.machineId, machineId, 'Diagnostic export belongs to another machine')
  assert.equal(report.metadata.packaged, packaged, 'Diagnostic export did not come from the expected runtime')
  assert.equal(report.metadata.appVersion, appVersion, 'Diagnostic export came from a different application version')
  assert.equal(report.metadata.backendStatus, 'running', 'Diagnostic export did not observe its live backend')
  assert.equal(report.metadata.diagnosticsFlush, 'flushed', 'Live utility backend did not flush its diagnostic writers')
  assert.equal(report.backendLogsIncluded, false, 'Default export unexpectedly enabled raw backend logs')
  assert.equal(Object.hasOwn(report, 'backendHistory'), false, 'Default export contains raw backend logs')
  assert.equal(report.robot?.schemaVersion, 1, 'Structured robot diagnostics are missing')
  assert.equal(report.robot.available, true, 'The backend did not persist robot diagnostics')
  assert.equal(report.robot.readError, false)
  assert.equal(report.robot.incidentReadError, false)
  const starts = report.robot.events.filter(event => event.type === 'robot-recorder-start')
  assert.equal(starts.length, 1, 'Expected one fresh recorder startup for this synthetic profile')
  const runId = starts[0].runId
  assert.match(runId, /^[a-f0-9-]{36}$/)
  assert.ok(report.robot.events.every(event => event.runId === runId), 'Another runtime leaked into the fresh profile')
  assert.ok(report.robot.events.some(event => event.type === 'robot-connection-open'), 'The real utility backend did not record its loopback connection')
  // These markers only exist in this harness's synthetic profiles and robot
  // messages. The default report must not contain plaintext settings or names.
  assert.doesNotMatch(raw, /synthetic-upgrade-key|synthetic-llm-key|synthetic-barrage-key|fixture-map-|fixture-route-|wss?:\/\//)
  return { machineId, runId, eventCount: report.robot.events.length,
    diagnosticsFlush: report.metadata.diagnosticsFlush, backendLogsIncluded: false }
}

/** Exercise the real renderer/preload/main/utilityProcess export path. Only the
 * native save dialog and folder reveal are replaced, inside a disposable app. */
export async function verifyMachineDiagnosticExports({ app, machine, output, ids, packaged, appVersion }) {
  const results = []
  for (const id of ids) {
    const path = join(output, `machine-${id}-diagnostics.json`)
    await app.evaluate(({ dialog, shell }, path) => {
      if (globalThis.__machineDiagnosticSmokeDialogs) throw new Error('Diagnostic smoke dialog override already active')
      globalThis.__machineDiagnosticSmokeDialogs = {
        save: dialog.showSaveDialog, message: dialog.showMessageBox, reveal: shell.showItemInFolder,
      }
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
      dialog.showMessageBox = async () => { throw new Error('Default export unexpectedly requested raw-log approval') }
      shell.showItemInFolder = () => {}
    }, path)
    try {
      // No options: this is the same default export a client gets from the UI.
      const result = await machine(id, 'window.api.exportDiagnostics()')
      assert.equal(result?.ok, true, `Machine ${id} diagnostic export failed`)
      assert.equal(result.path, path)
      results.push(verifyDiagnosticExport(await readFile(path, 'utf8'), { machineId: id, packaged, appVersion }))
    } finally {
      await app.evaluate(({ dialog, shell }) => {
        const original = globalThis.__machineDiagnosticSmokeDialogs
        if (!original) return
        dialog.showSaveDialog = original.save
        dialog.showMessageBox = original.message
        shell.showItemInFolder = original.reveal
        delete globalThis.__machineDiagnosticSmokeDialogs
      })
    }
  }
  assert.equal(new Set(results.map(result => result.runId)).size, ids.length,
    'Different machines exported the same robot recorder run')
  return results
}
