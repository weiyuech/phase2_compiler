import { readFile } from 'node:fs/promises';
import { DEFAULT_OCR_JUDGE_PROMPT } from './judge-prompt.js';

// Keep OCR text from closing or creating input delimiters.
const escapeText = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

// One in-flight judge and one replaceable newest capture. Reset invalidates
// callbacks without allowing an old session to change the new comparison text.
export class OcrTextJudge {
  constructor({ judge, promptPath, onText, onError }) {
    Object.assign(this, { judge, promptPath, onText, onError });
    this.epoch = 0;
    this.previous = '';
    this.pending = null;
    this.running = false;
  }
  reset() { this.epoch++; this.previous = ''; this.pending = null; }
  submit(text) {
    this.pending = { text: String(text || '').slice(0, 16000), epoch: this.epoch };
    if (!this.running) void this.drain();
  }
  async drain() {
    this.running = true;
    try {
      while (this.pending) {
        const item = this.pending;
        this.pending = null;
        try {
          let prompt = DEFAULT_OCR_JUDGE_PROMPT;
          if (this.promptPath) {
            try { prompt = (await readFile(this.promptPath, 'utf8')).trim() || prompt; }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
          }
          if (item.epoch !== this.epoch) continue;
          const input = `<previous_ocr>\n${escapeText(this.previous)}\n</previous_ocr>\n<current_ocr>\n${escapeText(item.text)}\n</current_ocr>`;
          const output = await this.judge(prompt, input);
          if (item.epoch !== this.epoch) continue;
          if (typeof output !== 'string' || !output.trim()) throw new Error('新增问题判断未返回有效文本');
          this.previous = item.text;
          // Only this exact signal (apart from surrounding whitespace) skips.
          // Do not reinterpret explanations, JSON, punctuation or model intent.
          if (output.trim() !== '无新问题') await this.onText(output.trim());
        } catch (error) {
          if (item.epoch === this.epoch) this.onError?.(error);
        }
      }
    } finally { this.running = false; }
  }
}
