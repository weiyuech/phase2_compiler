#!/usr/bin/env node
// gen-icon.mjs — 用纯 Node.js 内置模块生成 PNG 图标（无需额外 npm 包）
// 输出：
//   build/icon.png      1024×1024  彩色机器人头像，供 electron-builder 转换为 .icns/.ico
//   build/tray-icon.png   22×22   黑色透明背景，macOS template image 自适应深/浅色

import zlib from 'zlib'
import { writeFileSync, mkdirSync, readFileSync } from 'fs'
import { join, dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { promisify } from 'util'

const deflate = promisify(zlib.deflate)
const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT_DIR  = resolve(__dirname, '../../')
const BUILD_DIR = join(__dirname, '../build')

// ─── CRC32 ────────────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    t[i] = c
  }
  return t
})()

function crc32(buf) {
  let crc = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8)
  return (crc ^ 0xFFFFFFFF) >>> 0
}

// ─── PNG builder ──────────────────────────────────────────────────────────────
function makeChunk(type, data) {
  const lenBuf  = Buffer.allocUnsafe(4)
  lenBuf.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf  = Buffer.allocUnsafe(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf])
}

async function buildPNG(width, height, drawPixel) {
  const rows = []
  for (let y = 0; y < height; y++) {
    const row = Buffer.allocUnsafe(1 + width * 4)
    row[0] = 0  // filter: None
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = drawPixel(x, y)
      const i = 1 + x * 4
      row[i] = r; row[i+1] = g; row[i+2] = b; row[i+3] = a
    }
    rows.push(row)
  }
  const compressed = await deflate(Buffer.concat(rows))

  const ihdr = Buffer.allocUnsafe(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8   // bit depth
  ihdr[9] = 6   // color type: RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),  // PNG signature
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0)),
  ])
}

// ─── Geometry helpers for legacy code ─────────────────────────────────────────
function inCircle(x, y, cx, cy, r) {
  const dx = x - cx, dy = y - cy
  return dx * dx + dy * dy <= r * r
}
function inRect(x, y, x1, y1, x2, y2) {
  return x >= x1 && x <= x2 && y >= y1 && y <= y2
}
function inRoundedRect(x, y, x1, y1, x2, y2, r) {
  if (!inRect(x, y, x1, y1, x2, y2)) return false
  if (x < x1 + r && y < y1 + r) return inCircle(x, y, x1 + r, y1 + r, r)
  if (x > x2 - r && y < y1 + r) return inCircle(x, y, x2 - r, y1 + r, r)
  if (x < x1 + r && y > y2 - r) return inCircle(x, y, x1 + r, y2 - r, r)
  if (x > x2 - r && y > y2 - r) return inCircle(x, y, x2 - r, y2 - r, r)
  return true
}

// ─── Minimalist SVG Renderer (Rasterizer) ───────────────────────────────────
// Since we don't want to add external dependencies like 'sharp', we will 
// adapt the SVG logic to a pixel-drawing function.
async function renderMinimalistIcon(S = 1024) {
  const TEAL_DARK = [0x2c, 0x3e, 0x50, 0xFF] 
  const BLUE_GREY = [0x34, 0x49, 0x5e, 0xFF]
  const WHITE     = [0xFF, 0xFF, 0xFF, 0xFF]
  const LIGHT_GREY= [0xbd, 0xc3, 0xc7, 0xFF]
  const TR        = [0, 0, 0, 0]

  const k = S / 1024
  
  return buildPNG(S, S, (x, y) => {
    // Antenna Ball
    if (inCircle(x, y, 512*k, 70*k, 40*k)) return TEAL_DARK
    // Antenna Stem
    if (inRect(x, y, 497*k, 60*k, 527*k, 180*k)) return TEAL_DARK
    // Antenna Base
    if (inRoundedRect(x, y, 432*k, 160*k, 592*k, 200*k, 20*k)) return TEAL_DARK

    // Wheels
    if (inRoundedRect(x, y, 60*k, 580*k, 260*k, 960*k, 100*k)) return BLUE_GREY
    if (inRoundedRect(x, y, 764*k, 580*k, 964*k, 960*k, 100*k)) return BLUE_GREY
    
    // Connection bar
    if (inRect(x, y, 250*k, 700*k, 774*k, 760*k)) return LIGHT_GREY

    // Main Head Outline
    const isHeadOutline = inCircle(x, y, 512*k, 500*k, 332*k) // rough approximation of the super-ellipse
    const isHeadInner   = inCircle(x, y, 512*k, 500*k, 300*k)

    // Using path logic simplified to circles/rects for this custom generator
    if (inRoundedRect(x, y, 180*k, 200*k, 844*k, 800*k, 280*k)) {
        // Face Screen
        if (inRoundedRect(x, y, 310*k, 300*k, 714*k, 660*k, 150*k)) {
            // Eyes
            if (inCircle(x, y, 420*k, 460*k, 45*k)) return WHITE
            if (inCircle(x, y, 604*k, 460*k, 45*k)) return WHITE
            // Smile
            if (inCircle(x, y, 512*k, 560*k, 30*k) && y > 560*k) return WHITE 
            return TEAL_DARK
        }
        // Head White Fill
        if (inRoundedRect(x, y, 215*k, 235*k, 809*k, 765*k, 245*k)) return WHITE
        return TEAL_DARK // Stroke
    }

    return TR
  })
}

// ─── 22×22 托盘图标（Keep original logic as requested） ───────────────────────
async function makeTrayIcon() {
  const S  = 22
  const BK = [0, 0, 0, 255]  // 不透明黑色
  const TR = [0, 0, 0, 0]    // 透明

  return buildPNG(S, S, (x, y) => {
    if (!inRoundedRect(x, y, 2, 3, 19, 18, 3)) return TR
    if (inRect(x, y, 5, 7, 8, 10))  return TR
    if (inRect(x, y, 13, 7, 16, 10)) return TR
    if (inRect(x, y, 5, 13, 16, 15)) return TR
    return BK
  })
}

// ─── ICO builder ──────────────────────────────────────────────────────────────
function makePNGinICO(pngBuf) {
  const header = Buffer.allocUnsafe(22)
  header.writeUInt16LE(0,  0)
  header.writeUInt16LE(1,  2)
  header.writeUInt16LE(1,  4)
  header[6]  = 0
  header[7]  = 0
  header[8]  = 0
  header[9]  = 0
  header.writeUInt16LE(1,  10)
  header.writeUInt16LE(32, 12)
  header.writeUInt32LE(pngBuf.length, 14)
  header.writeUInt32LE(22,             18)
  return Buffer.concat([header, pngBuf])
}

// ─── Main ─────────────────────────────────────────────────────────────────────
mkdirSync(BUILD_DIR, { recursive: true })

console.log('[gen-icon] Rendering minimalist icons...')
const [appIcon1024, appIcon256, trayIcon] = await Promise.all([
  renderMinimalistIcon(1024),
  renderMinimalistIcon(256),
  makeTrayIcon(),
])

writeFileSync(join(BUILD_DIR, 'icon.png'),      appIcon1024)
writeFileSync(join(BUILD_DIR, 'icon.ico'),      makePNGinICO(appIcon256))
writeFileSync(join(BUILD_DIR, 'tray-icon.png'), trayIcon)

console.log('✓ build/icon.png      (1024×1024) [Minimalist SVG Version]')
console.log('✓ build/icon.ico      (256×256)   [Minimalist SVG Version]')
console.log('✓ build/tray-icon.png (22×22)     [Original Cute Version preserved]')
