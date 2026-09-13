// Local synthetic PNG -> real native OCR -> production barrage routing.
// Judge/answer/audio are controlled stubs. No paid API, OS capture or robot I/O.
// node scripts/eval-ocr-workflow.mjs [--report /tmp/ocr-workflow.json]
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { OcrWorkerClient } from '../src/phase2/ocr/index.js';
import { initPhase2 } from '../src/phase2/index.js';
import { barrageProvider } from '../src/knowledge/barrage-provider.js';
import { fakeClock, until } from '../test/fixtures/decision-clock.js';

const option = name => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined;
if (option('--settings')) throw new Error('Use eval-ocr-judge-live.mjs for explicitly opted-in live API testing.');
const directory = await mkdtemp(join(tmpdir(), 'ocr-native-workflow-'));
const savedData = process.env.USER_DATA_DIR;
process.env.USER_DATA_DIR = directory;
const savedConfig = barrageProvider.getConfig;
barrageProvider.getConfig = async () => ({ mode: 'llm-general', scan_interval: 3, cooldown: 9 });
const client = new OcrWorkerClient({ debugImagePath: null });
const time = fakeClock(), calls = [], answers = [], recognitions = [], checks = [];
const hash = value => createHash('sha256').update(value).digest('hex');
const check = (value, label) => { checks.push({ pass: Boolean(value), label }); assert.ok(value, label); };
class Bridge extends EventEmitter {
  broadcast() {}
  async command(type, data) { for (const handler of this.listeners(type)) await handler(data); }
}
const bridge = new Bridge();
let host = false, phase;
const capture = async lines => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="380"><rect width="100%" height="100%" fill="white"/>'
    + lines.map((line, index) => '<text x="28" y="' + (55 + index * 57) + '" font-size="36" font-family="PingFang SC,Microsoft YaHei,sans-serif" fill="black">' + line + '</text>').join('') + '</svg>';
  return sharp(Buffer.from(svg)).png().toBuffer();
};
const screenshot = async image => {
  await bridge.command('onBarrageImage', image);
  await until(() => !phase.decisionClock.running);
  return recognitions.at(-1);
};
try {
  phase = initPhase2({
    robot: new EventEmitter(), tour: new EventEmitter(), uiBridge: bridge,
    checkIsSpeaking: () => host, decisionOptions: time,
    llm: {
      judgeOcr: async (_prompt, input) => { calls.push(input); return calls.length === 1 ? '无新问题' : '小方：运费多少？'; },
      rewriteBarrage: async (_prompt, input) => { answers.push(input); return '测试回答。'; },
    },
    tts: { player: { isPlaying: () => false }, stop() {}, speak: async (_text, opts) => {
      opts.onPrepared?.();
      if (opts.beforePlay?.() === false || opts.onAudioStart?.() === false) return { ok: false, aborted: true };
      return { ok: true };
    } },
    ocrLoader: async () => ({
      initOcr: () => client.init(),
      startOcrSession: () => client.startSession(),
      stopOcrSession: () => client.stopSession(),
      shutdownOcr: () => client.shutdown(),
      recognizeText: async (image, options) => {
        const result = await client.recognize(image, options);
        recognitions.push({ result, sha256: hash(image) });
        return result;
      },
    }),
  });
  await client.init();
  await bridge.command('onBarrageStart', {});
  await until(() => client.sessionActive);
  const firstImage = await capture(['小安：多少钱？', '小陈：中午发货吗？']);
  const first = await screenshot(firstImage);
  check(first.result.lines.length >= 2, 'real native OCR recognizes synthetic text lines');
  check(calls.length === 1 && answers.length === 0, 'exact 无新问题 skips answer/audio');
  const same = await screenshot(firstImage);
  check(same.result.unchanged === true && calls.length === 1, 'image equality reuses OCR without another judge');
  await time.at(3000);
  await screenshot(await capture(['小安：多少钱？', '小陈：中午发货吗？', '小方：运费多少？']));
  await time.at(6000);
  const current = await screenshot(await capture(['小陈：中午发货吗？', '小方：运费多少？', '小李：有黑色吗？']));
  check(calls.length === 1, 'intermediate real OCR remains independent of judge cooldown');
  const before = first.result.lines.join('\n'), latest = current.result.lines.join('\n');
  await time.at(9000); await until(() => !phase.decisionClock.running);
  check(calls[1] === '<previous_ocr>\n' + before + '\n</previous_ocr>\n<current_ocr>\n' + latest + '\n</current_ocr>',
    'judge compares last decision raw OCR against latest raw OCR');
  const observations = client.observations;
  check(observations.length === 2, 'only two completed PNG/raw observations retained');
  for (const observation of observations) {
    check(recognitions.some(item => item.result.snapshotId === observation.snapshotId && item.sha256 === hash(observation.image)
      && item.result.lines.join('\n') === observation.rawText), 'PNG is paired with its raw OCR result');
  }
  host = true;
  await time.at(12000);
  const newer = await screenshot(await capture(['小方：运费多少？', '小李：有黑色吗？', '小王：支持退货吗？']));
  await time.at(18000);
  check(calls.length === 2, 'host-busy slot skips judge but not native OCR');
  host = false;
  await time.at(27000); await until(() => !phase.decisionClock.running);
  check(calls[2] === '<previous_ocr>\n' + latest + '\n</previous_ocr>\n<current_ocr>\n' + newer.result.lines.join('\n') + '\n</current_ocr>',
    'busy skip leaves successful judge baseline intact');
  await phase.destroy();
  check(client.observations.length === 0, 'shutdown releases raw screenshot history');
  const log = await readFile(join(directory, 'data', 'barrage-ocr-log.txt'), 'utf8');
  check(log.includes(before) && log.includes(latest) && log.includes(newer.result.lines.join('\n')), 'interval OCR raw text is logged even during cooldown/host busy');
  check(log.split('] ').length - 1 === 4, 'cached equal-image result is not logged as a fresh inference');
  const report = { generatedAt: new Date().toISOString(), checks, passed: checks.length,
    scope: 'Real native OCR with synthetic images and production Phase 2 routing; controlled judge/answer/audio and virtual cooldown clock. No external API or robot.',
    ocr: recognitions.map(item => ({ ...item.result, sha256: item.sha256 })), calls, answers };
  if (option('--report')) await writeFile(option('--report'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  process.stdout.write(JSON.stringify({ passed: checks.length, total: checks.length, realOcr: true, liveLlm: false }) + '\n');
} finally {
  await phase?.destroy();
  await client.shutdown();
  barrageProvider.getConfig = savedConfig;
  if (savedData === undefined) delete process.env.USER_DATA_DIR; else process.env.USER_DATA_DIR = savedData;
  await rm(directory, { recursive: true, force: true });
}
