/**
 * 路径拼接安全校验。
 *
 * 控制台通道上的很多指令都带着名字（概念名、地图名、文件名…），这些名字会被
 * 直接拼进文件路径。问题是 path.join 会把 ".." 折叠掉：
 *
 *   join(DATA_DIR, 'barrage-audio', '../../../../Users/xxx/Documents')
 *     → /Users/xxx/Documents
 *
 * 配合 fs.rm({recursive:true}) 就是"删除任意目录"。所以凡是从消息里拿到的
 * 名字，一律先过 safeJoin：只允许单层名字，拼完再确认结果仍然在 base 之内。
 *
 * 注意：中文名字是合法的（现有的概念就叫「退货」「尺码」等），这里只挡分隔符、
 * 上跳、控制字符和 Windows 保留名。
 */

import { resolve, sep } from 'node:path'

// 路径分隔符（含 Windows 反斜杠）、"." 与 ".."、空名字
const ILLEGAL_SEGMENT = /[/\\]|^\.{1,2}$|^$/
// 控制字符和 Windows 文件名非法字符
const ILLEGAL_CHARS = /[\x00-\x1f<>:"|?*]/
// Windows 保留设备名（CON、NUL、COM1…），带扩展名也一样被保留
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

export class UnsafePathError extends Error {
  constructor(segment) {
    super(`非法的名称: ${JSON.stringify(String(segment).slice(0, 40))}`)
    this.name = 'UnsafePathError'
    this.code = 'UNSAFE_PATH'
  }
}

/** 单个路径片段是否安全（不含分隔符、不是 .. 、不含控制字符） */
export function isSafeSegment(name) {
  const s = String(name ?? '')
  if (s.length === 0 || s.length > 255) return false
  if (ILLEGAL_SEGMENT.test(s)) return false
  if (ILLEGAL_CHARS.test(s)) return false
  if (WINDOWS_RESERVED.test(s)) return false
  return true
}

/**
 * 在 base 下安全地拼接若干片段。任一片段非法、或拼接结果跑出 base，
 * 都会抛 UnsafePathError —— 各 handler 外层的 try/catch 会把它变成
 * 一条 ERROR 广播，不会打断后端。
 */
export function safeJoin(base, ...segments) {
  for (const seg of segments) {
    if (!isSafeSegment(seg)) throw new UnsafePathError(seg)
  }
  const root   = resolve(base)
  const target = resolve(root, ...segments.map(s => String(s)))
  // 双保险：即使上面的片段校验有疏漏，也不允许结果落在 base 之外
  if (target !== root && !target.startsWith(root + sep)) {
    throw new UnsafePathError(segments.join('/'))
  }
  return target
}
