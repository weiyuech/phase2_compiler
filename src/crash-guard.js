/**
 * 进程级兜底错误处理。
 *
 * 打包后后端是 utilityProcess 子进程，它的 stderr 只会写进 userData/backend.log，
 * 用户看不到。任何未捕获的异常/未处理的 Promise 拒绝都会让 Node 直接结束进程，
 * 表现就是"控制台连不上后端"，且没有任何提示。
 *
 * 本模块必须在 index.js 的第一个 import 位置引入：ESM 的 import 按声明顺序求值，
 * 排在最前面才能保证后续模块（LLM / TTS / phase2 …）求值出错时处理器已经就位。
 */

import { writeSync } from 'node:fs'

function stamp() {
  return new Date().toISOString()
}

// 直接 writeSync 到 fd 2，不走 console.error。
// stdio 是管道时 process.stderr 的写入在 macOS 上是异步的，
// console.error 之后立刻 process.exit() 会把这条最关键的信息截掉。
function fatalLog(msg) {
  try { writeSync(2, msg + '\n') } catch {}
}

process.on('uncaughtException', (err) => {
  fatalLog(`[FATAL] ${stamp()} 未捕获异常，后端即将退出:`)
  fatalLog(String(err?.stack || err))
  process.exit(1)
})

// 未处理的 Promise 拒绝在 Node 20 默认会终止进程。
// 这是个长时间运行的直播控制后端——一次偶发的异步失败（模型加载、网络请求…）
// 不应该连带播报、巡游、UI 通道一起中断，所以这里记录后继续运行。
process.on('unhandledRejection', (reason) => {
  console.error(`[ERROR] ${stamp()} 未处理的 Promise 拒绝（已忽略，后端继续运行）:`)
  console.error(reason?.stack || reason)
})
