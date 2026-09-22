/**
 * prepare-backend.mjs
 * Run before electron-builder to install backend dependencies into
 * resources/backend/node_modules so utilityProcess.fork() can resolve them.
 *
 * Usage: node scripts/prepare-backend.mjs
 */
import { execSync, execFileSync }                  from 'child_process'
import { join, dirname }             from 'path'
import { fileURLToPath }             from 'url'
import { cpSync, mkdirSync, rmSync, existsSync, writeFileSync, renameSync } from 'fs'
import { preparePackageSeed } from './prepare-package-seed.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const rootDir   = join(__dirname, '../../')              // robot-live-system/
const destDir   = join(__dirname, '../resources/backend')

// Only these reviewed, generated seeds may enter an installer. Never package
// the developer's live data/, config/, .env, recordings or saved credentials.
const seedDir = preparePackageSeed({ projectRoot: rootDir })
console.log('[prepare-backend] clean first-install seeds →', seedDir)

// Clean previous install to avoid stale native binaries
if (existsSync(join(destDir, 'node_modules'))) {
  rmSync(join(destDir, 'node_modules'), { recursive: true, force: true })
}
mkdirSync(destDir, { recursive: true })

// Copy the root manifest and lockfile so the packaged backend is reproducible
cpSync(join(rootDir, 'package.json'), join(destDir, 'package.json'))
cpSync(join(rootDir, 'package-lock.json'), join(destDir, 'package-lock.json'))

console.log('[prepare-backend] installing backend dependencies...')
execSync('npm ci --omit=dev', {
  cwd: destDir,
  stdio: 'inherit',
  env: { ...process.env }
})

console.log('[prepare-backend] rebuilding native modules for Electron...')
const nativeModules = []
const candidates = ['ntsuspend', 'sharp', /* '@ngrok/ngrok', */ 'onnxruntime-node']
for (const mod of candidates) {
  if (existsSync(join(destDir, 'node_modules', mod))) {
    nativeModules.push(mod)
  }
}
if (nativeModules.length > 0) {
  console.log(`[prepare-backend] rebuilding: ${nativeModules.join(', ')}`)
  execSync(
    `npx @electron/rebuild -f -w ${nativeModules.join(',')} --module-dir "${destDir}"`,
    { cwd: join(__dirname, '..'), stdio: 'inherit' }
  )
}
console.log('[prepare-backend] done →', destDir)

// Clean up unused platform binaries from onnxruntime-node to save ~123MB in packaged app size
const ortBinDir = join(destDir, 'node_modules/onnxruntime-node/bin/napi-v6')
if (existsSync(ortBinDir)) {
  console.log('[prepare-backend] Cleaning up unused platform binaries from onnxruntime-node...')
  const platforms = ['darwin', 'linux', 'win32']
  for (const p of platforms) {
    if (p !== process.platform) {
      const pDir = join(ortBinDir, p)
      if (existsSync(pDir)) {
        rmSync(pDir, { recursive: true, force: true })
        console.log(`[prepare-backend] Removed unused platform: ${p}`)
      }
    }
  }
}

// ONNX Runtime needs the MSVC runtime even when ngrok is disabled. Bundle it
// for offline installation; never let a cached or partial download bypass trust checks.
if (process.platform === 'win32') {
  const buildDir = join(__dirname, '../build')
  const vcRedistPath = join(buildDir, 'vc_redist.x64.exe')
  const downloadPath = vcRedistPath + '.download.exe'
  mkdirSync(buildDir, { recursive: true })
  console.log('[prepare-backend] downloading Microsoft Visual C++ x64 runtime...')
  try {
    const res = await fetch('https://aka.ms/vs/17/release/vc_redist.x64.exe', {
      signal: AbortSignal.timeout(120_000),
    })
    if (!res.ok) throw new Error(`vc_redist download failed: HTTP ${res.status}`)
    writeFileSync(downloadPath, Buffer.from(await res.arrayBuffer()))
    // CI runs in PowerShell 7. Do not pass its module search path to Windows
    // PowerShell 5, which cannot load the newer Security module assemblies.
    const signatureEnv = { ...process.env, ROBOT_VC_REDIST_PATH: downloadPath }
    for (const key of Object.keys(signatureEnv)) {
      if (key.toLowerCase() === 'psmodulepath') delete signatureEnv[key]
    }
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
      $ErrorActionPreference = 'Stop'
      Import-Module "$PSHOME\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1"
      $signature = Get-AuthenticodeSignature -LiteralPath $env:ROBOT_VC_REDIST_PATH
      if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(^|,\\s*)O=Microsoft Corporation(,|$)') {
        throw 'VC++ runtime must have a valid Microsoft signature'
      }
    `], { stdio: 'inherit', env: signatureEnv })
    renameSync(downloadPath, vcRedistPath)
  } finally {
    rmSync(downloadPath, { force: true })
  }
}
