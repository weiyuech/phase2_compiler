// Opt-in live API evaluation. No OCR capture, speech synthesis or robot I/O.
// node scripts/eval-ocr-judge-live.mjs --settings /path/to/settings.local.json --rounds 2 --report /tmp/judge-results.json
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LLMRewriter } from '../src/llm/index.js';
import { OcrTextJudge } from '../src/phase2/ocr/text-judge.js';
import { DEFAULT_OCR_JUDGE_PROMPT } from '../src/phase2/ocr/judge-prompt.js';
import { BarrageManager } from '../src/phase2/barrage-manager.js';
import { barrageProvider } from '../src/knowledge/barrage-provider.js';
import { OCR_JUDGE_FLOW, OCR_JUDGE_PAIRS } from '../test/fixtures/ocr-judge-cases.js';

const option = name => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};

async function main() {
  const settingsPath = option('--settings');
  const rounds = Number(option('--rounds') || 1);
  if (!settingsPath || !Number.isInteger(rounds) || rounds < 1 || rounds > 3) {
    throw new Error('Specify --settings and optionally --rounds 1..3 / --report. This explicitly opts into API calls.');
  }
  const config = JSON.parse(await readFile(settingsPath, 'utf8')).llm;
  if (config?.provider !== 'doubao' || !config.api_key || !config.model) throw new Error('Configured Doubao LLM settings required');
  const llm = new LLMRewriter({ DOUBAO_API_KEY: config.api_key, DOUBAO_MODEL: config.model,
    LLM_TIMEOUT_MS: String(config.timeout_ms || 20000), LLM_MAX_TOKENS: '500' });
  // A failed test must not silently use another account/model from the shell.
  llm.fallback = { name: 'disabled-eval-fallback', rewriteCustom: async () => { throw new Error('disabled'); } };
  const directory = await mkdtemp(join(tmpdir(), 'ocr-judge-live-'));
  const originalGetConfig = barrageProvider.getConfig;
  const savedConsole = { log: console.log, warn: console.warn, error: console.error };
  const providerErrors = [];
  // Never echo a provider error body (or settings file) containing credentials.
  console.log = () => {};
  console.warn = () => {};
  console.error = (...args) => {
    const text = args.map(String).join(' ');
    const status = text.match(/接口错误\s+(\d+)/)?.[1];
    const code = text.match(/"code"\s*:\s*"([A-Za-z0-9_.-]+)"/)?.[1];
    if (status || code || text.includes('timeout')) providerErrors.push({ status: status ? Number(status) : undefined, code, timeout: text.includes('timeout') });
  };
  barrageProvider.getConfig = async () => ({ mode: 'llm-strict', cooldown: 0 });
  const answerInputs = [];
  const manager = new BarrageManager({
    llm: { rewriteBarrage: async (_system, user) => {
      answerInputs.push(user.match(/<barrage_text>\n([\s\S]*?)\n<\/barrage_text>/)?.[1]);
      return '测试占位回答';
    } },
    tts: { player: { isPlaying: () => false }, stop() {}, speak: async (_text, opts) => {
      opts.onPrepared?.();
      if (opts.beforePlay?.() === false || opts.onAudioStart?.() === false) return { ok: false, aborted: true };
      return { ok: true };
    } }, uiBridge: { broadcast() {} }, checkIsSpeaking: () => false,
  });
  manager.configDir = directory; // No personal answer prompt/document is read.
  manager.isActive = true;
  const results = [];
  let output, judgeError;
  const judge = new OcrTextJudge({
    judge: async (system, user) => {
      assert.equal(system, DEFAULT_OCR_JUDGE_PROMPT);
      assert.match(user, /^<previous_ocr>\n[\s\S]*\n<\/previous_ocr>\n<current_ocr>\n[\s\S]*\n<\/current_ocr>$/);
      output = await llm.judgeOcr(system, user);
      return output;
    },
  });
  try {
    process.stdout.write(JSON.stringify({ provider: config.provider, model: config.model, rounds, casesPerRound: OCR_JUDGE_FLOW.length + OCR_JUDGE_PAIRS.length }) + '\n');
    let apiFailed = false;
    for (let round = 1; round <= rounds && !apiFailed; round++) {
      judge.reset();
      for (const item of [...OCR_JUDGE_FLOW, ...OCR_JUDGE_PAIRS]) {
        if ('previous' in item) { judge.reset(); judge._commitSnapshot({ text: item.previous }); }
        const previous = judge.previous;
        const answerCount = answerInputs.length;
        const startedAt = performance.now();
        output = null; judgeError = null;
        try {
          const decision = await judge.decide({ text: item.current });
          if (decision.ok && !decision.skipped) {
            await manager.handleOcrText(decision.text, { requireReady: true, externalCadence: true });
          }
        } catch (error) { judgeError = error; }
        const forwarded = answerInputs.slice(answerCount);
        const routingOk = !judgeError && judge.previous === item.current && (output?.trim() === '无新问题'
          ? forwarded.length === 0 : forwarded.length === 1 && forwarded[0] === output?.trim());
        const result = { round, id: item.id, previous, current: item.current, expected: item.expected,
          output, forwarded, routingOk, pass: routingOk && output?.trim() === item.expected,
          elapsedMs: Math.round(performance.now() - startedAt), apiError: !!judgeError };
        results.push(result);
        process.stdout.write(JSON.stringify({ round, id: item.id, pass: result.pass, routingOk, output, elapsedMs: result.elapsedMs }) + '\n');
        if (judgeError) { apiFailed = true; break; }
      }
    }
    const report = { generatedAt: new Date().toISOString(), provider: config.provider, model: config.model,
      temperature: 0.7, maxTokens: 500, timeoutMs: llm.timeoutMs, prompt: DEFAULT_OCR_JUDGE_PROMPT,
      passed: results.filter(result => result.pass).length, total: results.length, providerErrors, results,
      scope: 'Real OCR-judge API and application text routing; answer LLM/TTS are stubs; synthetic text only.' };
    if (option('--report')) await writeFile(option('--report'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    process.stdout.write(JSON.stringify({ passed: report.passed, total: report.total, providerErrors }) + '\n');
    return report.total === rounds * (OCR_JUDGE_FLOW.length + OCR_JUDGE_PAIRS.length) && report.passed === report.total ? 0 : 1;
  } finally {
    manager.stop();
    barrageProvider.getConfig = originalGetConfig;
    Object.assign(console, savedConsole);
    await rm(directory, { recursive: true, force: true });
  }
}

try {
  // All actual requests/report writes have finished before this CLI exits.
  process.exit(await main());
} catch {
  process.stderr.write('Live judge evaluation failed before completion; no credentials or provider response body were printed.\n');
  process.exit(1);
}
