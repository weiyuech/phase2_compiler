import fs from 'fs';

/**
 * PaddleOCR CTC greedy decoder.
 *
 * PaddleOCR CTC dictionaries do not include the blank class. The model output
 * class count is: blank + dictionary tokens + optional space char.
 */

export class CTCDecoder {
  constructor(dictPath, { useSpaceChar = true } = {}) {
    const tokens = this._loadDict(dictPath);
    this.character = ['blank', ...tokens];
    if (useSpaceChar) this.character.push(' ');
    this.dictPath = dictPath;
  }

  _loadDict(filePath) {
    const raw = fs.readFileSync(filePath, 'utf-8');
    if (raw.includes('<!DOCTYPE html') || raw.includes('<html')) {
      throw new Error(`OCR dictionary is an HTML page, not a raw PaddleOCR dictionary: ${filePath}`);
    }

    let lines = raw.split(/\r?\n/);
    
    // Remove last empty line if it exists (common in text files)
    if (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }

    console.log(`[Phase 2] [DEBUG] Loaded ${lines.length} tokens from dictionary`);

    if (lines.length < 1000) {
      throw new Error(`OCR dictionary looks too small (${lines.length} tokens): ${filePath}`);
    }

    return lines;
  }

  get size() {
    return this.character.length;
  }

  assertCompatible(numClasses) {
    if (this.size !== numClasses) {
      throw new Error(
        `OCR dictionary/model mismatch: dictionary has ${this.size} classes, model returned ${numClasses}`
      );
    }
  }

  decode(tensorData, dims) {
    if (!Array.isArray(dims) || dims.length !== 3) {
      throw new Error(`Unsupported OCR output dims: ${JSON.stringify(dims)}`);
    }

    const [batch, seqLen, numClasses] = dims;
    if (batch !== 1) {
      throw new Error(`Only batch size 1 is supported for OCR decode; got ${batch}`);
    }

    this.assertCompatible(numClasses);

    const chars = [];
    const probs = [];
    const indices = [];
    let lastIdx = -1;

    for (let t = 0; t < seqLen; t++) {
      let maxProb = -Infinity;
      let maxIdx = 0;

      for (let c = 0; c < numClasses; c++) {
        const val = tensorData[t * numClasses + c];
        if (val > maxProb) {
          maxProb = val;
          maxIdx = c;
        }
      }

      indices.push(maxIdx);

      if (maxIdx !== 0 && maxIdx !== lastIdx) {
        const char = this.character[maxIdx];
        if (char) {
          chars.push(char);
          probs.push(maxProb);
        }
      }

      lastIdx = maxIdx;
    }

    return {
      text: chars.join(''),
      score: probs.length ? probs.reduce((sum, val) => sum + val, 0) / probs.length : 0,
      indices
    };
  }
}
