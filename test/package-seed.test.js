import assert from 'node:assert/strict'
import test from 'node:test'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { preparePackageSeed, verifyPackageSeed } from '../robot-ui/scripts/prepare-package-seed.mjs'
import { seedPackagedUserData } from '../src/packaging/seed-user-data.js'
import { SEED_CONFIG_FILES, SEED_DATA_FILES, SEED_EMPTY_DIRECTORIES, SEED_MODEL_FILES } from '../src/packaging/seed-manifest.js'
import { contents, files, fixture, put } from './package-seed-fixture.js'

const templates = fileURLToPath(new URL('../robot-ui/packaging/defaults/', import.meta.url))
const marker = '.robot-live-package-seed.json'

test('seed staging allowlists models and reviewed defaults, without reading or changing live content', t => {
  const root = fixture(t)
  const liveFiles = [
    '.env', '.env.example', 'config/admin.json', 'config/llm-system-prompt.txt',
    'data/tour-list.json', 'data/transit-audio.json', 'data/barrage-knowledge/config.json',
    'data/tts-cache/private.mp3', 'data/tts-cache/private.txt', 'data/barrage-ocr-log.txt',
    'data/audio-diagnostics.log', 'data/backend.log.1', 'data/robot-pcm-cache/pcm-private.pcm',
    'data/flatfiles/private/route/1.json', 'data/barrage-audio/private.mp3', 'data/temp-tts-play-1-1.mp3',
  ]
  for (const file of liveFiles) put(root, file, `PRIVATE_LIVE_FIXTURE:${file}`)
  const before = Object.fromEntries(liveFiles.map(file => [file, readFileSync(join(root, file), 'utf8')]))
  const staged = preparePackageSeed({ projectRoot: root })
  const expected = [marker, '.env.example', ...SEED_CONFIG_FILES.map(file => `config/${file}`),
    ...Object.keys(SEED_DATA_FILES).map(file => `data/${file}`), ...SEED_MODEL_FILES.map(file => `data/models/${file}`)]
  assert.deepEqual(files(staged), expected.sort())
  for (const file of files(staged)) assert.equal(readFileSync(join(staged, file), 'utf8').includes('PRIVATE_LIVE_FIXTURE'), false, file)
  assert.deepEqual(Object.fromEntries(liveFiles.map(file => [file, readFileSync(join(root, file), 'utf8')])), before)
  assert.deepEqual(verifyPackageSeed({ backendRoot: staged, projectRoot: root, staged: true }), { configFiles: 4, dataFiles: 7, modelFiles: 3 })
})

test('rebuilding a marked generated stage drops stale resources, but preserves an unowned directory', t => {
  const root = fixture(t)
  const staged = preparePackageSeed({ projectRoot: root })
  put(staged, 'data/backend.log', 'stale generated content')
  preparePackageSeed({ projectRoot: root })
  assert.equal(existsSync(join(staged, 'data/backend.log')), false)
  rmSync(join(staged, marker))
  put(staged, 'keep.txt', 'unowned content')
  const before = contents(staged)
  assert.throws(() => preparePackageSeed({ projectRoot: root }), /unowned/)
  assert.deepEqual(contents(staged), before)
})

test('failed staging preserves previous output and removes only its generated work directory', t => {
  const root = fixture(t), staged = preparePackageSeed({ projectRoot: root })
  const before = contents(staged)
  rmSync(join(root, 'data/models', SEED_MODEL_FILES[0]))
  assert.throws(() => preparePackageSeed({ projectRoot: root }), /ENOENT/)
  assert.deepEqual(contents(staged), before)
  assert.deepEqual(readdirSync(join(root, 'robot-ui/resources')), ['backend-seed'])
})

test('nonempty credentials or robot destinations in a template fail staging', t => {
  const root = fixture(t), localTemplates = join(root, 'templates')
  cpSync(templates, localTemplates, { recursive: true })
  const environmentPath = join(localTemplates, 'backend.env.example')
  const environment = readFileSync(environmentPath, 'utf8')
  for (const replacement of ['TTS_API_KEY=PRIVATE_TEST_KEY', 'ROBOT_URL=ws://192.0.2.1:8765']) {
    const key = replacement.slice(0, replacement.indexOf('='))
    writeFileSync(environmentPath, environment.replace(`${key}=\n`, `${replacement}\n`))
    assert.throws(() => preparePackageSeed({ projectRoot: root, templatesRoot: localTemplates }), /must be blank/)
    assert.equal(existsSync(join(root, 'robot-ui/resources/backend-seed')), false)
  }
})

test('final-resource verification rejects extra files, altered defaults and changed model bytes', t => {
  const root = fixture(t), staged = preparePackageSeed({ projectRoot: root })
  rmSync(join(staged, marker))
  const verify = () => verifyPackageSeed({ backendRoot: staged, projectRoot: root })
  assert.doesNotThrow(verify)
  for (const file of ['.env', 'config/admin.json', 'data/backend.log', 'data/tts-cache/transcript.txt']) {
    const target = put(staged, file, 'PRIVATE_FIXTURE')
    assert.throws(verify, /Unexpected|allowlist/)
    rmSync(target)
  }
  mkdirSync(join(staged, 'data/unreviewed-directory'))
  assert.throws(verify, /directory allowlist/)
  rmSync(join(staged, 'data/unreviewed-directory'), { recursive: true })
  writeFileSync(join(staged, 'data/tour-list.json'), '[{"goal_id":1}]')
  assert.throws(verify, /setting is not clean/)
  writeFileSync(join(staged, 'data/tour-list.json'), SEED_DATA_FILES['tour-list.json'])
  writeFileSync(join(staged, 'data/models', SEED_MODEL_FILES[0]), 'wrong-model')
  assert.throws(verify, /source model/)
})

test('new packaged user data starts empty/local/disabled with no models, admin credential or runtime content copied', t => {
  const root = fixture(t), staged = preparePackageSeed({ projectRoot: root }), userData = join(root, 'new-user')
  put(staged, 'config/admin.json', 'must not seed')
  put(staged, 'data/backend.log', 'must not seed')
  const result = seedPackagedUserData({ packaged: true, projectRoot: staged, userDataDir: userData })
  assert.equal(result.dataCreated, true)
  assert.equal(result.environmentCreated, true)
  assert.deepEqual(result.configCreated, SEED_CONFIG_FILES)
  assert.deepEqual(files(join(userData, 'data')), Object.keys(SEED_DATA_FILES).sort())
  assert.deepEqual(JSON.parse(readFileSync(join(userData, 'data/tour-list.json'))), [])
  assert.equal(JSON.parse(readFileSync(join(userData, 'data/transit-audio.json'))).enabled, false)
  assert.equal(JSON.parse(readFileSync(join(userData, 'data/audio-output.json'))).destination, 'local')
  for (const file of SEED_EMPTY_DIRECTORIES) assert.deepEqual(readdirSync(join(userData, 'data', file)), [])
  assert.equal(existsSync(join(userData, 'config/admin.json')), false)
  assert.equal(existsSync(join(userData, 'data/models')), false)
})

test('upgrade preserves every existing data/config/environment byte and does not restore missing data defaults', t => {
  const root = fixture(t), staged = preparePackageSeed({ projectRoot: root }), userData = join(root, 'existing-user')
  put(userData, '.env', 'ROBOT_URL=ws://192.0.2.2:8765\nTTS_API_KEY=USER_TEST_KEY\n')
  for (const file of SEED_CONFIG_FILES) put(userData, `config/${file}`, `USER_PROMPT:${file}`)
  put(userData, 'config/admin.json', 'USER_HASH_AND_SALT_FIXTURE')
  put(userData, 'data/tour-list.json', '[{"goal_id":99}]')
  put(userData, 'data/transit-audio.json', '{"enabled":true,"text":"USER_TEXT"}')
  put(userData, 'data/tts-cache/recording.mp3', 'USER_AUDIO_FIXTURE')
  put(userData, 'data/flatfiles/custom/route/99.json', '{"body":"USER_CONTENT"}')
  const before = contents(userData)
  const result = seedPackagedUserData({ packaged: true, projectRoot: staged, userDataDir: userData })
  assert.deepEqual(result, { dataCreated: false, environmentCreated: false, configCreated: [] })
  assert.deepEqual(contents(userData), before)
  assert.equal(existsSync(join(userData, 'data/audio-output.json')), false)
})

test('only missing reviewed config files are added; development performs no seeding', t => {
  const root = fixture(t), staged = preparePackageSeed({ projectRoot: root }), userData = join(root, 'existing-user')
  mkdirSync(join(userData, 'data'), { recursive: true })
  put(userData, 'config/llm-system-prompt.txt', 'USER_PROMPT')
  put(userData, '.env', 'USER_ENV')
  const result = seedPackagedUserData({ packaged: true, projectRoot: staged, userDataDir: userData })
  assert.equal(readFileSync(join(userData, 'config/llm-system-prompt.txt'), 'utf8'), 'USER_PROMPT')
  assert.equal(result.configCreated.length, 3)
  assert.deepEqual(readdirSync(join(userData, 'data')), [])
  const devData = join(root, 'not-created')
  assert.deepEqual(seedPackagedUserData({ packaged: false, projectRoot: '/missing', userDataDir: devData }),
    { dataCreated: false, environmentCreated: false, configCreated: [] })
  assert.equal(existsSync(devData), false)
})

test('missing first-run input fails before creating the user data directory', t => {
  const root = fixture(t), staged = preparePackageSeed({ projectRoot: root }), userData = join(root, 'new-user')
  rmSync(join(staged, 'data/transit-audio.json'))
  assert.throws(() => seedPackagedUserData({ packaged: true, projectRoot: staged, userDataDir: userData }), /Missing/)
  assert.equal(existsSync(join(userData, 'data')), false)
})
