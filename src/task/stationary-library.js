import { randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const GROUP_LIMIT = 12

function validateName(name) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 40) throw new Error('分组名称须为 1 至 40 个字符')
  return name.trim()
}

function findGroup(groups, id) {
  const group = groups.find(item => item.id === id && ID.test(id))
  if (!group) throw new Error('定点播放分组不存在')
  return group
}

function makeGroup(name) {
  return { id: randomUUID(), name, text: '', mode: 'tts', loop: true, shuffle: false, recordingIds: [], recordings: [] }
}

/** One backend owns writes for its machine. Electron exports through its own read-only lookup. */
export class StationaryLibrary {
  constructor(directory) {
    this.directory = directory
    this.index = join(directory, 'library.json')
  }

  _read() {
    const data = JSON.parse(readFileSync(this.index, 'utf8'))
    if (data.version !== 1 || !Array.isArray(data.groups) || !data.groups.length) throw new Error('定点播放分组文件格式无效')
    return data.groups
  }

  _save(groups) {
    mkdirSync(this.directory, { recursive: true })
    const temporary = this.index + '.' + randomUUID() + '.tmp'
    try {
      writeFileSync(temporary, JSON.stringify({ version: 1, groups }), { flag: 'wx' })
      renameSync(temporary, this.index)
    } finally {
      rmSync(temporary, { force: true })
    }
  }

  snapshot() {
    try { return { groups: this._read() } }
    catch (error) {
      if (error.code !== 'ENOENT') throw error
      const groups = [makeGroup('定点1')]
      this._save(groups)
      return { groups }
    }
  }

  createGroup(name) {
    const { groups } = this.snapshot()
    if (groups.length >= GROUP_LIMIT) throw new Error('最多可创建 12 个分组')
    const group = makeGroup(validateName(name))
    if (groups.some(other => other.name === group.name)) throw new Error('已有同名分组')
    groups.push(group)
    this._save(groups)
    return group
  }

  updateGroup(id, { name, text, mode, loop, shuffle, recordingIds }) {
    const groups = this._read()
    const group = findGroup(groups, id)
    if (name !== undefined) {
      const value = validateName(name)
      if (groups.some(other => other.id !== id && other.name === value)) throw new Error('已有同名分组')
      group.name = value
    }
    if (text !== undefined) {
      if (typeof text !== 'string' || text.length > 100000) throw new Error('分组原文最多 100000 个字符')
      group.text = text
    }
    if (mode !== undefined) {
      if (!['tts', 'mp3'].includes(mode)) throw new Error('未知的播放方式')
      group.mode = mode
    }
    for (const [key, value] of Object.entries({ loop, shuffle })) {
      if (value === undefined) continue
      if (typeof value !== 'boolean') throw new Error('无效的播放选项')
      group[key] = value
    }
    if (recordingIds !== undefined) {
      const allowed = new Set(group.recordings.map(item => item.id))
      if (!Array.isArray(recordingIds) || recordingIds.some(item => !allowed.has(item))) throw new Error('此定点中没有选中的录音')
      group.recordingIds = [...new Set(recordingIds)]
    }
    this._save(groups)
    return group
  }

  addRecording(groupId, { file, text, iteration }) {
    const groups = this._read()
    const group = findGroup(groups, groupId)
    const bytes = statSync(file).size
    if (!bytes) throw new Error('整轮录音为空')
    const recording = { id: randomUUID(), createdAt: new Date().toISOString(), iteration,
      title: text.trim().replace(/\s+/gu, ' ').slice(0, 60), bytes }
    const folder = join(this.directory, groupId)
    mkdirSync(folder, { recursive: true })
    const destination = join(folder, recording.id + '.mp3')
    try {
      copyFileSync(file, destination)
      group.recordings.unshift(recording)
      this._save(groups)
    } catch (error) {
      rmSync(destination, { force: true })
      throw error
    }
    return recording
  }

  recordingPath(groupId, recordingId) {
    const group = findGroup(this._read(), groupId)
    if (!ID.test(recordingId) || !group.recordings.some(item => item.id === recordingId)) throw new Error('此分组中没有这条录音')
    return join(this.directory, group.id, recordingId + '.mp3')
  }

  playlist(groupId, ids) {
    const group = findGroup(this._read(), groupId)
    if (!Array.isArray(ids) || !ids.length || ids.length > group.recordings.length) throw new Error('请勾选当前分组的录音')
    const available = new Map(group.recordings.map(item => [item.id, item]))
    return [...new Set(ids)].map(id => {
      if (!ID.test(id) || !available.has(id)) throw new Error('此分组中没有这条录音')
      return { ...available.get(id), path: join(this.directory, group.id, id + '.mp3') }
    })
  }
}
