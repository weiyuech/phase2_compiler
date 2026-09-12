import test from 'node:test';
import assert from 'node:assert/strict';
import { OcrTextJudge } from '../src/phase2/ocr/text-judge.js';
import { DEFAULT_OCR_JUDGE_PROMPT } from '../src/phase2/ocr/judge-prompt.js';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { imagesEquivalent } from '../src/phase2/ocr/image-change.js';
import { BarrageProvider } from '../src/knowledge/barrage-provider.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('scan interval and cooldown persist independently and interval is bounded', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ocr-settings-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const provider = new BarrageProvider({ dir });
  await provider.initialize();
  assert.equal((await provider.getConfig()).scan_interval, 1);
  await provider.saveConfig({ mode: 'llm-strict', scan_interval: 8, cooldown: 25 });
  const saved = await provider.getConfig();
  assert.equal(saved.scan_interval, 8);
  assert.equal(saved.cooldown, 25);
  await provider.saveConfig({ ...saved, scan_interval: 900 });
  assert.equal((await provider.getConfig()).scan_interval, 60);
  assert.equal((await provider.getConfig()).cooldown, 25);
});

test('judge alone decides new text; only exact signal skips', async () => {
  const sent = [], inputs = [], outputs = ['无新问题', 'F\nG', '无新问题。'];
  const h = new OcrTextJudge({ judge: async (prompt, user) => {
    assert.equal(prompt, DEFAULT_OCR_JUDGE_PROMPT);
    inputs.push(user);
    return outputs.shift();
  }, onText: text => sent.push(text) });
  for (const text of ['ABCDE', 'BCDEFG', 'BCDEFG']) { h.submit(text); await nextTurn(); }
  assert.deepEqual(sent, ['F\nG', '无新问题。']);
  assert.equal(inputs[1], '<previous_ocr>\nABCDE\n</previous_ocr>\n<current_ocr>\nBCDEFG\n</current_ocr>');
  assert.equal(inputs.length, 3, 'no hidden text-equality judge');
});

test('slow judge retains only latest pending capture and reset discards old answers', async () => {
  const calls = [], sent = [];
  const h = new OcrTextJudge({ judge: (_prompt, user) => new Promise(resolve => calls.push({ user, resolve })), onText: text => sent.push(text) });
  h.submit('A'); h.submit('B'); h.submit('C');
  assert.equal(calls.length, 1);
  calls[0].resolve('无新问题'); await nextTurn();
  assert.equal(calls[1].user, '<previous_ocr>\nA\n</previous_ocr>\n<current_ocr>\nC\n</current_ocr>');
  h.reset(); h.submit('new session');
  calls[1].resolve('stale answer'); await nextTurn();
  assert.equal(calls[2].user, '<previous_ocr>\n\n</previous_ocr>\n<current_ocr>\nnew session\n</current_ocr>');
  calls[2].resolve('fresh answer'); await nextTurn();
  assert.deepEqual(sent, ['fresh answer']);
});

test('failed judge does not fall back to raw OCR or advance baseline', async () => {
  const errors = [], sent = [];
  const h = new OcrTextJudge({ judge: async () => null, onText: text => sent.push(text), onError: error => errors.push(error) });
  h.submit('raw screenshot text'); await nextTurn();
  assert.equal(errors.length, 1);
  assert.equal(h.previous, '');
  assert.deepEqual(sent, []);
});

test('judge loads saved custom prompt on each round and falls back when absent', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ocr-judge-prompt-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const promptPath = join(dir, 'judge.txt'), seen = [];
  const h = new OcrTextJudge({ promptPath, judge: async prompt => {
    seen.push(prompt); return '无新问题';
  }, onText: () => assert.fail('skip signal must not reach reply') });
  // Drain directly so asynchronous prompt IO is awaited deterministically.
  const round = async text => { h.pending = { text, epoch: h.epoch }; await h.drain(); };
  await round('first');
  await writeFile(promptPath, '自定义判断规则');
  await round('second');
  await writeFile(promptPath, DEFAULT_OCR_JUDGE_PROMPT);
  await round('third');
  assert.deepEqual(seen, [DEFAULT_OCR_JUDGE_PROMPT, '自定义判断规则', DEFAULT_OCR_JUDGE_PROMPT]);
});

test('pixel comparison tolerates tiny noise but detects changed text and dimensions', () => {
  const frame = { width: 100, height: 100, data: Buffer.alloc(10000, 100) };
  const noise = { ...frame, data: Buffer.alloc(10000, 105) };
  assert.equal(imagesEquivalent(frame, noise), true);
  noise.data.fill(200, 0, 20);
  assert.equal(imagesEquivalent(frame, noise), false);
  assert.equal(imagesEquivalent(frame, { ...frame, width: 50 }), false);
  assert.equal(imagesEquivalent(null, frame), false);
});
