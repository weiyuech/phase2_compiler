import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listTests } from '../scripts/run-tests.mjs'
import { runOcrCheck } from '../scripts/check-ocr.mjs'

test('test runner enumerates both suites, sorts files and ignores non-tests', t => {
  const root = mkdtempSync(join(tmpdir(), 'robot-test-runner-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'test'))
  mkdirSync(join(root, 'robot-ui/test'), { recursive: true })
  for (const file of ['test/b.test.js', 'test/a.test.js', 'test/helper.js', 'robot-ui/test/a.test.mjs']) {
    writeFileSync(join(root, file), '')
  }
  mkdirSync(join(root, 'test/not-a-file.test.js'))
  assert.deepEqual(listTests('backend', root), ['test/a.test.js', 'test/b.test.js'].map(file => join(root, file)))
  assert.deepEqual(listTests('ui', root), [join(root, 'robot-ui/test/a.test.mjs')])
  assert.deepEqual(listTests('all', root), [...listTests('backend', root), ...listTests('ui', root)])
  assert.throws(() => listTests('unknown', root), /Choose backend, ui or all/)
  assert.throws(() => listTests('toString', root), /Choose backend, ui or all/)
})

test('test runner fails instead of silently passing an empty suite', t => {
  const root = mkdtempSync(join(tmpdir(), 'robot-empty-suite-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'test'))
  assert.throws(() => listTests('backend', root), /No tests found/)
})

function fakeClient(result = { text: 'ROBOT 12345', score: 0.99, boxes: 1 }) {
  const calls = []
  return {
    calls,
    async init() { calls.push('init') },
    startSession() { calls.push('start'); return 7 },
    async recognize(image, options) {
      calls.push('recognize')
      assert.deepEqual(image, Buffer.from('fixture'))
      assert.deepEqual(options, { generation: 7 })
      return result
    },
    async shutdown() { calls.push('shutdown') },
  }
}

test('OCR check starts the current session and releases the worker after recognition', async () => {
  const client = fakeClient()
  const evidence = await runOcrCheck({ client, image: Buffer.from('fixture') })
  assert.equal(evidence.recognitionMatched, true)
  assert.deepEqual(client.calls, ['init', 'start', 'recognize', 'shutdown'])
})

for (const result of [null, { text: 'wrong text', score: 1 }, { text: 'ROBOT 12345', score: 0.1 }]) {
  test('OCR check rejects missing/incorrect/low-confidence output: ' + JSON.stringify(result), async () => {
    const client = fakeClient(result)
    await assert.rejects(runOcrCheck({ client, image: Buffer.from('fixture') }), /Synthetic OCR/)
    assert.equal(client.calls.at(-1), 'shutdown')
  })
}

for (const stage of ['init', 'recognize']) {
  test('OCR check releases the worker on ' + stage + ' failure', async () => {
    const client = fakeClient()
    client[stage] = async () => { throw new Error('native failure') }
    await assert.rejects(runOcrCheck({ client, image: Buffer.from('fixture') }), /native failure/)
    assert.equal(client.calls.at(-1), 'shutdown')
  })
}

test('OCR check times out and terminates a stalled worker', async () => {
  const client = fakeClient()
  client.recognize = () => new Promise(() => {})
  await assert.rejects(runOcrCheck({ client, image: Buffer.from('fixture'), timeoutMs: 10 }), /timed out/)
  assert.equal(client.calls.at(-1), 'shutdown')
})
