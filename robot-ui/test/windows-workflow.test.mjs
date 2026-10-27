import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const workflow = readFileSync(new URL('../../.github/workflows/windows-package.yml', import.meta.url), 'utf8')
const begin = workflow.indexOf('      - name: Verify packaged Electron audio and OCR runtime')
const end = workflow.indexOf('      - name:', begin + 10)
const nativeStep = workflow.slice(begin, end)

test('Windows native gate waits for the exact GUI process and requires its finished report', () => {
  assert.ok(begin >= 0 && end > begin)
  assert.match(nativeStep, /Start-Process[^\r\n]*-Wait[^\r\n]*-PassThru/)
  assert.match(nativeStep, /\$native\.ExitCode -ne 0/)
  assert.doesNotMatch(nativeStep, /if\s*\(\$LASTEXITCODE/)
  assert.match(nativeStep, /-not \(Test-Path \$report\)/)
  assert.match(nativeStep, /ConvertFrom-Json\)\.status -ne 'passed'/)
  assert.match(nativeStep, /finally[\s\S]*Remove-Item Env:ELECTRON_RUN_AS_NODE/)
  assert.match(nativeStep, /timeout-minutes: 5/)
})

test('Windows delivery requires packaged PCM and real installer upgrade verification', () => {
  const start = workflow.indexOf('      - name: Verify packaged upgrade, tray reinstall and three robot audio streams')
  const finish = workflow.indexOf('      - name:', start + 10)
  assert.ok(start > end && finish > start)
  const step = workflow.slice(start, finish)
  assert.match(step, /machine-upgrade-smoke\.mjs --installer/)
  assert.match(step, /Setup\.\$version\.exe/)
  assert.match(step, /\$LASTEXITCODE -ne 0/)
  assert.match(step, /\$report\.status -ne 'passed' -or -not \$report\.installerVerified/)
  assert.doesNotMatch(step, /continue-on-error|if: always/)
  assert.ok(workflow.indexOf('      - name: Deliver exact test tag') > finish)
})
