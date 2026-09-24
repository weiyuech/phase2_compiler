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
  const executable = join(workspace, 'guard-test.exe')
  const script = join(workspace, 'guard-test.nsi')
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
  StrCpy $INSTDIR "${quoted(join(workspace, 'empty-installation'))}"
  !insertmacro customCheckAppRunning
SectionEnd
`)
  const compiler = await getMakeNsisPath()
  await run(compiler.path, ['-INPUTCHARSET', 'UTF8', '-V2', script], {
    env: { ...process.env, ...compiler.env }, windowsHide: true, timeout: 60000,
  })
  for (const isolated of [false, true]) {
    const name = isolated ? 'isolated-profile' : 'normal-profile'
    const directory = join(workspace, name)
    const temporary = join(directory, 'temp')
    const roaming = join(directory, 'roaming')
    const local = join(directory, 'local')
    await Promise.all([temporary, roaming, local].map(path => mkdir(path, { recursive: true })))
    const env = isolated
      ? Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|PATHEXT|HOME|USERPROFILE|USERNAME|USERDOMAIN|APPDATA|LOCALAPPDATA|PROGRAMDATA|ALLUSERSPROFILE|PUBLIC|PROGRAMFILES(?:\(X86\))?|PROGRAMW6432|COMMONPROGRAMFILES(?:\(X86\))?|COMMONPROGRAMW6432|PROCESSOR_ARCHITECTURE|SYSTEMROOT|WINDIR|COMSPEC|SYSTEMDRIVE|TEMP|TMP|TMPDIR|LANG|LC_.*|DISPLAY|WAYLAND_DISPLAY|XDG_.*)$/i.test(key)))
      : { ...process.env }
    for (const key of Object.keys(env)) if (/^(TEMP|TMP)$/i.test(key) || (isolated && /^(APPDATA|LOCALAPPDATA)$/i.test(key))) delete env[key]
    Object.assign(env, { TEMP: temporary, TMP: temporary })
    if (isolated) Object.assign(env, { APPDATA: roaming, LOCALAPPDATA: local })
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
