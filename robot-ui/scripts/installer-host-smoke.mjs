import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { getMakeNsisPath } from 'app-builder-lib/out/toolsets/windows.js'

// Exercise the exact NSIS hook before spending time building the full app.
// A random executable name and an empty installation directory ensure that
// this harness cannot select the real app or any existing backend process.
assert.equal(process.platform, 'win32', 'Installer host verification requires Windows')
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Run only on a disposable CI runner')
assert.ok(process.env.RUNNER_TEMP)
const run = promisify(execFile)
const root = resolve(import.meta.dirname, '../..')
const workspace = await mkdtemp(join(process.env.RUNNER_TEMP, 'installer-host-'))
const output = join(root, 'release', 'installer-host-smoke')
const records = []
const quoted = value => value.replaceAll('$', () => '$$').replaceAll('"', () => '$\\"')
await mkdir(output, { recursive: true })
try {
  const compiler = await getMakeNsisPath()
  for (const [name, leaf] of [['ordinary-path', 'ordinary'], ['literal-path', "path with spaces and O'Brien"]]) {
    const directory = join(workspace, leaf)
    const temporary = join(directory, 'temp')
    await mkdir(temporary, { recursive: true })
    const executable = join(directory, 'guard-test.exe')
    const script = join(directory, 'guard-test.nsi')
    await writeFile(script, `Unicode true
!include "LogicLib.nsh"
!define BUILD_RESOURCES_DIR "${quoted(join(root, 'robot-ui', 'build'))}"
!define APP_EXECUTABLE_FILENAME "guard-fixture-${randomUUID()}.exe"
!include "${quoted(join(root, 'robot-ui', 'build', 'installer.nsh'))}"
Name "Installer guard verification"
OutFile "${quoted(executable)}"
RequestExecutionLevel user
SilentInstall silent
Section
  StrCpy $INSTDIR "${quoted(join(directory, 'empty-installation'))}"
  !insertmacro customCheckAppRunning
SectionEnd
`)
    await run(compiler.path, ['-INPUTCHARSET', 'UTF8', '-V2', script], {
      env: { ...process.env, ...compiler.env }, windowsHide: true, timeout: 60000,
    })
    // Preserve the real Windows account environment and known folders. Spoofing
    // APPDATA/LOCALAPPDATA while retaining that account creates an inconsistent
    // profile and was observed to block PowerShell startup on the runner.
    const env = { ...process.env }
    for (const key of Object.keys(env)) if (/^(TEMP|TMP)$/i.test(key)) delete env[key]
    Object.assign(env, { TEMP: temporary, TMP: temporary })
    const started = Date.now()
    const record = { name }
    try {
      await run(executable, ['/S'], { env, windowsHide: true, timeout: 15000 })
      record.status = 'passed'
    } catch (error) {
      record.status = 'failed'
      record.error = { code: error.code, signal: error.signal, killed: error.killed, message: error.message }
    }
    record.elapsedMs = Date.now() - started
    for (const filename of ['robot-live-installer-exit-status.log', 'robot-live-installer-exit-diagnostic.json']) {
      try {
        const text = await readFile(join(temporary, filename), 'utf8')
        record[filename] = text
        await writeFile(join(output, `${name}-${filename}`), text)
      } catch (error) { record[filename] = error.code }
    }
    if (record.status === 'passed') {
      try {
        const diagnostic = JSON.parse(record['robot-live-installer-exit-diagnostic.json'])
        assert.equal(diagnostic.Phase, 'completed')
        assert.equal(diagnostic.ExitCode, 0)
        assert.equal(diagnostic.Is64BitProcess, true)
      } catch (error) {
        record.status = 'failed'
        record.error = { message: `Installer reported success without a completed native helper: ${error.message}` }
      }
    }
    records.push(record)
    console.log('[installer-host]', JSON.stringify(record))
  }
  assert.ok(records.every(record => record.status === 'passed'), 'Real NSIS process handoff failed; inspect installer-host diagnostics')
} finally {
  await writeFile(join(output, 'report.json'), JSON.stringify(records, null, 2) + '\n')
  await rm(workspace, { recursive: true, force: true })
}
