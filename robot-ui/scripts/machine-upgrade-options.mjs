import { resolve } from 'node:path'

// Keep destructive installer execution restricted to disposable Windows CI.
// Development runs only create a synthetic profile and never execute an installer.
export function upgradeSmokeOptions(args, { platform = process.platform, env = process.env, cwd = process.cwd() } = {}) {
  const values = {}
  for (let index = 0; index < args.length; index++) {
    const name = args[index]
    if (!['--executable', '--installer', '--output'].includes(name)) throw new Error(`Unknown option: ${name}`)
    if (values[name]) throw new Error(`Repeated option: ${name}`)
    const value = args[++index]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`)
    values[name] = resolve(cwd, value)
  }
  if (values['--executable'] && values['--installer']) throw new Error('Choose --executable or --installer, not both')
  const packaged = Boolean(values['--executable'] || values['--installer'])
  if (packaged && (platform !== 'win32' || env.GITHUB_ACTIONS !== 'true' || !env.RUNNER_TEMP)) {
    throw new Error('Packaged upgrade smoke must run on a disposable Windows GitHub Actions runner with RUNNER_TEMP')
  }
  return { packaged, executable: values['--executable'], installer: values['--installer'], output: values['--output'] }
}
