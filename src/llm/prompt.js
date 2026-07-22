/**
 * src/llm/prompt.js
 *
 * System prompt is loaded from config/llm-system-prompt.txt at startup and
 * cached in memory.  Call reloadPrompt() to pick up edits without a restart.
 */

import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname  = dirname(fileURLToPath(import.meta.url))
const USER_DATA = process.env.USER_DATA_DIR
const PROMPT_FILE = USER_DATA
  ? resolve(USER_DATA, 'config/llm-system-prompt.txt')
  : resolve(__dirname, '../../config/llm-system-prompt.txt')

let _cache = null

function loadSystemPrompt() {
  if (_cache !== null) return _cache
  try {
    _cache = readFileSync(PROMPT_FILE, 'utf8').trimEnd()
  } catch {
    _cache = '你是一名直播讲解员，请将讲解文本改写为口播版本，语言自然流畅。'
  }
  return _cache
}

/** Clear the in-memory cache so the next rewrite call re-reads the file. */
export function reloadPrompt() {
  _cache = null
}

export function buildPrompt(body, goalObject = null) {
  let system = loadSystemPrompt()

  if (goalObject) {
    system += `\n当前机器人镜头正对准的目标物体：${goalObject}（COCO 类名），请确保改写内容与此物体相关。`
  }

  const user = `请将以下讲解内容改写为口播版本：\n\n${body}`
  return { system, user }
}
