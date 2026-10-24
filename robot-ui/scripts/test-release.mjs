import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const defaultRoot = fileURLToPath(new URL('../../', import.meta.url))
const SHA = /^[0-9a-f]{40}$/
const TEST_TAG = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-test\.(?:0|[1-9]\d*)$/
const NATIVE_CHECKS = ['runtime', 'packaged-layout', 'audio-send-cadence', 'ffmpeg-pcm', 'ffplay', 'windows-pause-resume', 'sharp', 'onnx-models', 'ocr-pipeline', 'packaged-native-bindings']
const fail = message => { throw new Error(message) }

/** Pure guard: neither a branch build nor a local shell can publish a release. */
export function validateReleaseContext({ env, version, head, platform, arch }) {
  if (env.GITHUB_ACTIONS !== 'true') fail('Release delivery is restricted to GitHub Actions.')
  if (!['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)) fail('This workflow event cannot deliver a release.')
  const tag = env.RELEASE_TAG || ''
  const match = TEST_TAG.exec(tag)
  if (!match) fail('RELEASE_TAG must be an exact vX.Y.Z-test.N tag.')
  if (env.GITHUB_REF !== `refs/tags/${tag}`) fail('The workflow ref must be the exact requested test tag.')
  if (tag.slice(1) !== version) fail('The full test tag version does not match robot-ui/package.json.')
  if (!SHA.test(env.GITHUB_SHA || '') || head?.trim() !== env.GITHUB_SHA) fail('Checked-out HEAD does not match GITHUB_SHA.')
  if (platform !== 'win32' || arch !== 'x64') fail('Only the verified Windows x64 build can be delivered.')
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY || '')) fail('Invalid GitHub repository context.')
  if (env.GITHUB_SERVER_URL !== 'https://github.com') fail('Only github.com release delivery is configured.')
  if (!/^\d+$/.test(env.GITHUB_RUN_ID || '') || !/^[1-9]\d*$/.test(env.GITHUB_RUN_ATTEMPT || '')) fail('Missing workflow run identity.')
  if (!env.GH_TOKEN) fail('GH_TOKEN is required for release verification.')
  return {
    tag, version, commit: env.GITHUB_SHA, repository: env.GITHUB_REPOSITORY,
    platform, arch, event: env.GITHUB_EVENT_NAME,
    runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT,
    runUrl: `https://github.com/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
  }
}

/** The manifest includes only fixed check names/statuses and runtime versions. */
export function validateNativeReport(report) {
  if (report?.schemaVersion !== 1 || report.status !== 'passed') fail('The packaged runtime report has not passed.')
  if (report.runtime?.platform !== 'win32' || report.runtime?.arch !== 'x64') fail('Native report is not for Windows x64.')
  if (!Array.isArray(report.checks) || report.checks.length !== NATIVE_CHECKS.length) fail('Native report is missing required checks.')
  const runtime = {}
  for (const key of ['platform', 'arch', 'node', 'electron', 'modules', 'napi']) {
    const value = report.runtime[key]
    if (!['string', 'number'].includes(typeof value) || !/^[A-Za-z0-9.+_-]{1,80}$/.test(String(value))) fail('Invalid native runtime version fields.')
    runtime[key] = value
  }
  const checks = NATIVE_CHECKS.map(name => {
    const matches = report.checks.filter(check => check?.name === name)
    const check = matches[0]
    if (matches.length !== 1 || check.status !== 'passed' || !Number.isFinite(check.durationMs) || check.durationMs < 0) fail(`Native check did not pass: ${name}.`)
    return { name, status: 'passed', durationMs: check.durationMs }
  })
  return { status: 'passed', runtime, checks }
}

async function hashRealFile(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

function parseJson(raw, label) {
  try { return JSON.parse(raw) } catch { fail(`Invalid JSON from ${label}; release delivery stopped.`) }
}

/** Injected IO/command runner makes every safety branch testable without GitHub. */
export async function deliverTestRelease({
  root = defaultRoot, env = process.env, platform = process.platform, arch = process.arch,
  io = fs, run = exec, hashFile = hashRealFile, log = console.log,
  sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms)),
  temporaryRoot = tmpdir(),
} = {}) {
  root = resolve(root)
  const commandEnv = { ...env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GH_DEBUG: '', GH_TRACE: '' }
  const call = async (program, args) => {
    try {
      const result = await run(program, args, { cwd: root, env: commandEnv, windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 180000 })
      return typeof result === 'string' ? result : result.stdout
    } catch {
      // Never print command stderr/environment: authentication failures can
      // contain sensitive data. Do not retry writes or delete partial drafts.
      fail(`${program} ${args[0]} failed; no further release actions will be attempted.`)
    }
  }
  const pkg = parseJson(await io.readFile(join(root, 'robot-ui/package.json'), 'utf8'), 'UI package')
  const head = await call('git', ['rev-parse', 'HEAD'])
  const context = validateReleaseContext({ env, version: pkg.version, head, platform, arch })
  const endpoint = `repos/${context.repository}`
  const api = async (path, options = []) => parseJson(await call('gh', [
    'api', path, '--hostname', 'github.com', '--method', 'GET', ...options,
  ]), 'GitHub')
  const assertRemoteTag = async () => {
    const reference = await api(`${endpoint}/git/ref/tags/${context.tag}`)
    if (reference?.ref !== `refs/tags/${context.tag}`) fail('GitHub did not return the exact requested tag.')
    let object = reference.object
    const seen = new Set()
    while (object?.type === 'tag') {
      if (!SHA.test(object.sha || '') || seen.has(object.sha) || seen.size >= 16) fail('Invalid annotated tag chain.')
      seen.add(object.sha)
      object = (await api(`${endpoint}/git/tags/${object.sha}`)).object
    }
    if (object?.type !== 'commit' || object.sha !== context.commit) fail('Remote test tag does not resolve to the reviewed commit.')
  }
  const releasesForTag = async () => {
    // Listing all authenticated releases includes drafts; a tag-only lookup is
    // not sufficient to prove that a tag has never been used for a draft.
    const pages = await api(`${endpoint}/releases?per_page=100`, ['--paginate', '--slurp'])
    if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page))) fail('Invalid release listing; refusing to assume the tag is unused.')
    const releases = pages.flat()
    if (releases.some(release => !release || typeof release.tag_name !== 'string' || typeof release.draft !== 'boolean')) fail('Invalid release entries; refusing to assume the tag is unused.')
    return releases.filter(release => release.tag_name === context.tag)
  }
  const assertUnused = async () => {
    if ((await releasesForTag()).length) fail('A draft or published release already exists for this tag; nothing will be overwritten.')
  }

  const directory = join(root, 'release')
  const directoryInfo = await io.lstat(directory)
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) fail('Release artifacts must be in the real project release directory.')
  const names = await io.readdir(directory)
  const installers = names.filter(name => /\.exe$/i.test(name))
  if (installers.length !== 1) fail('Exactly one Windows installer .exe is required.')
  const installer = installers[0]
  // GitHub normalizes Unicode and whitespace in release asset names. Require
  // the on-disk installer name to already be stable so manifests, checksums,
  // API metadata and authenticated downloads all refer to the same filename.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.exe$/i.test(installer) || installer !== basename(installer)) {
    fail('Installer asset name must be GitHub-stable ASCII.')
  }
  const artifact = async name => {
    const file = join(directory, name)
    const before = await io.lstat(file)
    if (!before.isFile() || before.isSymbolicLink() || !Number.isSafeInteger(before.size) || before.size <= 0) fail(`Invalid or empty release artifact: ${name}.`)
    const sha256 = await hashFile(file)
    const after = await io.lstat(file)
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || !/^[0-9a-f]{64}$/.test(sha256)) fail(`Release artifact changed while hashing: ${name}.`)
    return { name, bytes: before.size, sha256 }
  }
  const reportPath = join(directory, 'packaged-runtime.json')
  const reportInfo = await io.lstat(reportPath)
  if (!reportInfo.isFile() || reportInfo.isSymbolicLink() || reportInfo.size > 1024 * 1024) fail('Invalid packaged runtime report file.')
  const nativeChecks = validateNativeReport(parseJson(await io.readFile(reportPath, 'utf8'), 'packaged runtime report'))
  const notesFile = join(root, 'docs/windows-test-installer.md')
  const notesInfo = await io.lstat(notesFile)
  if (!notesInfo.isFile() || notesInfo.isSymbolicLink() || notesInfo.size <= 0) fail('Reviewed Windows test release notes are missing.')
  const inputs = [await artifact(installer), await artifact('packaged-runtime.json')]
  for (const name of ['build-info.json', 'SHA256SUMS.txt']) {
    try { await io.lstat(join(directory, name)) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
    fail(`Refusing to overwrite existing generated artifact: ${name}.`)
  }
  await assertRemoteTag()
  await assertUnused()

  const manifest = {
    schemaVersion: 1, version: context.version, commit: context.commit, tag: context.tag,
    workflow: { repository: context.repository, runId: context.runId, runAttempt: context.runAttempt, event: context.event, url: context.runUrl },
    platform: { os: context.platform, arch: context.arch }, artifacts: inputs, nativeChecks,
  }
  // Exclusive creation makes local retries fail closed too. Checksums cover the
  // installer, raw synthetic native report and manifest, not themselves.
  await io.writeFile(join(directory, 'build-info.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  const manifestArtifact = await artifact('build-info.json')
  const checksummed = [...inputs, manifestArtifact]
  await io.writeFile(join(directory, 'SHA256SUMS.txt'), checksummed.map(item => `${item.sha256}  ${item.name}\n`).join(''), { flag: 'wx', mode: 0o600 })
  const artifacts = [...checksummed, await artifact('SHA256SUMS.txt')]
  for (const expected of artifacts) {
    const current = await artifact(expected.name)
    if (current.sha256 !== expected.sha256 || current.bytes !== expected.bytes) fail('Release artifacts changed before delivery.')
  }
  // Recheck immediately before the only mutating command. The CLI creates the
  // draft and uploads to THAT new release; never upload by tag to an old draft.
  await assertRemoteTag()
  await assertUnused()
  await call('gh', ['release', 'create', context.tag, ...artifacts.map(item => join(directory, item.name)),
    '--repo', context.repository, '--draft', '--prerelease', '--latest=false', '--verify-tag',
    '--target', context.commit, '--title', context.tag, '--notes-file', notesFile])

  // Release assets are eventually consistent after a large upload. Poll only
  // with read-only API calls; never repeat `gh release create`, delete a draft,
  // or overwrite an asset after an uncertain result.
  const verificationDelays = [1000, 2000, 4000, 8000, 8000, 8000]
  let release = null
  let assetMismatch = false
  for (let attempt = 0; attempt <= verificationDelays.length; attempt++) {
    const releases = await releasesForTag()
    if (releases.length > 1) fail('Could not uniquely verify the newly created draft; manual review required.')
    release = releases[0] || null
    if (release) {
      if (release.draft !== true || release.prerelease !== true || release.tag_name !== context.tag || release.target_commitish !== context.commit) {
        fail('Created release is not the expected draft prerelease; manual review required.')
      }
      assetMismatch = !Array.isArray(release.assets) || release.assets.length !== artifacts.length || artifacts.some(expected => {
        const matching = release.assets?.filter(asset => asset.name === expected.name) || []
        return matching.length !== 1 || matching[0].size !== expected.bytes || matching[0].state !== 'uploaded'
      })
      if (!assetMismatch) break
    }
    if (attempt < verificationDelays.length) await sleep(verificationDelays[attempt])
  }
  if (!release) fail('Could not uniquely verify the newly created draft; manual review required.')
  if (assetMismatch) fail('Draft asset name/size/upload mismatch; manual review required.')

  // Metadata alone did not catch the transient asset state that made the first
  // test delivery look red after a successful upload. Download this exact tag
  // once, into a fresh app-owned directory, and verify the bytes independently.
  // This is deliberately after metadata settles and never retries or changes
  // the draft. A failed verification leaves the draft for manual inspection.
  const temporaryParent = resolve(temporaryRoot)
  const temporaryPrefix = join(temporaryParent, 'robot-live-release-verify-')
  let verificationDirectory = null
  try {
    verificationDirectory = await io.mkdtemp(temporaryPrefix)
    const resolvedVerificationDirectory = resolve(verificationDirectory)
    if (dirname(resolvedVerificationDirectory) !== temporaryParent ||
        !basename(resolvedVerificationDirectory).startsWith('robot-live-release-verify-')) {
      fail('Unsafe release verification directory; download stopped.')
    }
    const directoryState = await io.lstat(resolvedVerificationDirectory)
    if (!directoryState.isDirectory() || directoryState.isSymbolicLink() || (await io.readdir(resolvedVerificationDirectory)).length) {
      fail('Release verification directory is not a fresh real directory.')
    }
    verificationDirectory = resolvedVerificationDirectory
    await call('gh', ['release', 'download', context.tag, '--repo', context.repository, '--dir', verificationDirectory])

    const downloadedNames = (await io.readdir(verificationDirectory)).sort()
    const expectedNames = artifacts.map(item => item.name).sort()
    if (JSON.stringify(downloadedNames) !== JSON.stringify(expectedNames)) {
      fail('Downloaded draft asset names do not exactly match the reviewed release.')
    }
    for (const expected of artifacts) {
      const file = join(verificationDirectory, expected.name)
      const before = await io.lstat(file)
      if (!before.isFile() || before.isSymbolicLink() || before.size !== expected.bytes) {
        fail(`Downloaded draft asset size/type mismatch: ${expected.name}.`)
      }
      const sha256 = await hashFile(file)
      const after = await io.lstat(file)
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || sha256 !== expected.sha256) {
        fail(`Downloaded draft asset checksum mismatch: ${expected.name}.`)
      }
    }
    const downloadedSums = await io.readFile(join(verificationDirectory, 'SHA256SUMS.txt'), 'utf8')
    const expectedSums = checksummed.map(item => `${item.sha256}  ${item.name}\n`).join('')
    if (downloadedSums !== expectedSums) fail('Downloaded SHA256SUMS.txt does not match the reviewed artifacts.')
  } finally {
    if (verificationDirectory) {
      const candidate = resolve(verificationDirectory)
      if (dirname(candidate) === temporaryParent && basename(candidate).startsWith('robot-live-release-verify-')) {
        await io.rm(candidate, { recursive: true, force: true })
      }
    }
  }

  await assertRemoteTag()
  const url = new URL(release.html_url)
  if (url.origin !== 'https://github.com' || !url.pathname.startsWith(`/${context.repository}/releases/`) || url.username || url.password || url.search || url.hash) fail('Unexpected draft release URL.')
  log(url.href)
  return { url: url.href, artifacts, manifest }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  deliverTestRelease().catch(error => {
    console.error(`[test-release] ${error.message}`)
    process.exitCode = 1
  })
}
