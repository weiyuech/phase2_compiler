import { constants, copyFileSync, lstatSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { SEED_CONFIG_FILES, SEED_DATA_FILES, SEED_EMPTY_DIRECTORIES } from './seed-manifest.js'

function info(file) {
  try { return lstatSync(file) } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

function regularFile(file) {
  const stat = info(file)
  if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error('Missing or unsafe packaged default')
}

function directory(file) {
  const existing = info(file)
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error('Unsafe user-data seed directory')
    return
  }
  mkdirSync(file, { recursive: true })
}

function copyMissing(source, destination) {
  // Existing files, including symbolic links, are never followed or replaced.
  if (info(destination)) return false
  regularFile(source)
  directory(dirname(destination))
  try { copyFileSync(source, destination, constants.COPYFILE_EXCL); return true } catch (error) {
    if (error.code === 'EEXIST') return false
    throw error
  }
}

/** Seed only a new packaged installation. Existing user data is not migrated,
 * emptied or overwritten; development never seeds the Electron profile. */
export function seedPackagedUserData({ packaged, projectRoot, userDataDir }) {
  const result = { dataCreated: false, environmentCreated: false, configCreated: [] }
  if (!packaged) return result

  const dataDestination = join(userDataDir, 'data')
  if (!info(dataDestination)) {
    // Validate all inputs before creating data/, so a broken package does not
    // leave an empty directory that prevents retrying first-run setup.
    for (const file of Object.keys(SEED_DATA_FILES)) regularFile(join(projectRoot, 'data', file))
    directory(userDataDir)
    let created = false
    try { mkdirSync(dataDestination); created = true } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
    // If another instance created data/ first, its content is already user data.
    if (created) {
      for (const file of Object.keys(SEED_DATA_FILES)) {
        copyMissing(join(projectRoot, 'data', file), join(dataDestination, file))
      }
      for (const file of SEED_EMPTY_DIRECTORIES) directory(join(dataDestination, file))
      result.dataCreated = true
    }
  }

  result.environmentCreated = copyMissing(join(projectRoot, '.env.example'), join(userDataDir, '.env'))
  for (const file of SEED_CONFIG_FILES) {
    if (copyMissing(join(projectRoot, 'config', file), join(userDataDir, 'config', file))) result.configCreated.push(file)
  }
  return result
}
