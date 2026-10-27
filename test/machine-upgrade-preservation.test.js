import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parse as parseEnv } from 'dotenv'
import { machineProfile, seedMachineProfile } from '../src/packaging/machine-profile.js'
import { SEED_CONFIG_FILES, SEED_DATA_FILES } from '../src/packaging/seed-manifest.js'

// Tests the packaged seeding branch without creating an installer, reading a
// developer profile, or copying runtime files into a release directory.
test('packaged three-machine upgrade retains legacy bytes, starts new machines empty and preserves each machine on the next upgrade', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'machine-upgrade-preservation-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const projectRoot = join(temporary, 'synthetic-package')
  const userDataDir = join(temporary, 'legacy-user-data')
  const put = async (root, relative, value) => {
    const path = join(root, relative)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, value)
  }
  for (const [relative, content] of Object.entries(SEED_DATA_FILES)) await put(projectRoot, `data/${relative}`, content)
  for (const file of SEED_CONFIG_FILES) await put(projectRoot, `config/${file}`, `reviewed synthetic default: ${file}\n`)
  await put(projectRoot, '.env.example', 'TTS_API_KEY=\nROBOT_URL=\nSPEECH_PROFILES_VERSION=1\n')
  const profiles = [1, 2, 3].map(id => machineProfile({ id, packaged: true, projectRoot, userDataDir }))
  assert.equal(profiles[0].root, userDataDir)
  assert.equal(new Set(profiles.map(profile => profile.root)).size, 3)
  const ownFiles = id => ({
    '.env': `TTS_API_KEY=SYNTHETIC_MACHINE_${id}\r\nROBOT_URL=\r\n`,
    'config/admin.json': JSON.stringify({ hash: `synthetic-hash-${id}`, salt: `synthetic-salt-${id}` }),
    ...Object.fromEntries(SEED_CONFIG_FILES.map(file => [`config/${file}`, `机器 ${id} 的自定义脚本\r\n${file}\r\n`])),
    'data/tour-list.json': JSON.stringify([{ map_name: `map-${id}`, path_name: `path-${id}`, goal_id: id, play_mode: 'mp3' }]),
    [`data/flatfiles/map-${id}/path-${id}/${id}.json`]: JSON.stringify({ body: `机器 ${id} 自己的点位内容` }),
    [`data/tts-cache/library-${id}.mp3`]: Buffer.from([0x49, 0x44, 0x33, id, 0, 0xff, 0x80]),
    [`data/tts-cache/library-${id}.txt`]: `机器 ${id} 已保存语音文字\r\n`,
    'data/robot-pcm-cache/owner.json': id === 2 ? '{partial' : JSON.stringify({ kind: 'robot-pcm-cache-v1', pid: process.pid, nonce: `legacy-${id}` }),
    'data/transit-audio.json': JSON.stringify({ enabled: true, type: 'mp3', mp3_file: `owned-${id}.mp3`, mp3_files: [`owned-${id}.mp3`] }),
    'data/barrage-knowledge/config.json': JSON.stringify({ mode: 'mp3', document_name: `owned-${id}`, cooldown: id }),
  })
  const expected = new Map()
  async function populate(profile) {
    for (const [relative, bytes] of Object.entries(ownFiles(profile.id))) {
      await put(profile.root, relative, bytes)
      expected.set(join(profile.root, relative), Buffer.from(bytes))
    }
  }
  async function checkOriginalBytes() {
    for (const [path, bytes] of expected) assert.ok((await readFile(path)).equals(bytes), path)
  }
  await populate(profiles[0])
  for (const profile of profiles) seedMachineProfile({ profile, packaged: true, projectRoot })
  await checkOriginalBytes()
  // An intentionally missing legacy data default stays missing on upgrade.
  await assert.rejects(readFile(join(userDataDir, 'data/audio-output.json')), { code: 'ENOENT' })
  for (const profile of profiles.slice(1)) {
    const env = parseEnv(await readFile(join(profile.root, '.env')))
    assert.equal(env.TTS_API_KEY, '')
    assert.equal(env.ROBOT_URL, '')
    assert.deepEqual(JSON.parse(await readFile(join(profile.root, 'data/tour-list.json'))), [])
    for (const relative of ['data/flatfiles', 'data/tts-cache', 'data/cruising-audio']) assert.deepEqual(await readdir(join(profile.root, relative)), [])
    await assert.rejects(readFile(join(profile.root, 'config/admin.json')), { code: 'ENOENT' })
    await populate(profile)
  }
  for (const profile of profiles) seedMachineProfile({ profile, packaged: true, projectRoot })
  await checkOriginalBytes()
  for (const profile of profiles) assert.deepEqual((await readdir(join(profile.root, 'data/tts-cache'))).sort(), [`library-${profile.id}.mp3`, `library-${profile.id}.txt`])
})
