import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'
import { deliverTestRelease, validateReleaseContext, validateNativeReport } from '../scripts/test-release.mjs'

const commit = 'a'.repeat(40)
const otherCommit = 'b'.repeat(40)
const tagObject = 'c'.repeat(40)
const tag = 'v1.0.2-test.1'
const checkNames = ['runtime', 'packaged-layout', 'ffmpeg-pcm', 'ffplay', 'sharp', 'onnx-models', 'ocr-pipeline', 'packaged-native-bindings']
const environment = () => ({
  GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push', GITHUB_REF: `refs/tags/${tag}`,
  GITHUB_SHA: commit, GITHUB_REPOSITORY: 'example/robot', GITHUB_SERVER_URL: 'https://github.com',
  GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', RELEASE_TAG: tag, GH_TOKEN: 'fixture-token-never-export',
})
const nativeReport = () => ({
  schemaVersion: 1, status: 'passed',
  runtime: { platform: 'win32', arch: 'x64', node: '22.0.0', electron: '41.10.7', modules: '145', napi: '10' },
  checks: checkNames.map(name => ({ name, status: 'passed', durationMs: 10, details: { privateDetail: 'not-for-build-info' } })),
})

// Everything below is in memory, including filesystem and gh/git. Tests cannot
// create tags/releases, upload assets, execute binaries or access the network.
function fixture() {
  const root = resolve('/virtual/robot-project')
  const releaseDir = join(root, 'release')
  const installer = 'Robot Setup 1.0.2-test.1.exe'
  const files = new Map()
  const writes = [], commands = [], logs = []
  let clock = 1
  function put(file, value, extra = {}) {
    files.set(file, { data: Buffer.isBuffer(value) ? value : Buffer.from(value), mtimeMs: clock++, ...extra })
  }
  put(join(root, 'robot-ui/package.json'), JSON.stringify({ version: '1.0.2-test.1' }))
  put(join(root, 'docs/windows-test-installer.md'), '# Test installer\nVerify on the actual robot before release.\n')
  put(join(releaseDir, installer), Buffer.from('synthetic installer fixture'))
  put(join(releaseDir, 'packaged-runtime.json'), JSON.stringify(nativeReport()))
  const missing = () => Object.assign(new Error('fixture file missing'), { code: 'ENOENT' })
  const io = {
    async readFile(file, encoding) {
      const entry = files.get(file)
      if (!entry) throw missing()
      return encoding ? entry.data.toString(encoding) : Buffer.from(entry.data)
    },
    async lstat(file) {
      if (file === releaseDir) return { isDirectory: () => true, isSymbolicLink: () => false }
      const entry = files.get(file)
      if (!entry) throw missing()
      return { size: entry.data.length, mtimeMs: entry.mtimeMs,
        isFile: () => !entry.directory, isDirectory: () => !!entry.directory, isSymbolicLink: () => !!entry.symlink }
    },
    async readdir(directory) { return [...files.keys()].filter(file => dirname(file) === directory).map(file => basename(file)) },
    async writeFile(file, value, options) {
      assert.equal(dirname(file), releaseDir, 'writes stay in the release artifact directory')
      assert.equal(options.flag, 'wx', 'generated files must never be overwritten')
      if (files.has(file)) throw Object.assign(new Error('fixture already exists'), { code: 'EEXIST' })
      writes.push(file)
      put(file, value)
    },
  }
  const state = { created: false, remoteSha: commit, head: commit, existing: [], annotated: false, tagReads: 0, releaseReads: 0,
    failApi: false, failCreate: false, finalAssetMutation: null, remoteAfterRead: null }
  const run = async (program, args, options) => {
    commands.push({ program, args: [...args], options })
    assert.ok(Array.isArray(args))
    assert.equal(options.shell, undefined)
    if (program === 'git') {
      assert.deepEqual(args, ['rev-parse', 'HEAD'])
      return { stdout: `${state.head}\n` }
    }
    assert.equal(program, 'gh')
    assert.equal(options.env.GH_HOST, 'github.com')
    if (args[0] === 'api') {
      assert.ok(args.includes('GET'), 'all gh api calls are read-only')
      if (state.failApi) throw new Error('unsafe fixture-token-never-export stderr')
      const endpoint = args[1]
      if (endpoint.includes('/git/ref/')) {
        state.tagReads++
        const sha = state.remoteAfterRead && state.tagReads >= state.remoteAfterRead ? otherCommit : state.remoteSha
        return { stdout: JSON.stringify({ ref: `refs/tags/${tag}`, object: state.annotated ? { type: 'tag', sha: tagObject } : { type: 'commit', sha } }) }
      }
      if (endpoint.endsWith(`/git/tags/${tagObject}`)) return { stdout: JSON.stringify({ object: { type: 'commit', sha: state.remoteSha } }) }
      assert.equal(endpoint, 'repos/example/robot/releases?per_page=100')
      assert.ok(args.includes('--paginate'))
      assert.ok(args.includes('--slurp'))
      state.releaseReads++
      const releases = [...state.existing]
      if (state.releaseAppearsAt && state.releaseReads >= state.releaseAppearsAt) releases.push({ tag_name: tag, draft: true, assets: [] })
      if (state.created) {
        let assets = state.uploads.map(file => ({ name: basename(file), size: files.get(file).data.length, state: 'uploaded' }))
        if (state.finalAssetMutation) assets = state.finalAssetMutation(assets)
        releases.push({ id: 77, tag_name: tag, draft: true, prerelease: true, target_commitish: commit,
          html_url: `https://github.com/example/robot/releases/tag/${tag}`, assets, ...state.finalReleaseFields })
      }
      // The relevant release is deliberately not on the first API page.
      return { stdout: JSON.stringify([[], releases]) }
    }
    assert.deepEqual(args.slice(0, 3), ['release', 'create', tag])
    assert.equal(state.created, false, 'only one create attempt')
    assert.equal(args.includes('--clobber'), false)
    assert.ok(args.includes('--draft'))
    assert.ok(args.includes('--prerelease'))
    assert.ok(args.includes('--verify-tag'))
    assert.ok(args.includes('--latest=false'))
    assert.equal(args[args.indexOf('--target') + 1], commit)
    assert.equal(args[args.indexOf('--repo') + 1], 'example/robot')
    state.uploads = args.slice(3, args.indexOf('--repo'))
    if (state.failCreate) throw new Error('unsafe fixture-token-never-export upload error')
    state.created = true
    return { stdout: `https://github.com/example/robot/releases/tag/${tag}\n` }
  }
  const options = { root, env: environment(), platform: 'win32', arch: 'x64', io, run,
    hashFile: async file => createHash('sha256').update(files.get(file).data).digest('hex'), log: value => logs.push(value) }
  return { root, releaseDir, installer, files, writes, commands, logs, state, options, put,
    deliver: () => deliverTestRelease(options), mutations: () => commands.filter(call => call.program === 'gh' && call.args[0] !== 'api') }
}

test('pure context guard accepts exact push and workflow-dispatch test tags', () => {
  for (const event of ['push', 'workflow_dispatch']) {
    const env = { ...environment(), GITHUB_EVENT_NAME: event }
    const result = validateReleaseContext({ env, version: '1.0.2-test.1', head: `${commit}\n`, platform: 'win32', arch: 'x64' })
    assert.equal(result.tag, tag)
    assert.equal(result.commit, commit)
    assert.equal(JSON.stringify(result).includes(env.GH_TOKEN), false)
  }
})

for (const [name, change] of [
  ['local execution', { GITHUB_ACTIONS: 'false' }],
  ['pull request', { GITHUB_EVENT_NAME: 'pull_request' }],
  ['wrong branch ref', { GITHUB_REF: 'refs/heads/main' }],
  ['different tag ref', { GITHUB_REF: 'refs/tags/v1.0.1-test.2' }],
  ['stable release tag', { RELEASE_TAG: 'v1.0.1', GITHUB_REF: 'refs/tags/v1.0.1' }],
  ['wrong version', { RELEASE_TAG: 'v9.0.0-test.1', GITHUB_REF: 'refs/tags/v9.0.0-test.1' }],
  ['wrong prerelease suffix', { RELEASE_TAG: 'v1.0.2-test.2', GITHUB_REF: 'refs/tags/v1.0.2-test.2' }],
  ['wrong SHA', { GITHUB_SHA: otherCommit }],
  ['missing token', { GH_TOKEN: '' }],
]) {
  test(`${name} fails before any GitHub calls or artifact writes`, async () => {
    const h = fixture()
    Object.assign(h.options.env, change)
    await assert.rejects(h.deliver())
    assert.equal(h.commands.some(command => command.program === 'gh'), false)
    assert.deepEqual(h.writes, [])
  })
}

test('only Windows x64 builds can be delivered', async () => {
  const h = fixture()
  h.options.platform = 'darwin'
  await assert.rejects(h.deliver(), /Windows x64/)
  assert.deepEqual(h.mutations(), [])
})

test('HEAD mismatch is rejected even when the workflow SHA is well formed', async () => {
  const h = fixture()
  h.state.head = otherCommit
  await assert.rejects(h.deliver(), /HEAD/)
  assert.deepEqual(h.mutations(), [])
})

test('native report requires all named passed checks and only exports allowed metadata', () => {
  const report = nativeReport()
  const validated = validateNativeReport(report)
  assert.equal(JSON.stringify(validated).includes('privateDetail'), false)
  report.checks[0].status = 'failed'
  assert.throws(() => validateNativeReport(report), /did not pass/)
})

test('failed or incomplete native verification prevents release creation', async () => {
  for (const mutate of [report => { report.status = 'failed' }, report => { report.checks.pop() }]) {
    const h = fixture(), report = nativeReport()
    mutate(report)
    h.put(join(h.releaseDir, 'packaged-runtime.json'), JSON.stringify(report))
    await assert.rejects(h.deliver(), /report/)
    assert.deepEqual(h.mutations(), [])
    assert.deepEqual(h.writes, [])
  }
})

for (const [scenario, expected] of [['missing', /Exactly one/], ['multiple', /Exactly one/], ['empty', /Invalid or empty/], ['symlink', /Invalid or empty/], ['label-injection', /Unsafe/]]) {
  test(`${scenario} installer cannot be delivered`, async () => {
    const h = fixture(), file = join(h.releaseDir, h.installer)
    if (scenario === 'missing') h.files.delete(file)
    if (scenario === 'multiple') h.put(join(h.releaseDir, 'another.exe'), 'fixture')
    if (scenario === 'empty') h.put(file, '')
    if (scenario === 'symlink') h.files.get(file).symlink = true
    if (scenario === 'label-injection') { h.files.delete(file); h.put(join(h.releaseDir, 'installer#label.exe'), 'fixture') }
    await assert.rejects(h.deliver(), expected)
    assert.deepEqual(h.mutations(), [])
    assert.deepEqual(h.writes, [])
  })
}

test('remote tag commit mismatch fails without creating or moving any tag', async () => {
  const h = fixture()
  h.state.remoteSha = otherCommit
  await assert.rejects(h.deliver(), /Remote test tag/)
  assert.deepEqual(h.mutations(), [])
  assert.deepEqual(h.writes, [])
})

for (const draft of [true, false]) {
  test(`existing ${draft ? 'draft' : 'published'} release is never reused or overwritten`, async () => {
    const h = fixture()
    h.state.existing = [{ tag_name: tag, draft, assets: [{ name: h.installer, size: 1 }] }]
    await assert.rejects(h.deliver(), /already exists/)
    assert.deepEqual(h.mutations(), [])
    assert.deepEqual(h.writes, [])
  })
}

test('generated manifest/checksum files are never overwritten', async () => {
  for (const name of ['build-info.json', 'SHA256SUMS.txt']) {
    const h = fixture()
    h.put(join(h.releaseDir, name), 'operator-owned existing file')
    await assert.rejects(h.deliver(), /overwrite/)
    assert.equal(h.files.get(join(h.releaseDir, name)).data.toString(), 'operator-owned existing file')
    assert.deepEqual(h.writes, [])
    assert.deepEqual(h.mutations(), [])
  }
})

test('annotated reviewed tag creates one draft with all four verified assets and no secret manifest fields', async () => {
  const h = fixture()
  h.state.annotated = true
  const result = await h.deliver()
  assert.equal(h.mutations().length, 1)
  assert.deepEqual(h.state.uploads.map(file => basename(file)).sort(), [h.installer, 'SHA256SUMS.txt', 'build-info.json', 'packaged-runtime.json'].sort())
  const manifest = JSON.parse(h.files.get(join(h.releaseDir, 'build-info.json')).data)
  assert.equal(manifest.version, '1.0.2-test.1')
  assert.equal(manifest.commit, commit)
  assert.equal(manifest.tag, tag)
  assert.equal(manifest.workflow.runId, '123')
  assert.deepEqual(manifest.platform, { os: 'win32', arch: 'x64' })
  assert.equal(manifest.artifacts.length, 2)
  assert.equal(JSON.stringify(manifest).includes('fixture-token-never-export'), false)
  assert.equal(JSON.stringify(manifest).includes('not-for-build-info'), false)
  const sums = h.files.get(join(h.releaseDir, 'SHA256SUMS.txt')).data.toString()
  for (const name of [h.installer, 'packaged-runtime.json', 'build-info.json']) {
    const hash = createHash('sha256').update(h.files.get(join(h.releaseDir, name)).data).digest('hex')
    assert.ok(sums.includes(`${hash}  ${name}\n`))
  }
  assert.deepEqual(h.logs, [result.url])
  assert.equal(h.state.tagReads, 3)
})

test('tag moving between validation and upload fails before any GitHub writes', async () => {
  const h = fixture()
  h.state.remoteAfterRead = 2
  await assert.rejects(h.deliver(), /Remote test tag/)
  assert.deepEqual(h.mutations(), [])
})

test('draft appearing after the initial check prevents the creation attempt', async () => {
  const h = fixture()
  h.state.releaseAppearsAt = 2
  await assert.rejects(h.deliver(), /already exists/)
  assert.deepEqual(h.mutations(), [])
})

test('malformed release entries are not treated as proof the tag is unused', async () => {
  const h = fixture()
  h.state.existing = [{}]
  await assert.rejects(h.deliver(), /Invalid release entries/)
  assert.deepEqual(h.mutations(), [])
  assert.deepEqual(h.writes, [])
})

test('network failure is not interpreted as an unused tag or retried mutation', async () => {
  const h = fixture()
  h.state.failApi = true
  await assert.rejects(h.deliver(), error => /no further release/.test(error.message) && !error.message.includes(h.options.env.GH_TOKEN))
  assert.deepEqual(h.mutations(), [])
  assert.deepEqual(h.writes, [])
})

test('uncertain creation/upload failure does not retry, delete a draft or clobber assets', async () => {
  const h = fixture()
  h.state.failCreate = true
  await assert.rejects(h.deliver(), /no further release/)
  assert.equal(h.mutations().length, 1)
  assert.deepEqual(h.mutations()[0].args.slice(0, 3), ['release', 'create', tag])
  assert.deepEqual(h.logs, [])
})

for (const [name, mutate] of [
  ['missing asset', assets => assets.slice(1)],
  ['duplicate name collision', assets => [assets[0], assets[0], ...assets.slice(2)]],
  ['incorrect size', assets => assets.map((asset, index) => index ? asset : { ...asset, size: asset.size + 1 })],
  ['incomplete upload', assets => assets.map((asset, index) => index ? asset : { ...asset, state: 'starter' })],
]) {
  test(`${name} fails final verification without any repair/overwrite action`, async () => {
    const h = fixture()
    h.state.finalAssetMutation = mutate
    await assert.rejects(h.deliver(), /asset/)
    assert.equal(h.mutations().length, 1)
    assert.deepEqual(h.logs, [])
  })
}

test('a release that is no longer draft is never reported as successfully delivered', async () => {
  const h = fixture()
  h.state.finalReleaseFields = { draft: false }
  await assert.rejects(h.deliver(), /expected draft/)
  assert.equal(h.mutations().length, 1)
  assert.deepEqual(h.logs, [])
})
