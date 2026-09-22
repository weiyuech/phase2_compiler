import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { machineProfile, seedMachineProfile, backendEnvironment } from '../src/packaging/machine-profile.js'

const projectRoot = resolve(import.meta.dirname, '..')

test('machine 1 retains the legacy directory; other machines have separate writable profiles and sessions', () => {
  for (const packaged of [true, false]) {
    const profiles = [1, 2, 3].map(id => machineProfile({ id, packaged, projectRoot: '/project', userDataDir: '/user-data' }))
    assert.equal(profiles[0].root, packaged ? '/user-data' : '/project')
    assert.equal(new Set(profiles.map(p => p.root)).size, 3)
    assert.equal(new Set(profiles.map(p => p.partition)).size, 3)
    assert.deepEqual(profiles.map(p => p.defaultRobotPort), [8765, 8766, 8767])
  }
  assert.throws(() => machineProfile({ id: '../other' }), /Unknown machine/)
})

test('new machine defaults never copy content or credentials from the existing machine, and preserve edits on restart', t => {
  const root = mkdtempSync(join(tmpdir(), 'machine-defaults-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const id of [2, 3]) {
    const profile = { id, root: join(root, String(id)) }
    assert.equal(seedMachineProfile({ profile, packaged: false, projectRoot }).environmentCreated, true)
    const env = readFileSync(join(profile.root, '.env'), 'utf8')
    assert.match(env, /^TTS_API_KEY=$/m)
    assert.match(env, /^ROBOT_URL=$/m)
    assert.deepEqual(JSON.parse(readFileSync(join(profile.root, 'data/tour-list.json'), 'utf8')), [])
    assert.equal(existsSync(join(profile.root, 'config/admin.json')), false)
    writeFileSync(join(profile.root, '.env'), 'MACHINE_OWNED=yes\n')
    writeFileSync(join(profile.root, 'data/tour-list.json'), '[{"goal_id":42}]')
    assert.equal(seedMachineProfile({ profile, packaged: false, projectRoot }).environmentCreated, false)
    assert.equal(readFileSync(join(profile.root, '.env'), 'utf8'), 'MACHINE_OWNED=yes\n')
    assert.deepEqual(JSON.parse(readFileSync(join(profile.root, 'data/tour-list.json'), 'utf8')), [{ goal_id: 42 }])
  }
})

test('a child gets only its own .env and port; parent secrets and dotenv overrides cannot leak across machines', () => {
  const env = backendEnvironment({
    parent: { PATH: '/bin', HOME: '/home/user', SystemRoot: 'C:\\Windows', TTS_API_KEY: 'parent-secret',
      TRANSIT_QWEN_API_KEY: 'other-secret', ROBOT_URL: 'ws://wrong-machine', DOTENV_CONFIG_OVERRIDE: 'true',
      NODE_OPTIONS: '--require bad.js', HTTPS_PROXY: 'https://proxy' },
    projectRoot: '/app', userDataDir: '/data/machine-2', environmentPath: '/data/machine-2/.env', path: '/bin', id: 2,
  })
  assert.equal(env.SystemRoot, 'C:\\Windows')
  assert.equal(env.HTTPS_PROXY, 'https://proxy')
  assert.equal(env.DOTENV_CONFIG_PATH, '/data/machine-2/.env')
  assert.equal(env.USER_DATA_DIR, '/data/machine-2')
  assert.equal(env.DIAGNOSTICS_DIR, '/data/machine-2')
  assert.equal(env.UI_PORT, '0')
  for (const key of ['TTS_API_KEY', 'TRANSIT_QWEN_API_KEY', 'ROBOT_URL', 'DOTENV_CONFIG_OVERRIDE', 'NODE_OPTIONS']) assert.equal(env[key], undefined)
})
