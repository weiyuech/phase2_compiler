import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { initPhase2 } from '../src/phase2/index.js';
import { barrageProvider } from '../src/knowledge/barrage-provider.js';
import { fakeClock, until, deferred } from './fixtures/decision-clock.js';

class Bridge extends EventEmitter {
  messages = [];
  broadcast(type, data) { this.messages.push({ type, data }); }
  async command(type, data) { for (const handler of this.listeners(type)) await handler(data); }
}

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'barrage-pipeline-'));
  const savedData = process.env.USER_DATA_DIR;
  process.env.USER_DATA_DIR = dir;
  const savedMethods = Object.fromEntries(['getConfig', 'listConcepts', 'getConcept'].map(name => [name, barrageProvider[name]]));
  const config = { mode: 'llm-general', scan_interval: 3, cooldown: 9, ...options.config };
  barrageProvider.getConfig = async () => ({ ...config });
  barrageProvider.listConcepts = async () => ['price', 'shipping'];
  barrageProvider.getConcept = async name => ({ keywords: [name], priority: name === 'shipping' });
  const time = fakeClock(), bridge = new Bridge(), inputs = [], answerInputs = [], playback = [];
  const state = { host: false, generation: 0, starts: 0, ends: 0, pauses: 0, recognizes: 0 };
  const ocr = {
    initOcr: async () => {},
    startOcrSession: () => ++state.generation,
    stopOcrSession: () => ++state.generation,
    shutdownOcr: async () => {},
    setOcrPaused: () => { state.pauses++; },
    recognizeText: async image => {
      state.recognizes++;
      const item = JSON.parse(image.toString());
      return { ...item, lines: item.text ? item.text.split('\n') : [], snapshotId: state.recognizes };
    },
  };
  const finishAudio = async (value, opts) => {
    playback.push(value);
    if (options.prepare) await options.prepare(value, opts);
    opts.onPrepared?.();
    if (options.beforeAudio) await options.beforeAudio(value, opts);
    if (opts.beforePlay?.() === false || opts.onAudioStart?.() === false) return { ok: false, aborted: true };
    if (options.play) await options.play(value, opts);
    return { ok: true };
  };
  const phase = initPhase2({
    robot: new EventEmitter(), tour: new EventEmitter(), uiBridge: bridge,
    llm: {
      judgeOcr: async (prompt, input) => { inputs.push({ prompt, input }); return options.judge ? options.judge(prompt, input) : '无新问题'; },
      rewriteBarrage: async (prompt, input) => {
        answerInputs.push({ prompt, input });
        return options.answer ? options.answer(prompt, input) : 'answer sentence。';
      },
    },
    tts: {
      player: { isPlaying: () => false }, stop() {},
      speak: (text, opts) => finishAudio(text, opts),
      speakFile: (file, opts) => finishAudio(file, opts),
    },
    checkIsSpeaking: () => state.host,
    onBarrageSpeechStart: () => state.starts++,
    onBarrageSpeechEnd: () => state.ends++,
    ocrLoader: async () => ocr, decisionOptions: time,
  });
  phase.barrageManager.audioDir = join(dir, 'clips');
  for (const name of ['price', 'shipping']) {
    await mkdir(join(dir, 'clips', name), { recursive: true });
    await writeFile(join(dir, 'clips', name, 'test.mp3'), 'audio stub');
  }
  t.after(async () => {
    await phase.destroy();
    Object.assign(barrageProvider, savedMethods);
    if (savedData === undefined) delete process.env.USER_DATA_DIR; else process.env.USER_DATA_DIR = savedData;
    await rm(dir, { recursive: true, force: true });
  });
  await bridge.command('onBarrageStart', { x: 0, y: 0, width: 100, height: 100 });
  await until(() => state.generation > 0);
  return {
    phase, bridge, dir, state, time, inputs, answerInputs, playback, config,
    scan: (text, unchanged = false) => bridge.command('onBarrageImage', Buffer.from(JSON.stringify({ text, unchanged }))),
    settle: () => until(() => !phase.decisionClock.running),
    configure: changes => { Object.assign(config, changes); phase.configureBarrage(config); },
  };
}

test('actual phase routing logs raw interval OCR during cooldown, not judge-filtered output', async t => {
  let calls = 0;
  const h = await fixture(t, { judge: async () => ++calls === 1 ? '无新问题' : 'F\nG' });
  await h.scan('ABC'); await h.settle();
  await h.time.at(3000); await h.scan('ABCD');
  await h.time.at(6000); await h.scan('BCDE');
  await h.time.at(8999); await h.scan('EFGHJ');
  assert.equal(h.inputs.length, 1);
  await h.time.at(9000); await h.settle();
  assert.equal(h.inputs[1].input, '<previous_ocr>\nABC\n</previous_ocr>\n<current_ocr>\nEFGHJ\n</current_ocr>');
  assert.equal(h.answerInputs.length, 1);
  assert.match(h.answerInputs[0].input, /<barrage_text>\nF\nG\n/);
  assert.equal(h.state.starts, 1);
  assert.equal(h.phase.barrageManager.isSleeping, false, 'no second cooldown after playback');
  await h.scan('EFGHJ', true);
  await h.scan('');
  await h.phase.destroy(); // flush asynchronous raw log
  const log = await readFile(join(h.dir, 'data', 'barrage-ocr-log.txt'), 'utf8');
  for (const text of ['ABC', 'ABCD', 'BCDE', 'EFGHJ', '[无文字]']) assert.ok(log.includes('] ' + text + '\n'));
  assert.equal(log.split('] EFGHJ\n').length - 1, 1, 'cached image hit does not masquerade as another inference');
  assert.ok(!log.includes('] F\nG\n'), 'judge output is not the raw OCR log');
});

test('MP3 uses only current OCR, preserves priority/random matching and repeats only on available slots', async t => {
  const h = await fixture(t, { config: { mode: 'mp3', priority_mode: true, random_reply: true } });
  await h.scan('price shipping'); await h.settle();
  assert.equal(h.playback.length, 1);
  assert.equal(basename(dirname(h.playback[0])), 'shipping');
  await h.time.at(3000); await h.scan('price', true);
  await h.time.at(9000); await h.settle();
  assert.equal(h.playback.length, 2);
  assert.equal(basename(dirname(h.playback[1])), 'price');
  await h.time.at(18000); await h.settle();
  assert.equal(h.playback.length, 3, 'MP3 re-matches current OCR without a judged-text history');
  assert.deepEqual(h.inputs, []);
  assert.deepEqual(h.answerInputs, []);
});

for (const mode of ['mp3', 'llm-general']) {
  test(mode + ': preparation/playback skip opportunities; raw OCR continues and no catch-up occurs', async t => {
    const preparing = deferred(), playing = deferred();
    let stage = 'idle', preparations = 0;
    const h = await fixture(t, {
      config: { mode }, judge: async () => 'price',
      prepare: async () => { if (++preparations === 1) { stage = 'preparing'; await preparing.promise; } },
      play: async () => { if (preparations === 1) { stage = 'playing'; await playing.promise; } },
    });
    await h.scan('price'); await until(() => stage === 'preparing');
    assert.equal(h.state.starts, 0, 'preparing barrage does not claim a speaker or pause cruise/transit');
    await h.time.at(6000); await h.scan('shipping');
    await h.time.at(9000);
    assert.equal(preparations, 1);
    preparing.resolve(); await until(() => stage === 'playing');
    await h.time.at(15000); await h.scan('price shipping');
    await h.time.at(18000);
    assert.equal(preparations, 1);
    assert.equal(h.state.recognizes, 3);
    assert.equal(h.state.pauses, 0, 'reply busy state does not suppress the raw observation path');
    playing.resolve(); await h.settle();
    await h.time.at(20000);
    assert.equal(preparations, 1, 'finishing audio cannot replay a skipped slot');
    await h.time.at(27000); await h.settle();
    assert.ok(preparations > 1);
    if (mode !== 'mp3') assert.match(h.inputs[1].input, /<previous_ocr>\nprice\n/);
    else assert.equal(h.inputs.length, 0);
  });
}

test('mode change invalidates pending paid request; old completion cannot play or reserve new baseline', async t => {
  const pending = deferred();
  const h = await fixture(t, { judge: () => pending.promise });
  await h.scan('price'); await until(() => h.inputs.length === 1);
  h.configure({ mode: 'mp3' });
  await h.scan('shipping');
  assert.equal(h.playback.length, 0, 'old external request is still finishing');
  pending.resolve('price'); await h.settle();
  assert.equal(h.answerInputs.length, 0);
  await h.time.at(9000); await h.settle();
  assert.equal(basename(dirname(h.playback[0])), 'shipping');
  assert.equal(h.inputs.length, 1);
});

test('host blocks both judging and MP3 playback without blocking OCR; release waits for a slot', async t => {
  const h = await fixture(t);
  h.state.host = true;
  await h.scan('ABC');
  assert.equal(h.inputs.length, 0);
  await h.time.at(3000); await h.scan('ABCD');
  h.state.host = false;
  assert.equal(h.inputs.length, 0);
  await h.time.at(9000); await h.settle();
  assert.equal(h.inputs[0].input, '<previous_ocr>\n\n</previous_ocr>\n<current_ocr>\nABCD\n</current_ocr>');
  h.configure({ mode: 'mp3' }); h.state.host = true;
  await h.scan('price');
  await h.time.at(18000);
  assert.equal(h.playback.length, 0);
  h.state.host = false;
  await h.time.at(27000); await h.settle();
  assert.equal(h.playback.length, 1);
});

test('stop/reselection discards stale judgment and starts with an empty raw baseline', async t => {
  const pending = deferred(); let count = 0;
  const h = await fixture(t, { judge: async () => ++count === 1 ? pending.promise : '无新问题' });
  await h.scan('old'); await until(() => h.inputs.length === 1);
  await h.bridge.command('onBarrageStop');
  await h.bridge.command('onBarrageStart', {});
  await until(() => h.state.generation >= 3);
  await h.scan('fresh');
  pending.resolve('obsolete'); await h.settle();
  assert.equal(h.answerInputs.length, 0);
  await h.time.at(9000); await h.settle();
  assert.equal(h.inputs[1].input, '<previous_ocr>\n\n</previous_ocr>\n<current_ocr>\nfresh\n</current_ocr>');
});

test('host cancels a boundary-waiting reply but retains successful baseline and cooldown cadence', async t => {
  const boundary = deferred(); let prepared = false, first = true;
  const h = await fixture(t, {
    judge: async () => 'price',
    beforeAudio: async () => { if (first) { first = false; prepared = true; await boundary.promise; } },
  });
  await h.scan('price'); await until(() => prepared);
  assert.equal(h.state.starts, 0);
  h.state.host = true; h.phase.barrageManager.stopSpeech();
  await h.time.at(6000); await h.scan('shipping');
  await h.time.at(9000);
  boundary.resolve(); await h.settle();
  h.state.host = false;
  assert.equal(h.state.starts, 0);
  assert.equal(h.inputs.length, 1);
  await h.time.at(18000); await h.settle();
  assert.match(h.inputs[1].input, /<previous_ocr>\nprice\n/);
  assert.match(h.inputs[1].input, /<current_ocr>\nshipping\n/);
  assert.equal(h.state.starts, 1);
});
