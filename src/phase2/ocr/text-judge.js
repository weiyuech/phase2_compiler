import { readFile } from 'node:fs/promises';
import { DEFAULT_OCR_JUDGE_PROMPT, resolveOcrJudgePrompt } from './judge-prompt.js';

const escapeText = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

// Only the cooldown scheduler calls decide(). Scans and raw logging do not.
// The checkpoint is raw OCR from the last successful judge response (including
// 无新问题). Busy slots and failures never advance it.
export class OcrTextJudge {
  constructor({ judge, promptPath }) {
    Object.assign(this, { judge, promptPath });
    this.epoch = 0;
    this.decisionSnapshot = null;
  }

  get previous() { return this.decisionSnapshot?.text || ''; }

  reset() {
    this.epoch++;
    this.decisionSnapshot = null;
  }

  _commitSnapshot(observation) {
    this.decisionSnapshot = Object.freeze({
      text: String(observation.text || '').slice(0, 16000),
      snapshotId: observation.snapshotId ?? null,
      receivedAt: observation.receivedAt ?? null,
      capturedAt: observation.capturedAt ?? null,
    });
  }

  async decide(observation, { isCurrent = () => true } = {}) {
    const epoch = this.epoch;
    const valid = () => epoch === this.epoch && isCurrent();
    const snapshot = Object.freeze({
      text: String(observation.text || '').slice(0, 16000),
      snapshotId: observation.snapshotId ?? null,
      receivedAt: observation.receivedAt ?? null,
      capturedAt: observation.capturedAt ?? null,
    });
    const previousText = this.previous;
    let prompt = DEFAULT_OCR_JUDGE_PROMPT;
    if (this.promptPath) {
      try { prompt = resolveOcrJudgePrompt(await readFile(this.promptPath, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!valid()) return { ok: false, cancelled: true };
    const input = '<previous_ocr>\n' + escapeText(previousText.slice(0, 10000))
      + '\n</previous_ocr>\n<current_ocr>\n' + escapeText(snapshot.text.slice(0, 10000)) + '\n</current_ocr>';
    const output = await this.judge(prompt, input);
    if (!valid()) return { ok: false, cancelled: true };
    if (typeof output !== 'string' || !output.trim()) throw new Error('新增问题判断未返回有效文本');
    this._commitSnapshot(snapshot);
    const text = output.trim();
    return { ok: true, skipped: text === '无新问题', text: text === '无新问题' ? null : text };
  }
}
