import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { access } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { OcrWorkerClient } from '../src/phase2/ocr/index.js';

class FakeWorker extends EventEmitter {
  messages = [];
  postMessage(message) { this.messages.push(message); }
  async terminate() { return 0; }
  result(request, result, error) {
    this.emit('message', { type: 'RESULT', requestId: request.requestId, result, error });
  }
  get requests() { return this.messages.filter(message => message.type === 'RECOGNIZE'); }
}

const turn = () => new Promise(resolve => setImmediate(resolve));

async function makeClient(t) {
  const worker = new FakeWorker();
  const client = new OcrWorkerClient({ workerFactory: () => worker, debugImagePath: null });
  t.after(() => client.shutdown());
  const initialization = client.init();
  worker.emit('message', { type: 'READY' });
  await initialization;
  client.startSession();
  return { client, worker };
}

async function complete(client, worker, image, result, options = {}) {
  const promise = client.recognize(image, options);
  await turn();
  worker.result(worker.requests.at(-1), result);
  return promise;
}

test('OCR keeps exactly the last two completed raw image/text pairs, including equivalent captures', async t => {
  const { client, worker } = await makeClient(t);
  const pngA = Buffer.from('original PNG A');
  const first = await complete(client, worker, pngA, { text: 'raw A raw B', lines: ['raw A', 'raw B'], boxes: 2, score: 0.9 });
  const pngB = Buffer.from('original PNG B');
  const second = await complete(client, worker, pngB, { text: 'raw A raw B', lines: ['raw A', 'raw B'], unchanged: true }, { capturedAt: 1234 });
  assert.equal(first.capturedAt, null, 'binary PNG receipt must not invent capture time');
  assert.ok(Number.isFinite(first.receivedAt));
  assert.equal(second.capturedAt, 1234);
  assert.ok(second.snapshotId > first.snapshotId);
  assert.deepEqual(client.observations.map(o => o.id), [first.id, second.id]);
  assert.deepEqual(client.observations.map(o => o.rawText), ['raw A\nraw B', 'raw A\nraw B']);
  assert.equal(client.observations[1].image.toString(), 'original PNG B');
  assert.equal(client.observations[1].unchanged, true);
  assert.ok(!Object.hasOwn(second, 'image'), 'recognized text metadata does not carry screenshot bytes');

  const third = await complete(client, worker, Buffer.from('original PNG C'), { text: 'raw C', lines: ['raw C'] });
  assert.deepEqual(client.observations.map(o => o.snapshotId), [second.id, third.id]);
  assert.deepEqual(client.observations.map(o => o.image.toString()), ['original PNG B', 'original PNG C']);
});

test('observation snapshots cannot be rewritten by caller buffers, result lines or judge output', async t => {
  const { client, worker } = await makeClient(t);
  const originalPng = Buffer.from('PNG');
  const result = await complete(client, worker, originalPng, { text: 'raw OCR typo', lines: ['raw OCR typo'] });
  originalPng.fill(0);
  result.lines[0] = 'rewritten answer';
  result.text = '无新问题';
  const exposed = client.observations;
  exposed[0].image.fill(0);
  assert.throws(() => { exposed[0].rawText = 'judge output'; }, TypeError);
  assert.throws(() => exposed.push({}), TypeError);
  assert.throws(() => { exposed[0].lines[0] = 'judge output'; }, TypeError);
  assert.equal(client.observations[0].image.toString(), 'PNG');
  assert.equal(client.observations[0].rawText, 'raw OCR typo');
  assert.deepEqual(client.observations[0].lines, ['raw OCR typo']);
});

test('blank and cached blank captures are completed observations rather than discarded results', async t => {
  const { client, worker } = await makeClient(t);
  const first = await complete(client, worker, Buffer.from('blank 1'), { text: '', lines: [], boxes: 0, score: 0, unchanged: false });
  const second = await complete(client, worker, Buffer.from('blank 2'), { text: '', lines: [], boxes: 0, score: 0, unchanged: true });
  assert.equal(first.text, '');
  assert.equal(first.unchanged, false);
  assert.deepEqual(second.lines, []);
  assert.equal(second.unchanged, true);
  assert.deepEqual(client.observations.map(o => [o.rawText, o.unchanged]), [['', false], ['', true]]);
});

test('latest-only pending queue does not advance the pair; stop releases all client snapshot references immediately', async t => {
  const { client, worker } = await makeClient(t);
  await complete(client, worker, Buffer.from('completed'), { text: 'old', lines: ['old'] });
  const active = client.recognize(Buffer.from('active'));
  const replaced = client.recognize(Buffer.from('replaced'));
  const latest = client.recognize(Buffer.from('latest'));
  await turn();
  assert.equal(await replaced, null);
  assert.equal(client.observations.length, 1);
  const oldRequest = worker.requests.at(-1);
  client.stopSession();
  assert.equal(client.observations.length, 0);
  assert.equal(client.activeRequest.image, null, 'native work may continue but the client releases its original PNG');
  assert.equal(client.pendingRequest, null);
  assert.equal(await latest, null);
  client.startSession();
  const current = client.recognize(Buffer.from('new session'));
  await turn();
  worker.result(oldRequest, { text: 'stale', lines: ['stale'] });
  assert.equal(await active, null);
  await turn();
  worker.result(worker.requests.at(-1), { text: 'new', lines: ['new'] });
  await current;
  assert.deepEqual(client.observations.map(o => o.rawText), ['new']);
});

test('recognition failures do not advance the observation pair', async t => {
  const { client, worker } = await makeClient(t);
  await complete(client, worker, Buffer.from('good'), { text: 'good', lines: ['good'] });
  const failed = client.recognize(Buffer.from('bad'));
  await turn();
  const rejected = assert.rejects(failed, /failed inference/);
  worker.result(worker.requests.at(-1), null, { message: 'failed inference' });
  await rejected;
  assert.deepEqual(client.observations.map(o => o.rawText), ['good']);
});

test('real OCR preserves blank/cached-blank pairs and resets its independent image anchor by generation', { timeout: 60000 }, async t => {
  const modelsPath = path.resolve('./data/models');
  try {
    await Promise.all(['PP-OCRv6_medium_det.onnx', 'PP-OCRv6_medium_rec.onnx', 'ppocrv6_dict.txt'].map(file => access(path.join(modelsPath, file))));
  } catch {
    t.skip('bundled OCR models are not present in this checkout');
    return;
  }
  const client = new OcrWorkerClient({ modelsPath, debugImagePath: null });
  t.after(() => client.shutdown());
  client.startSession();
  const blank = await sharp({ create: { width: 160, height: 80, channels: 3, background: 'white' } }).png().toBuffer();
  const first = await client.recognize(blank);
  const second = await client.recognize(blank);
  assert.equal(first.text, '');
  assert.deepEqual(first.lines, []);
  assert.equal(first.boxes, 0);
  assert.equal(first.unchanged, false);
  assert.equal(second.unchanged, true);
  assert.equal(client.observations.length, 2);
  assert.deepEqual(client.observations[1].image, blank);
  const noiseImage = async pixels => {
    const data = Buffer.alloc(160 * 80 * 3, 255);
    for (let i = 0; i < pixels; i++) data.fill(0, ((78 * 160) + 10 + i) * 3, ((78 * 160) + 11 + i) * 3);
    return sharp(data, { raw: { width: 160, height: 80, channels: 3 } }).png().toBuffer();
  };
  const tinyChange = await client.recognize(await noiseImage(3));
  assert.equal(tinyChange.unchanged, true);
  assert.deepEqual(client.observations.map(o => o.snapshotId), [second.snapshotId, tinyChange.snapshotId]);
  const accumulatedChange = await client.recognize(await noiseImage(6));
  assert.equal(accumulatedChange.unchanged, false, 'six changed pixels exceed the four-pixel allowance against the true OCR anchor, although only three differ from the last observation');
  client.stopSession();
  assert.equal(client.observations.length, 0);
  client.startSession();
  const restarted = await client.recognize(blank);
  assert.equal(restarted.unchanged, false, 'old worker grayscale anchor must not cross sessions');

});
