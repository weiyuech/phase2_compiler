import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, posix, win32 } from 'node:path'
import { runInNewContext } from 'node:vm'
import { archiveEntryNames, verifyPackagedPrivacy } from '../scripts/verify-packaged-privacy.mjs'

const require = createRequire(import.meta.url)
const asar = require('@electron/asar')
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)))

test('ASAR native read paths work with both Windows and POSIX dependency semantics', () => {
  // Exercise the installed dependency, not a fake parser. Injecting only path
  // lets a Mac/Linux test reproduce the actual Windows directory lookup bug.
  const modulePath = require.resolve('@electron/asar/lib/filesystem.js')
  const moduleRequire = createRequire(modulePath)
  for (const paths of [posix, win32]) {
    const exports = {}
    runInNewContext(readFileSync(modulePath, 'utf8'), {
      exports,
      require: name => name === 'path' ? paths : moduleRequire(name),
    })
    const filesystem = new exports.Filesystem('.')
    const file = { size: 42, offset: '0' }
    filesystem.setHeader({ files: { out: { files: { main: { files: { 'index.js': file } } } } } }, 0)
    const entries = filesystem.listFiles().map(archiveEntryNames)
    const entry = entries.find(item => item.name === 'out/main/index.js')
    assert.ok(entry, 'portable checks must find nested content on either platform')
    assert.equal(filesystem.getFile(entry.nativeName, false), file)
    if (paths === win32) {
      assert.equal(entry.nativeName, 'out\\main\\index.js')
      assert.throws(() => filesystem.getFile(entry.name, false), /not found/,
        'a slash-only read must reproduce the Windows CI failure')
    }
  }
})

async function fixture(t, { app = {}, resources = {}, metadata = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'robot-package-privacy-'))
  t.after(() => { asar.uncacheAll(); rmSync(root, { recursive: true, force: true }) })
  const appRoot = join(root, 'app'), resourcesRoot = join(root, 'resources')
  const put = (directory, name, content) => {
    const path = join(directory, name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
  for (const [name, content] of Object.entries({
    'package.json': JSON.stringify({ name: manifest.name, version: manifest.version, author: manifest.author, ...metadata }),
    'out/main/index.js': 'console.log("app")',
    'out/preload/index.js': 'console.log("preload")',
    'out/renderer/index.html': '<html></html>',
    ...app,
  })) put(appRoot, name, content)
  for (const [name, content] of Object.entries({
    'backend/package.json': '{"name":"robot-live-system"}',
    'backend/src/index.js': 'console.log("backend")',
    ...resources,
  })) put(resourcesRoot, name, content)
  await asar.createPackage(appRoot, join(resourcesRoot, 'app.asar'))
  return resourcesRoot
}

test('checks a real asar and backend while preserving third-party attribution and source maps', async t => {
  const resourcesRoot = await fixture(t, {
    app: { 'node_modules/vendor/LICENSE.txt': 'Codex attribution; github.com/weiyuech/vendor', 'node_modules/vendor/index.js.map': '{}' },
    resources: {
      'backend/node_modules/vendor/LICENSE': 'Codex attribution',
      'backend/node_modules/vendor/index.js.map': '{}',
      'backend/src/index.js': '// Rejected example: /Users/xxx/Documents',
    },
  })
  const result = verifyPackagedPrivacy({ resourcesRoot })
  assert.deepEqual(result, { status: 'passed', version: manifest.version, appFiles: 4, backendFiles: 2 })
})

test('rejects repository and personal author fields in the actual packed app manifest', async t => {
  for (const metadata of [{ repository: 'https://github.com/private/source' }, { author: 'weiyuech' }]) {
    const resourcesRoot = await fixture(t, { metadata })
    assert.throws(() => verifyPackagedPrivacy({ resourcesRoot }), /repository metadata|neutral product author/)
  }
})

test('rejects inferred updater metadata, including neutral-looking providers', async t => {
  for (const name of ['app-update.yml', 'app-update.yaml', 'dev-app-update.yml']) {
    const resourcesRoot = await fixture(t, { resources: { [name]: 'provider: github\nowner: private\nrepo: source' } })
    assert.throws(() => verifyPackagedPrivacy({ resourcesRoot }), /Updater metadata/)
  }
})

test('rejects private identity and source maps in compiled main/renderer and backend files', async t => {
  const cases = [
    [{ app: { 'out/main/index.js': 'const source = "https://github.com/weiyuech/phase2_compiler"' } }, /Private identity/],
    [{ app: { 'out/renderer/assets/app.js': '/* Generated with Codex */' } }, /Private identity/],
    [{ app: { 'out/renderer/assets/app.js.map': '{}' } }, /source map/],
    [{ app: { 'out/main/index.js': '//# sourceMappingURL=data:application/json;base64,e30=' } }, /source map reference/],
    [{ resources: { 'backend/src/index.js': 'const path = "/Users/builder/project"' } }, /Personal build path/],
    [{ resources: { 'backend/src/index.js': 'const path = "C:\\\\Users\\\\builder\\\\project"' } }, /Personal build path/],
    [{ resources: { 'backend/src/index.js': '/* phase2_compiler */' } }, /Private identity/],
    [{ resources: { 'backend/src/index.js.map': '{}' } }, /source map/],
    [{ resources: { 'build-info.json': '{"repository":"weiyuech/phase2_compiler"}' } }, /Private identity/],
    [{ resources: { 'app.asar.unpacked/out/main/index.js': '/* Codex */' } }, /Private identity/],
  ]
  for (const [options, expected] of cases) {
    const resourcesRoot = await fixture(t, options)
    assert.throws(() => verifyPackagedPrivacy({ resourcesRoot }), expected)
  }
})

test('requires actual first-party content and the current release version', async t => {
  const resourcesRoot = await fixture(t, { metadata: { version: '0.0.0' } })
  assert.throws(() => verifyPackagedPrivacy({ resourcesRoot }), /requested release/)
  assert.throws(() => verifyPackagedPrivacy({ resourcesRoot: join(resourcesRoot, 'missing') }), /directory is missing/)
})
