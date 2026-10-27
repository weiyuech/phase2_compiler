import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { SEED_MODEL_FILES } from '../src/packaging/seed-manifest.js'

// Both the active and rotated robot history/incident files contain customer
// runtime evidence. Exercise all four names at every package-copy boundary.
export const PRIVATE_ROBOT_DIAGNOSTIC_FILES = Object.freeze([
  'data/robot-diagnostics.log', 'data/robot-diagnostics.log.1',
  'data/robot-incidents.log', 'data/robot-incidents.log.1',
])

export function fixture(t) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'robot-package-seed-test-'))
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }))
  mkdirSync(join(projectRoot, 'robot-ui'), { recursive: true })
  for (const file of SEED_MODEL_FILES) put(projectRoot, `data/models/${file}`, `fixture-model:${file}`)
  return projectRoot
}

export function put(root, file, content) {
  const target = join(root, file)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
  return target
}

export function files(root) {
  const result = []
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name)
      if (entry.isDirectory()) walk(file)
      else result.push(relative(root, file).split(sep).join('/'))
    }
  }
  walk(root)
  return result.sort()
}

export function contents(root) {
  return Object.fromEntries(files(root).map(file => [file, readFileSync(join(root, file)).toString('base64')]))
}
