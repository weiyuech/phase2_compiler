import test from 'node:test';
import assert from 'node:assert/strict';
import { CommentHistory } from '../src/phase2/ocr/comment-history.js';
import { imagesEquivalent } from '../src/phase2/ocr/image-change.js';
import { BarrageProvider } from '../src/knowledge/barrage-provider.js';
import { mkdtemp, rm } from 'node:fs/promises';
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

test('scrolling feeds only new lines, retaining older captures in bounded history', () => {
  const h = new CommentHistory();
  assert.equal(h.extract(['A', 'B', 'C', 'D', 'E']), 'A\nB\nC\nD\nE');
  assert.equal(h.extract(['B', 'C', 'D', 'E', 'F', 'G']), 'F\nG');
  assert.equal(h.extract(['C', 'D', 'E', 'F', 'G']), '');
  assert.equal(h.extract(['A', 'F', 'G']), '');
});

test('anchored long-line OCR substitution does not replay old comments', () => {
  const h = new CommentHistory();
  h.extract(['用户说今天中午好', '保持不变']);
  assert.equal(h.extract(['用户说今天中牛好', '保持不变', '新问题']), '新问题');
  assert.equal(h.extract(['用户说今天中午好', '新问题']), '');
});

test('short comments and changed numbers remain distinct', () => {
  const h = new CommentHistory();
  h.extract(['午', '价格是15元', '价格是1.5元', '不变']);
  assert.equal(h.extract(['牛', '价格是16元', '不变']), '牛\n价格是16元');
});

test('history expires, resets and has a hard entry bound', () => {
  let now = 0;
  const h = new CommentHistory({ limit: 2, ttlMs: 10, now: () => now });
  h.extract(['A', 'B', 'C']);
  assert.equal(h.entries.length, 2);
  now = 11;
  assert.equal(h.extract(['C']), 'C');
  h.reset();
  assert.equal(h.extract(['C']), 'C');
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
