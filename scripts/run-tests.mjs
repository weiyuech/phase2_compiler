#!/usr/bin/env node
// Enumerate files explicitly: shell wildcard expansion differs on Windows.
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url))
const SUITES = {
  backend: [['test', '.test.js']],
  ui: [['robot-ui/test', '.test.mjs']],
  all: [['test', '.test.js'], ['robot-ui/test', '.test.mjs']],
}

export function listTests(suite, root = PROJECT_ROOT) {
  if (!Object.hasOwn(SUITES, suite)) throw new Error('Choose backend, ui or all')
  return SUITES[suite].flatMap(([directory, suffix]) => {
    const files = readdirSync(resolve(root, directory), { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith(suffix))
      .map(entry => resolve(root, directory, entry.name))
      .sort()
    if (!files.length) throw new Error('No tests found in ' + directory)
    return files
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const files = listTests(process.argv[2])
    const result = spawnSync(process.execPath,
      ['--test', '--test-concurrency=4', ...process.argv.slice(3), ...files],
      { cwd: PROJECT_ROOT, stdio: 'inherit' })
    if (result.error) throw result.error
    process.exitCode = result.status ?? 1
  } catch (error) {
    console.error('[tests] ' + error.message)
    process.exitCode = 1
  }
}
