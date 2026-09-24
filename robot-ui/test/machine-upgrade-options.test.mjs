import test from 'node:test'
import assert from 'node:assert/strict'
import { upgradeSmokeOptions } from '../scripts/machine-upgrade-options.mjs'

test('packaged/installer upgrade acceptance refuses personal machines and incomplete CI environments', () => {
  for (const option of ['--executable', '--installer']) {
    for (const context of [
      { platform: 'darwin', env: { GITHUB_ACTIONS: 'true', RUNNER_TEMP: '/tmp' } },
      { platform: 'win32', env: {} },
      { platform: 'win32', env: { GITHUB_ACTIONS: 'true' } },
      { platform: 'win32', env: { GITHUB_ACTIONS: 'false', RUNNER_TEMP: '/tmp' } },
    ]) assert.throws(() => upgradeSmokeOptions([option, 'test.exe'], context), /disposable Windows GitHub Actions runner/)
  }
})

test('upgrade acceptance rejects ambiguous or incomplete execution arguments', () => {
  const context = { platform: 'win32', env: { GITHUB_ACTIONS: 'true', RUNNER_TEMP: '/tmp' } }
  assert.throws(() => upgradeSmokeOptions(['--installer'], context), /Missing value/)
  assert.throws(() => upgradeSmokeOptions(['--executable', '--output', 'out'], context), /Missing value/)
  assert.throws(() => upgradeSmokeOptions(['--installer', 'a.exe', '--installer', 'b.exe'], context), /Repeated option/)
  assert.throws(() => upgradeSmokeOptions(['--executable', 'app.exe', '--installer', 'setup.exe'], context), /not both/)
  assert.throws(() => upgradeSmokeOptions(['--install', 'setup.exe'], context), /Unknown option/)
  assert.equal(upgradeSmokeOptions(['--installer', 'setup.exe'], context).packaged, true)
  assert.equal(upgradeSmokeOptions([], { platform: 'darwin', env: {} }).packaged, false)
})
