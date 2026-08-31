import {
  closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  openSync, readFileSync, readdirSync, readSync, realpathSync, renameSync, rmSync, writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SEED_BLANK_ENV_KEYS, SEED_CONFIG_FILES, SEED_DATA_FILES, SEED_EMPTY_DIRECTORIES, SEED_MODEL_FILES,
} from '../../src/packaging/seed-manifest.js'

const SCRIPT_ROOT = dirname(fileURLToPath(import.meta.url))
const DEFAULT_PROJECT_ROOT = resolve(SCRIPT_ROOT, '../..')
const DEFAULT_TEMPLATES = resolve(SCRIPT_ROOT, '../packaging/defaults')
const OWNER_FILE = '.robot-live-package-seed.json'
const OWNER_CONTENT = JSON.stringify({ owner: 'robot-live-package-seed', schema: 1 }) + '\n'
const PACKAGED_ROOT_ENTRIES = new Set(['src', 'node_modules', 'config', 'data', '.env.example', 'package.json', 'ffplay.exe'])

function regularFile(file) {
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Seed input must be a regular file')
  return stat
}

function regularDirectory(file) {
  const stat = lstatSync(file)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Seed directory must not be a link')
}

function fileHash(file) {
  regularFile(file)
  const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(64 * 1024)
  const descriptor = openSync(file, 'r')
  try {
    for (;;) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null)
      if (!count) break
      hash.update(buffer.subarray(0, count))
    }
    return hash.digest('hex')
  } finally { closeSync(descriptor) }
}

function listFiles(root, allowedDirectories) {
  regularDirectory(root)
  const files = []
  function walk(directory) {
    for (const name of readdirSync(directory).sort()) {
      const file = join(directory, name), stat = lstatSync(file)
      if (stat.isSymbolicLink()) throw new Error('Links are not allowed in packaged seeds')
      if (stat.isDirectory()) {
        const name = relative(root, file).split(sep).join('/')
        if (allowedDirectories && !allowedDirectories.has(name)) throw new Error('Packaged seed directory allowlist mismatch')
        walk(file)
      }
      else if (stat.isFile()) files.push(relative(root, file).split(sep).join('/'))
      else throw new Error('Special files are not allowed in packaged seeds')
    }
  }
  walk(root)
  return files.sort()
}

function assertFiles(root, expected, emptyDirectories = []) {
  const directories = new Set()
  for (const entry of [...expected, ...emptyDirectories.map(file => `${file}/_`)]) {
    const parts = entry.split('/')
    parts.pop()
    while (parts.length) { directories.add(parts.join('/')); parts.pop() }
  }
  if (JSON.stringify(listFiles(root, directories)) !== JSON.stringify([...expected].sort())) throw new Error('Packaged seed file allowlist mismatch')
}

function readTemplate(file) {
  regularFile(file)
  return readFileSync(file, 'utf8')
}

function validateEnvironment(content) {
  const env = new Map()
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line)
    if (!match || env.has(match[1])) throw new Error('Invalid clean environment template')
    env.set(match[1], match[2].trim())
  }
  for (const key of SEED_BLANK_ENV_KEYS) {
    if (!env.has(key) || env.get(key) !== '') throw new Error('Release credentials and robot endpoint must be blank')
  }
  for (const [key, value] of env) {
    if (/(?:KEY|TOKEN|SECRET|PASSWORD|APP_ID)$/.test(key) && value) throw new Error('Release template contains a nonempty credential')
    if (/^(?:[A-Z]:[\\/]|\/Users\/)|wss?:\/\//i.test(value)) throw new Error('Release template contains a machine-specific destination')
  }
}

/** Inspect final resources/backend without writing. Compare exact seed content,
 * filenames and model hashes, not merely the existence of model directories. */
export function verifyPackageSeed({ backendRoot, projectRoot = DEFAULT_PROJECT_ROOT,
  templatesRoot = DEFAULT_TEMPLATES, staged = false }) {
  const root = resolve(backendRoot)
  regularDirectory(root)
  for (const name of readdirSync(root)) {
    if (!PACKAGED_ROOT_ENTRIES.has(name) && !(staged && name === OWNER_FILE)) throw new Error('Unexpected packaged backend resource')
  }
  assertFiles(join(root, 'config'), SEED_CONFIG_FILES)
  for (const file of SEED_CONFIG_FILES) {
    if (readTemplate(join(root, 'config', file)) !== readTemplate(join(templatesRoot, 'config', file))) throw new Error('Packaged prompt differs from reviewed default')
  }
  const dataFiles = [...Object.keys(SEED_DATA_FILES), ...SEED_MODEL_FILES.map(file => `models/${file}`)]
  assertFiles(join(root, 'data'), dataFiles, SEED_EMPTY_DIRECTORIES)
  for (const [file, content] of Object.entries(SEED_DATA_FILES)) {
    if (readTemplate(join(root, 'data', file)) !== content) throw new Error('Packaged first-install setting is not clean')
  }
  for (const file of SEED_MODEL_FILES) {
    if (fileHash(join(root, 'data/models', file)) !== fileHash(join(projectRoot, 'data/models', file))) throw new Error('Packaged OCR resource differs from the source model')
  }
  const environment = readTemplate(join(root, '.env.example'))
  validateEnvironment(environment)
  if (environment !== readTemplate(join(templatesRoot, 'backend.env.example'))) throw new Error('Packaged environment differs from reviewed default')
  return { configFiles: SEED_CONFIG_FILES.length, dataFiles: dataFiles.length, modelFiles: SEED_MODEL_FILES.length }
}

/** Build into a dedicated, marked, disposable directory. Only the three known
 * OCR assets are read from live data/; live config/.env/content are never read. */
export function preparePackageSeed({ projectRoot = DEFAULT_PROJECT_ROOT, templatesRoot = DEFAULT_TEMPLATES } = {}) {
  const root = realpathSync(projectRoot)
  const uiRoot = join(root, 'robot-ui')
  regularDirectory(uiRoot)
  const resourceRoot = join(uiRoot, 'resources')
  if (existsSync(resourceRoot)) regularDirectory(resourceRoot)
  else mkdirSync(resourceRoot)
  const destination = join(resourceRoot, 'backend-seed')
  if (existsSync(destination)) {
    regularDirectory(destination)
    if (!existsSync(join(destination, OWNER_FILE)) || readTemplate(join(destination, OWNER_FILE)) !== OWNER_CONTENT) {
      throw new Error('Refusing to replace an unowned package seed directory')
    }
  }

  const temporary = mkdtempSync(join(resourceRoot, '.backend-seed-build-'))
  try {
    const environment = readTemplate(join(templatesRoot, 'backend.env.example'))
    validateEnvironment(environment)
    writeFileSync(join(temporary, OWNER_FILE), OWNER_CONTENT)
    mkdirSync(join(temporary, 'config'))
    for (const file of SEED_CONFIG_FILES) {
      writeFileSync(join(temporary, 'config', file), readTemplate(join(templatesRoot, 'config', file)))
    }
    for (const [file, content] of Object.entries(SEED_DATA_FILES)) {
      const target = join(temporary, 'data', file)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, content)
    }
    for (const file of SEED_EMPTY_DIRECTORIES) mkdirSync(join(temporary, 'data', file), { recursive: true })
    mkdirSync(join(temporary, 'data/models'))
    regularDirectory(join(root, 'data/models'))
    for (const file of SEED_MODEL_FILES) {
      const source = join(root, 'data/models', file)
      regularFile(source)
      copyFileSync(source, join(temporary, 'data/models', file))
    }
    writeFileSync(join(temporary, '.env.example'), environment)
    verifyPackageSeed({ backendRoot: temporary, projectRoot: root, templatesRoot, staged: true })
    // No broad source directory is a deletion target. This exact generated stage
    // was either absent or proved app-owned above; user data lives elsewhere.
    if (existsSync(destination)) rmSync(destination, { recursive: true })
    renameSync(temporary, destination)
    return destination
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true })
    throw error
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === '--verify' && process.argv.length === 4) {
      const result = verifyPackageSeed({ backendRoot: process.argv[3] })
      console.log('[package-seed] packaged allowlist and clean defaults verified', result)
    } else if (process.argv.length === 2) {
      console.log('[package-seed] prepared', preparePackageSeed())
    } else throw new Error('Usage: node prepare-package-seed.mjs [--verify <resources/backend>]')
  } catch (error) {
    console.error('[package-seed]', error.message)
    process.exitCode = 1
  }
}
