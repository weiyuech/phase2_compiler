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
  assert.match(hook, /nsExec::Exec \/TIMEOUT=10000[^\r\n]+-NoProfile -NonInteractive[^\r\n]+-File/)
  assert.match(hook, /-InstallDirectory "\$INSTDIR\\\." -AppExecutable "\$\{APP_EXECUTABLE_FILENAME\}"/)
  assert.match(hook, /Pop \$0\s+\$\{If\} \$0 != 0[\s\S]*MessageBox MB_OK\|MB_ICONSTOP[\s\S]*\/SD IDOK\s+SetErrorLevel 1\s+Abort/)
  assert.doesNotMatch(hook, /taskkill|Sleep 1500|RMDir|Delete /)
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
})
