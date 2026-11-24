import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_STATIONARY_PROMPT, isDefaultStationaryPrompt, resolveStationaryPrompt } from './stationary-prompt.js'

const projectRoot = fileURLToPath(new URL('../../', import.meta.url))
export function stationaryPromptPath() {
  return resolve(process.env.USER_DATA_DIR || projectRoot, 'config/stationary-prompt.txt')
}

// Read per round, so saving a prompt takes effect on the next rewrite without restart.
export function readStationaryPrompt(file = stationaryPromptPath()) {
  try { return resolveStationaryPrompt(readFileSync(file, 'utf8')) }
  catch (error) {
    if (error.code === 'ENOENT') return DEFAULT_STATIONARY_PROMPT
    throw error
  }
}

export function readStationaryOptions(file = stationaryPromptPath()) {
  try {
    const options = JSON.parse(readFileSync(resolve(dirname(file), 'stationary-options.json'), 'utf8'))
    if (typeof options.customEnabled !== 'boolean' || (options.stylePrompt !== null && typeof options.stylePrompt !== 'string')) {
      throw new Error('定点播放风格配置格式无效')
    }
    return options
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return { customEnabled: !isDefaultStationaryPrompt(readStationaryPrompt(file)), stylePrompt: null }
  }
}

export function readStationaryStylePrompt(file = stationaryPromptPath()) {
  return readStationaryOptions(file).stylePrompt
}

export function writeStationaryPrompt(text, file = stationaryPromptPath(), stylePrompt, customEnabled) {
  if (typeof text !== 'string' || !text.trim() || text.length > 32000) {
    throw new Error('定点播放提示词不能为空且不能超过 32000 字符')
  }
  if (stylePrompt !== undefined && stylePrompt !== null && (typeof stylePrompt !== 'string' || stylePrompt.length > 1000)) {
    throw new Error('补充风格要求须为文本或留空，且不能超过 1000 字符')
  }
  if (customEnabled !== undefined && typeof customEnabled !== 'boolean') throw new Error('自定义模式须为开或关')
  const options = {
    stylePrompt: stylePrompt === undefined ? readStationaryOptions(file).stylePrompt : stylePrompt?.trim() || null,
    customEnabled: customEnabled ?? !isDefaultStationaryPrompt(text),
  }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text, 'utf8')
  writeFileSync(resolve(dirname(file), 'stationary-options.json'), JSON.stringify(options, null, 2) + '\n', 'utf8')
}
