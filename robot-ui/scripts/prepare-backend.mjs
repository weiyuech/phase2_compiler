/**
 * prepare-backend.mjs
 * Run before electron-builder to install backend dependencies into
 * resources/backend/node_modules so utilityProcess.fork() can resolve them.
 *
 * Usage: node scripts/prepare-backend.mjs
 */
import { execSync }                  from 'child_process'
import { join, dirname }             from 'path'
import { fileURLToPath }             from 'url'
import { cpSync, mkdirSync, rmSync, existsSync } from 'fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const rootDir   = join(__dirname, '../../')              // robot-live-system/
const destDir   = join(__dirname, '../resources/backend')

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

// Windows 专属：下载 Visual C++ 2022 运行库，供 NSIS 安装脚本静默安装
// @ngrok/ngrok 是 Rust 编译的 native 模块，运行依赖 VCRUNTIME140.dll
/*
if (process.platform === 'win32') {
  const buildDir     = join(__dirname, '../build')
  const vcRedistPath = join(buildDir, 'vc_redist.x64.exe')
  mkdirSync(buildDir, { recursive: true })
  if (!existsSync(vcRedistPath)) {
    console.log('[prepare-backend] 下载 Visual C++ 2022 运行库 (vc_redist.x64.exe)...')
    // fetch 在 Node 18+ 内置，自动跟随重定向
    const res = await fetch('https://aka.ms/vs/17/release/vc_redist.x64.exe')
    if (!res.ok) throw new Error(`vc_redist 下载失败: HTTP ${res.status}`)
    const { writeFileSync } = await import('fs')
    writeFileSync(vcRedistPath, Buffer.from(await res.arrayBuffer()))
    console.log('[prepare-backend] vc_redist.x64.exe 已保存至', vcRedistPath)
  } else {
    console.log('[prepare-backend] vc_redist.x64.exe 已存在，跳过下载')
  }
}
*/
