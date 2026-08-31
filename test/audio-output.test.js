import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import ffmpeg from 'ffmpeg-static'
import { WebSocket } from 'ws'

import { RobotListener } from '../src/robot/listener.js'
import { AudioOutputRouter, ROBOT_AUDIO_FORMAT } from '../src/tts/audio-output-router.js'

class FakeRobot extends EventEmitter {
  constructor() {
    super()
    this.frames = []
  }

  isConnected() { return true }

  sendAudioFrame(buffer, seq) {
    this.frames.push({ buffer: Buffer.from(buffer), seq, time: Date.now() })
  }
}

function makeTone(dir, name, frequency, duration) {
  const filePath = join(dir, name)
  const result = spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=${duration}`,
    '-ac', '1', '-ar', '24000', '-codec:a', 'libmp3lame',
    filePath,
  ])
  assert.equal(result.status, 0, result.stderr.toString('utf8'))
  return filePath
}

function makeRouter(dir, robot = new FakeRobot()) {
  const router = new AudioOutputRouter({
    robot,
    filePath: join(dir, 'audio-output.json'),
    ffmpegPath: ffmpeg,
  })
  router.setConfig({ destination: 'robot' })
  return { router, robot }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

test('RobotListener sends the exact robot PCM JSON envelope', () => {
  const robot = new RobotListener()
  let raw = ''
  robot._socket = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send: message => { raw = message },
  }

  robot.sendAudioFrame(Buffer.alloc(640, 7), 1)
  const message = JSON.parse(raw)
  assert.equal(message.audio.type, 'pcm')
  assert.equal(message.audio.sample, '16')
  assert.equal(message.audio.seq, 1)
  assert.equal(Buffer.from(message.audio.data, 'base64').length, 640)
})

test('MP3 file is converted to paced 16 kHz PCM frames', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'audio-output-file-test-'))
  try {
    const mp3 = makeTone(dir, 'tone.mp3', 440, 0.4)
    const { router, robot } = makeRouter(dir)
    const start = Date.now()
    const session = router.playFile({ name: 'file-test' }, mp3)
    await session.promise
    const elapsed = Date.now() - start

    assert.ok(robot.frames.length >= 19 && robot.frames.length <= 22)
    assert.ok(elapsed >= 360, `audio was sent too quickly (${elapsed} ms)`)
    for (const [index, frame] of robot.frames.entries()) {
      assert.equal(frame.seq, index + 1)
      assert.ok(frame.buffer.length > 0)
      assert.ok(frame.buffer.length <= ROBOT_AUDIO_FORMAT.chunkBytes)
    }
    await router.destroy()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('foreground audio preempts and then restores background audio', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'audio-output-priority-test-'))
  try {
    const backgroundFile = makeTone(dir, 'background.mp3', 330, 0.6)
    const foregroundFile = makeTone(dir, 'foreground.mp3', 880, 0.2)
    const { router, robot } = makeRouter(dir)

    const backgroundAudio = await router.prepareFile(backgroundFile)
    const foregroundAudio = await router.prepareFile(foregroundFile)
    const background = router.playPrepared({ name: 'background' }, backgroundAudio)
    await delay(110)
    const beforePreemption = robot.frames.length

    const foreground = router.playPrepared({ name: 'foreground' }, foregroundAudio)
    await foreground.promise
    const afterForeground = robot.frames.length
    await background.promise

    const foregroundFrames = afterForeground - beforePreemption
    const resumedFrames = robot.frames.length - afterForeground
    assert.ok(beforePreemption >= 3 && beforePreemption <= 7)
    assert.ok(foregroundFrames >= 9 && foregroundFrames <= 12)
    assert.ok(resumedFrames >= 23, 'background audio did not resume')
    backgroundAudio.release()
    foregroundAudio.release()
    await router.destroy()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('streaming TTS audio stops sending while paused and resumes in place', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'audio-output-pause-test-'))
  try {
    const mp3 = makeTone(dir, 'stream.mp3', 660, 0.4)
    const { router, robot } = makeRouter(dir)
    const session = router.startMp3Stream({ name: 'stream-test' })
    const data = readFileSync(mp3)
    for (let offset = 0; offset < data.length; offset += 997) {
      session.write(data.subarray(offset, offset + 997))
    }
    session.end()

    await delay(100)
    await session.pause()
    const beforePause = robot.frames.length
    await delay(220)
    assert.equal(robot.frames.length, beforePause, 'frames advanced while paused')
    await session.resume()
    await session.promise

    const gaps = robot.frames.slice(1).map((frame, index) => (
      frame.time - robot.frames[index].time
    ))
    assert.ok(Math.max(...gaps) >= 190, 'pause was not preserved in send timing')
    assert.ok(robot.frames.length >= 20 && robot.frames.length <= 22)
    await router.destroy()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
