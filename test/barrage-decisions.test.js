import test from 'node:test';
import assert from 'node:assert/strict';
import { BarrageDecisionClock } from '../src/phase2/barrage-decisions.js';
import { OcrTextJudge } from '../src/phase2/ocr/text-judge.js';
import { fakeClock, until, deferred } from './fixtures/decision-clock.js';

function fixture(t, options = {}) {
  const time = fakeClock(), calls = [], outputs = [];
  let busy = false;
  const judge = new OcrTextJudge({ judge: options.judge || (async (_system, input) => { calls.push(input); return '无新问题'; }) });
  const clock = new BarrageDecisionClock({
    ...time, isBusy: () => busy,
    onRound: async (snapshot, _config, context) => {
      const result = await judge.decide(snapshot, context);
      outputs.push(result);
      if (result.text) await options.play?.(result.text);
      return result;
    },
    ...options.clock,
  });
  clock.configure({ scan_interval: 3, cooldown: 9 });
  clock.start();
  t.after(() => clock.stop());
  return { clock, time, judge, calls, outputs, setBusy: value => { busy = value; },
    scan: text => clock.observe({ text, unchanged: false }) };
}

test('scans do not judge until next slot; compare cooldown snapshots, not neighboring scans', async t => {
  const h = fixture(t);
  h.scan('ABC'); await until(() => !h.clock.running);
  await h.time.at(3000); h.scan('ABCD');
  await h.time.at(6000); h.scan('BCDE');
  await h.time.at(8999); h.scan('EFGHJ');
  assert.equal(h.calls.length, 1);
  assert.equal(h.judge.previous, 'ABC');
  await h.time.at(9000); await until(() => !h.clock.running);
  assert.equal(h.calls[1], '<previous_ocr>\nABC\n</previous_ocr>\n<current_ocr>\nEFGHJ\n</current_ocr>');
  assert.equal(h.judge.previous, 'EFGHJ');
});

test('exact skip has no recovery and identical cached scans do not cause paid calls', async t => {
  const h = fixture(t);
  h.scan('ABC'); await until(() => !h.clock.running);
  for (const ms of [3000, 6000, 9000, 18000]) {
    h.clock.observe({ text: 'ABC', unchanged: true }); await h.time.at(ms);
  }
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.outputs.map(item => item.text), [null]);
});

test('preparation and playback skip slots, retain the baseline, and never catch up on completion', async t => {
  const preparation = deferred(), playing = deferred(), inputs = [];
  let stage = 'judge';
  const h = fixture(t, {
    judge: async (_system, input) => { inputs.push(input); return 'F'; },
    play: async () => { stage = 'preparing'; await preparation.promise; stage = 'playing'; await playing.promise; stage = 'finished'; },
  });
  h.scan('ABC'); await until(() => stage === 'preparing');
  await h.time.at(8000); h.scan('EFG');
  await h.time.at(9000);
  assert.equal(inputs.length, 1);
  assert.equal(h.judge.previous, 'ABC');
  preparation.resolve(); await until(() => stage === 'playing');
  await h.time.at(17000); h.scan('GHJ');
  await h.time.at(18000);
  assert.equal(h.judge.previous, 'ABC');
  playing.resolve(); await until(() => !h.clock.running);
  await h.time.at(20000); h.scan('JKL');
  assert.equal(inputs.length, 1, 'completion is not a reply opportunity');
  await h.time.at(27000); await until(() => !h.clock.running);
  assert.equal(inputs[1], '<previous_ocr>\nABC\n</previous_ocr>\n<current_ocr>\nJKL\n</current_ocr>');
});

test('slow judge freezes its pair; busy slots cannot consume later raw observations', async t => {
  const pending = deferred(), inputs = [];
  const h = fixture(t, { judge: (_system, input) => { inputs.push(input); return pending.promise; } });
  h.scan('ABC');
  await h.time.at(8000); h.scan('EFG');
  await h.time.at(9000);
  assert.equal(h.judge.previous, '');
  pending.resolve('无新问题'); await until(() => !h.clock.running);
  assert.equal(inputs[0], '<previous_ocr>\n\n</previous_ocr>\n<current_ocr>\nABC\n</current_ocr>');
  assert.equal(h.judge.previous, 'ABC');
});

test('host busy skips a slot without calling judge, and release waits for the next slot', async t => {
  const h = fixture(t);
  h.setBusy(true); h.scan('ABC');
  assert.equal(h.calls.length, 0);
  assert.equal(h.judge.previous, '');
  await h.time.at(3000); h.scan('ABCD'); h.setBusy(false);
  assert.equal(h.calls.length, 0);
  await h.time.at(9000); await until(() => !h.clock.running);
  assert.match(h.calls[0], /<previous_ocr>\n\n/);
});

test('blank replaces waiting input but never advances the judge baseline', async t => {
  const h = fixture(t);
  h.scan('ABC'); await until(() => !h.clock.running);
  await h.time.at(3000); h.scan('ABCD');
  await h.time.at(6000); h.scan('');
  await h.time.at(9000);
  assert.equal(h.calls.length, 1);
  assert.equal(h.judge.previous, 'ABC');
});

test('errors retry only once at a future slot, without baseline mutation or raw fallback', async t => {
  let count = 0;
  const h = fixture(t, { judge: async () => { count++; throw new Error('network'); } });
  h.scan('ABC'); await until(() => !h.clock.running);
  await h.time.at(9000); await until(() => !h.clock.running);
  await h.time.at(18000);
  assert.equal(count, 2);
  assert.equal(h.judge.previous, '');
  assert.equal(h.outputs.length, 0);
  h.scan('ABCD');
  await h.time.at(27000); await until(() => !h.clock.running);
  assert.equal(count, 3);
});

test('timer stalls do not replay missed slots, and timing changes schedule a future opportunity', async t => {
  const h = fixture(t);
  h.scan('ABC'); await until(() => !h.clock.running);
  h.scan('ABCD');
  h.time.jump(50000); h.clock.tick(); await until(() => !h.clock.running);
  assert.equal(h.calls.length, 2);
  assert.equal(h.clock.nextAt, 54000);
  h.clock.configure({ scan_interval: 3, cooldown: 12 });
  assert.equal(h.clock.nextAt, 62000);
  h.clock.stop();
  assert.equal(h.time.pendingTimers(), 0);
});
