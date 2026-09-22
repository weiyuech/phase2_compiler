import { copyFileSync, constants, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { SEED_CONFIG_FILES, SEED_DATA_FILES, SEED_EMPTY_DIRECTORIES } from './seed-manifest.js'
import { seedPackagedUserData } from './seed-user-data.js'

export function machineProfile({ id, packaged, projectRoot, userDataDir }) {
  if (![1, 2, 3].includes(id)) throw new Error('Unknown machine')
  // Machine 1 retains the existing installation, including all user content.
  const base = packaged ? userDataDir : projectRoot
  const root = id === 1 ? base : join(base, packaged ? 'machines' : '.local-machines', `machine-${id}`)
  return {
    id, root, defaultRobotPort: 8764 + id,
    diagnosticsDir: !packaged && id === 1 ? join(root, 'data') : root,
    partition: id === 1 ? undefined : `persist:miaofei-machine-${id}`,
  }
}

export function seedMachineProfile({ profile, packaged, projectRoot }) {
  if (packaged) return seedPackagedUserData({ packaged: true, projectRoot, userDataDir: profile.root })
  if (profile.id === 1 && profile.root === projectRoot) return { environmentCreated: false }
  const defaults = join(projectRoot, 'robot-ui', 'packaging', 'defaults')
  const writeMissing = (relative, contents) => {
    const target = join(profile.root, relative)
    mkdirSync(dirname(target), { recursive: true })
    try { writeFileSync(target, contents, { flag: 'wx', mode: 0o600 }); return true }
    catch (error) { if (error.code === 'EEXIST') return false; throw error }
  }
  for (const [file, contents] of Object.entries(SEED_DATA_FILES)) writeMissing(join('data', file), contents)
  for (const dir of SEED_EMPTY_DIRECTORIES) mkdirSync(join(profile.root, 'data', dir), { recursive: true })
  for (const file of SEED_CONFIG_FILES) {
    const target = join(profile.root, 'config', file)
    mkdirSync(dirname(target), { recursive: true })
    if (!existsSync(target)) copyFileSync(join(defaults, 'config', file), target, constants.COPYFILE_EXCL)
  }
  const environment = join(profile.root, '.env')
  if (existsSync(environment)) return { environmentCreated: false }
  copyFileSync(join(defaults, 'backend.env.example'), environment, constants.COPYFILE_EXCL)
  return { environmentCreated: true }
}

export function backendEnvironment({ parent, projectRoot, userDataDir, environmentPath, path, id, diagnosticsDir = userDataDir }) {
  // Carry OS/runtime necessities, never another machine's API keys or .env overrides.
  const allowed = /^(PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMDATA|SYSTEMROOT|WINDIR|COMSPEC|SYSTEMDRIVE|TEMP|TMP|TMPDIR|LANG|LC_.*|DISPLAY|WAYLAND_DISPLAY|XDG_.*|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|SSL_CERT_FILE|SSL_CERT_DIR)$/i
  const env = Object.fromEntries(Object.entries(parent).filter(([key, value]) => allowed.test(key) && typeof value === 'string'))
  return {
    ...env, PATH: path, PROJECT_ROOT: projectRoot, USER_DATA_DIR: userDataDir,
    DIAGNOSTICS_DIR: diagnosticsDir, DOTENV_CONFIG_PATH: environmentPath, BACKEND_LOG_OWNER: 'electron',
    MACHINE_ID: String(id), UI_PORT: id === 1 ? '3001' : '0',
  }
}
