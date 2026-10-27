import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const installer = readFileSync(new URL('../build/installer.nsh', import.meta.url), 'utf8')
const hook = installer.slice(installer.indexOf('!macro customCheckAppRunning'), installer.indexOf('!macroend'))

test('NSIS gates replacement on a bounded, checked helper exit and fails closed', () => {
  assert.match(hook, /File \/oname=\$PLUGINSDIR\\installer-exit-guard\.ps1/)
  assert.match(hook, /CreateProcessW\(w r2, w r1, p 0, p 0, i 0, i 0x08000000, p 0, w "\$WINDIR", p r4, p r5\)/)
  assert.match(hook, /WaitForSingleObject\(p r6, i 10000\)/)
  assert.match(hook, /GetExitCodeProcess\(p r6, \*i\.r0\)/)
  assert.match(hook, /\$8 == 258[\s\S]*StrCpy \$0 "timeout"[\s\S]*TerminateProcess\(p r6, i 1\)/)
  assert.match(hook, /System::Alloc 68[\s\S]*System::Alloc 16[\s\S]*\*\$4\(i 68\)/)
  assert.match(hook, /CloseHandle\(p r7\)[\s\S]*CloseHandle\(p r6\)[\s\S]*System::Free \$5[\s\S]*System::Free \$4/)
  assert.match(hook, /\$\{NSIS_MAX_STRLEN\} - 1[\s\S]*StrCpy \$0 "command-too-long"/)
  assert.match(hook, /-NonInteractive -InputFormat None -ExecutionPolicy Bypass -File/)
  assert.match(hook, /-InstallDirectory "\$INSTDIR\\\." -AppExecutable "\$\{APP_EXECUTABLE_FILENAME\}"/)
  assert.match(hook, /\$\{If\} \$0 != 0[\s\S]*MessageBox MB_OK\|MB_ICONSTOP[\s\S]*\/SD IDOK\s+SetErrorLevel 1\s+Abort/)
  assert.match(hook, /IfFileExists "\$WINDIR\\Sysnative\\WindowsPowerShell\\v1\.0\\powershell\.exe"/)
  assert.match(hook, /FileWrite \$3 "phase=guard-completed\$\\r\$\\nresult=\$0/)
  assert.match(hook, /FileOpen \$3 "\$TEMP\\robot-live-installer-exit-status\.log" a\s+FileSeek \$3 0 END/)
  assert.match(hook, /-DiagnosticPath "\$TEMP\\robot-live-installer-exit-diagnostic\.json"/)
  assert.doesNotMatch(hook, /nsExec::|ExecWait|taskkill|Sleep 1500|RMDir|Delete /)
  assert.match(installer, /vc_redist\.x64\.exe[^\r\n]+\/install \/quiet \/norestart/)
  assert.match(installer, /\$0 == 3010[\s\S]*SetRebootFlag true/)
})

test('Windows installer guard: production orchestration and live synthetic processes', {
  skip: process.platform !== 'win32' ? 'Requires Windows PowerShell 5.1 and Win32_Process; run this same command on Windows.' : false,
  timeout: 45000,
}, () => {
  const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const harness = fileURLToPath(new URL('./installer-exit-guard.windows.ps1', import.meta.url))
  const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness], {
    encoding: 'utf8', timeout: 40000, windowsHide: true,
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /PASS: shutdown orchestration/)
  assert.match(result.stdout, /PASS: real Windows query/)
  assert.match(result.stdout, /PASS: open redirected stdin/)
})
