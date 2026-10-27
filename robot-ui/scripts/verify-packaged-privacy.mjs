#!/usr/bin/env node
// Inspect the actual packaged first-party files. Dependency licenses and their
// attribution are intentionally outside this check; clean seed checks are separate.
import assert from 'node:assert/strict'
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const asar = require('@electron/asar') // Already pinned by electron-builder.
const uiManifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)))
const privateIdentity = /weiyuech|phase2_compiler|codex/i
// safe-path.js deliberately documents /Users/xxx as an attack example. That
// fictional username is not a build origin; real named home paths still fail.
const buildHome = /(?:\/Users\/(?!xxx(?:\/|$))[^/\s"']+|[A-Za-z]:[\\/]+Users[\\/]+(?!xxx(?:[\\/]|$))[^\\/\s"']+)/i
const textFile = /\.(?:[cm]?js|json|html|css|txt|ya?ml|vue|ts)$/i
const updateFile = /^(?:dev-)?app-update\.ya?ml$/i

function inspectName(name) {
  assert.ok(!privateIdentity.test(name), `Private identity in first-party filename: ${name}`)
  assert.ok(!name.toLowerCase().endsWith('.map'), `First-party source map is packaged: ${name}`)
  assert.ok(!updateFile.test(basename(name)), `Updater metadata is packaged: ${name}`)
}

function inspectContent(name, content) {
  const text = content.toString('utf8')
  // Do not print a matched value: future failures may involve private data.
  assert.ok(!privateIdentity.test(text), `Private identity in first-party content: ${name}`)
  assert.ok(!buildHome.test(text), `Personal build path in first-party content: ${name}`)
  assert.ok(!/\bsourceMappingURL\s*=/.test(text), `First-party source map reference: ${name}`)
}

export function archiveEntryNames(listedName) {
  // ASAR's stat/extract APIs split on the host path.sep. Keep its native listing
  // for those calls; slash paths are only for portable checks and diagnostics.
  const nativeName = listedName.replace(/^[/\\]/, '')
  return { nativeName, name: nativeName.replaceAll('\\', '/') }
}

export function verifyPackagedPrivacy({ resourcesRoot } = {}) {
  assert.ok(resourcesRoot, 'resourcesRoot is required')
  const root = resolve(resourcesRoot)
  assert.ok(existsSync(root), 'Packaged resources directory is missing')
  for (const name of readdirSync(root)) {
    inspectName(name)
    const path = join(root, name)
    if (lstatSync(path).isFile() && textFile.test(name)) inspectContent(name, readFileSync(path))
  }
  const archive = join(root, 'app.asar')
  assert.ok(existsSync(archive), 'Packaged app.asar is missing')
  const entries = asar.listPackage(archive).map(archiveEntryNames)
  for (const name of ['package.json', 'out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html']) {
    assert.ok(entries.some(entry => entry.name === name), `Packaged application file is missing: ${name}`)
  }
  const manifest = JSON.parse(asar.extractFile(archive, 'package.json'))
  assert.equal(manifest.name, uiManifest.name, 'Packaged app identity changed')
  assert.equal(manifest.version, uiManifest.version, 'Packaged version is not the requested release')
  assert.ok(manifest.author === 'Robot Live System', 'Packaged author must be the neutral product author')
  assert.ok(manifest.repository === undefined, 'Source repository metadata must not be packaged')
  let appFiles = 0, backendFiles = 0
  for (const { name, nativeName } of entries) {
    if (name.split('/').includes('node_modules')) continue
    inspectName(name)
    const metadata = asar.statFile(archive, nativeName, false)
    assert.ok(!metadata.link, `First-party archive symlink is not allowed: ${name}`)
    if (metadata.files) continue
    appFiles++
    if (textFile.test(name)) inspectContent(`app.asar/${name}`, asar.extractFile(archive, nativeName))
  }
  // Include unpacked first-party output if builder moves any out of app.asar.
  function inspectTree(directory, label) {
    if (!existsSync(directory)) return
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue
      const path = join(directory, entry.name), name = `${label}/${entry.name}`
      inspectName(name)
      assert.ok(!lstatSync(path).isSymbolicLink(), `First-party filesystem symlink is not allowed: ${name}`)
      if (entry.isDirectory()) inspectTree(path, name)
      else {
        backendFiles++
        if (textFile.test(name) || entry.name === '.env.example') inspectContent(name, readFileSync(path))
      }
    }
  }
  inspectTree(join(root, 'app.asar.unpacked'), 'app.asar.unpacked')
  const backend = join(root, 'backend')
  assert.ok(existsSync(join(backend, 'package.json')), 'Packaged backend manifest is missing')
  assert.ok(existsSync(join(backend, 'src/index.js')), 'Packaged backend entry point is missing')
  inspectTree(backend, 'backend')
  return { status: 'passed', version: manifest.version, appFiles, backendFiles }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.equal(process.argv.length, 4, 'Usage: verify-packaged-privacy.mjs --resources-root <packaged resources>')
    assert.equal(process.argv[2], '--resources-root', '--resources-root is required')
    console.log(JSON.stringify(verifyPackagedPrivacy({ resourcesRoot: process.argv[3] })))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
