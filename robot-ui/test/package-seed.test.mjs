import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { preparePackageSeed, verifyPackageSeed } from '../scripts/prepare-package-seed.mjs'
import { SEED_CONFIG_FILES, SEED_DATA_FILES, SEED_MODEL_FILES } from '../../src/packaging/seed-manifest.js'
import { fixture, put } from '../../test/package-seed-fixture.js'

const uiRoot = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(join(uiRoot, 'package.json'))
const { FileMatcher, copyFiles } = require('app-builder-lib/out/fileMatcher.js')
const manifest = JSON.parse(readFileSync(join(uiRoot, 'package.json')))

test('installer retains app identity and synchronizes test version metadata', () => {
  const lock = JSON.parse(readFileSync(join(uiRoot, 'package-lock.json')))
  assert.equal(manifest.version, '1.0.2-test.8')
  assert.equal(lock.version, manifest.version)
  assert.equal(lock.packages[''].version, manifest.version)
  assert.equal(manifest.name, 'robot-live-ui')
  assert.equal(manifest.build.appId, 'com.robot.live')
  assert.equal(manifest.build.win.executableName, 'robot-live-ui')
  assert.equal(manifest.build.nsis.artifactName, 'Setup.${version}.${ext}')
  assert.equal(manifest.build.nsis.deleteAppDataOnUninstall, undefined)
})

test('actual electron-builder extraResource filters only copy reviewed staged defaults and models', async t => {
  const root = fixture(t)
  const staged = preparePackageSeed({ projectRoot: root })
  // Even unexpected files injected after staging must not pass the builder filter.
  for (const file of ['config/admin.json', 'data/backend.log', 'data/audio-diagnostics.log',
    'data/barrage-ocr-log.txt', 'data/tts-cache/private.txt', 'data/robot-pcm-cache/pcm-private.pcm',
    'data/flatfiles/private/route/1.json']) put(staged, file, 'PRIVATE_FIXTURE')
  const seedMappings = manifest.build.extraResources.filter(item => item.from.startsWith('resources/backend-seed/'))
  assert.equal(seedMappings.length, 3)
  assert.equal(manifest.build.extraResources.some(item => ['../data', '../config', '../.env', '../.env.example'].includes(item.from)), false)
  assert.deepEqual(seedMappings.find(item => item.to === 'backend/config').filter, [...SEED_CONFIG_FILES])
  assert.deepEqual([...seedMappings.find(item => item.to === 'backend/data').filter].sort(),
    [...Object.keys(SEED_DATA_FILES), ...SEED_MODEL_FILES.map(file => `models/${file}`)].sort())
  const resources = join(root, 'packaged-resources')
  const matchers = seedMappings.map(item => new FileMatcher(
    resolve(root, 'robot-ui', item.from), resolve(resources, item.to), value => value, item.filter,
  ))
  await copyFiles(matchers)
  assert.deepEqual(verifyPackageSeed({ backendRoot: join(resources, 'backend'), projectRoot: root }),
    { configFiles: 4, dataFiles: 7, modelFiles: 3 })
})
