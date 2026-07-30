/**
 * Phase 2 Sandbox Entry Point
 * 
 * This module allows for non-intrusive extension of Phase 1 functionality.
 * It hooks into events and provides a dedicated space for experimental logic.
 */

import { Phase2Monitor } from './monitor.js';
import { BarrageManager } from './barrage-manager.js';
import fs from 'fs';
import path from 'path';

// OCR 依赖 onnxruntime-node / sharp 两个 native 模块。静态 import 时，
// 只要目标机器上加载失败（缺 VC++ 运行库、打包遗漏平台二进制…），
// 整个模块图求值就会失败——后端在 uiBridge.start() 之前就死了，界面永远连不上。
// 改成惰性加载：加载失败只让弹幕 OCR 失效，其余功能照常。
// （tunnel.js 里的 @ngrok/ngrok 用的也是同一套写法。）
let _ocrModule      = null;
let _ocrUnavailable = false;   // 加载失败是永久性的（缺 native 模块），不要每帧重试
function loadOcr() {
  if (!_ocrModule) {
    _ocrModule = import('./ocr/index.js').catch(err => {
      _ocrUnavailable = true;
      throw err;
    });
  }
  return _ocrModule;
}

function extractNewContent(prev, next) {
  if (!prev) return next;
  if (!next) return '';

  const cleanPrev = prev.trim();
  const cleanNext = next.trim();

  if (cleanPrev === cleanNext) return '';

  const maxLen = Math.min(cleanPrev.length, cleanNext.length);
  let overlapLen = 0;

  // Search for matching overlap of length 'len' from maxLen down to 2
  for (let len = maxLen; len >= 2; len--) {
    const suffix = cleanPrev.slice(-len);
    const prefix = cleanNext.slice(0, len);
    if (suffix === prefix) {
      overlapLen = len;
      break;
    }
  }

  if (overlapLen > 0) {
    return cleanNext.slice(overlapLen).trim();
  }

  return cleanNext;
}

function checkOverlap(prev, next) {
  if (!prev || !next) return false;
  const cleanPrev = prev.trim();
  const cleanNext = next.trim();
  if (cleanPrev === cleanNext) return true;

  const maxLen = Math.min(cleanPrev.length, cleanNext.length);
  for (let len = maxLen; len >= 2; len--) {
    if (cleanPrev.slice(-len) === cleanNext.slice(0, len)) {
      return true;
    }
  }
  return false;
}

export function initPhase2({ robot, tour, llm, tts, uiBridge, transitAudio, checkGoalHandling, checkIsSpeaking, onBarrageSpeechStart, onBarrageSpeechEnd }) {
  console.log('---------------------------------------------------------');
  console.log('[Phase 2] Sandbox Initialised');
  console.log('---------------------------------------------------------');

  const monitor = new Phase2Monitor({ robot, tour, llm });
  const barrageManager = new BarrageManager({ tts, llm, tour, uiBridge, checkGoalHandling, checkIsSpeaking, onBarrageSpeechStart, onBarrageSpeechEnd });

  // Initialize the Node.js OCR engine
  loadOcr()
    .then(ocr => ocr.initOcr())
    .catch(err => {
      console.error('[Phase 2] [OCR] 引擎加载失败，弹幕识别不可用（其余功能不受影响）:', err.message);
    });

  const USER_DATA = process.env.USER_DATA_DIR;
  const DATA_DIR = USER_DATA ? path.join(USER_DATA, 'data') : './data';
  const logPath = path.join(DATA_DIR, 'barrage-ocr-log.txt');

  let lastLoggedText = null;
  let lastFullOcrText = null;

  function appendOcrLog(text) {
    if (!text || !text.trim()) return;
    if (text === lastLoggedText) return;
    lastLoggedText = text;

    try {
      const timestamp = new Date().toLocaleString('zh-CN', { hour12: false });
      fs.appendFileSync(logPath, `[${timestamp}] ${text}\n`, 'utf8');
    } catch (err) {
      console.error('[Phase 2] Failed to write to OCR log:', err.message);
    }
  }

  let isProcessingBarrage = false;
  let framesProcessed = 0;
  let lastHeartbeat = Date.now();

  // -- Hook into Phase 2 Barrage UI Commands --
  uiBridge.on('onBarrageStart', (rect) => {
    console.log(`[Phase 2] Barrage OCR tracking STARTED on region:`, rect);
    lastLoggedText = null;
    lastFullOcrText = null;
    barrageManager.isActive = true;
    barrageManager.mp3Count = 0;
    barrageManager.llmCount = 0;
    uiBridge.broadcast('BARRAGE_LOG', { text: '弹幕识别已启动，开始记录日志...' });

    // Overwrite / clear the past log file
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(logPath, '', 'utf8');
      console.log(`[Phase 2] Truncated barrage OCR log file: ${logPath}`);
    } catch (err) {
      console.error('[Phase 2] Failed to initialize log file:', err.message);
    }
  });

  uiBridge.on('onBarrageStop', () => {
    console.log(`[Phase 2] Barrage OCR tracking STOPPED`);
    isProcessingBarrage = false;
    barrageManager.stop();
    // Clear manager's deduplication state when stopped
    barrageManager.lastRecognizedText = null;

    const summaryText = `弹幕识别已关闭。本次运行累计播报 MP3 语音包 ${barrageManager.mp3Count} 次，LLM 语音合成 ${barrageManager.llmCount} 次。`;
    uiBridge.broadcast('BARRAGE_LOG', { text: summaryText });
  });

  let lastDebugSave = 0;
  uiBridge.on('onBarrageTextRead', (text) => {
    // Legacy fallback, in case UI sends text directly
    console.log(`[Phase 2] OCR Output (from UI):`, text);
    if (text) {
      appendOcrLog(text);
    }
    barrageManager.handleOcrText(text).catch(err => {
      console.error('[Phase 2] BarrageManager text processing failed:', err.message);
    });
  });

  uiBridge.on('onBarrageImage', async (data) => {
    if (!barrageManager.isActive) return;
    if (_ocrUnavailable) return;     // OCR 引擎加载失败过：直接丢帧，别每秒重试+刷日志
    if (isProcessingBarrage) return; // Drop frame instead of piling up
    isProcessingBarrage = true;

    try {
      // Support both raw Buffer (binary) and Base64 string (fallback)
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'base64');

      // 1. Save debug image occasionally
      const now = Date.now();
      if (now - lastDebugSave > 5000) {
        lastDebugSave = now;
        const debugPath = path.resolve('./data/debug-ocr-crop.png');
        fs.writeFileSync(debugPath, buffer);
      }

      // 2. Process image with Node.js OCR engine
      const { recognizeText } = await loadOcr();
      const result = await recognizeText(buffer);
      framesProcessed++;

      // 3. Status Heartbeat (Logs every 5 seconds so you know it's not dead)
      if (now - lastHeartbeat > 5000) {
        console.log(`[Phase 2] [Status] OCR loop alive. Processed ${framesProcessed} frames so far.`);
        lastHeartbeat = now;
      }

      const text = result?.text;
      if (text) {
        // Broadcast the raw full text to UI for current display box
        uiBridge.broadcast('BARRAGE_CURRENT_TEXT', { text });

        const newText = extractNewContent(lastFullOcrText, text);

        // Continuous 1Hz logging: log if there's new incremental text
        if (newText && newText.trim()) {
          console.log(`[Phase 2] [OCR Result - New]:`, newText);
          appendOcrLog(newText);
          uiBridge.broadcast('BARRAGE_TEXT_READ', { text: newText });
        }

        // Playback Trigger: feed payload to BarrageManager if host is quiet.
        // If host is speaking, we defer updating lastFullOcrText so the next quiet frame can catch and reply to it.
        const isHostSpeaking = checkIsSpeaking && checkIsSpeaking();
        if (!isHostSpeaking) {
          const hasOverlap = checkOverlap(lastFullOcrText, text);
          const playbackPayload = hasOverlap ? newText : text;

          if (playbackPayload && playbackPayload.trim()) {
            console.log(`[Phase 2] [Playback Trigger]: Feeding "${playbackPayload}" to BarrageManager`);
            barrageManager.handleOcrText(playbackPayload).catch(err => {
              console.error('[Phase 2] BarrageManager text processing failed:', err.message);
            });
          }

          lastFullOcrText = text;
        }
      }
    } catch (err) {
      console.error('[Phase 2] [OCR] Pipeline error:', err.message);
    } finally {
      // Bulletproof Lock Release: This ALWAYS runs, even if OCR crashes
      isProcessingBarrage = false;
    }
  });

  return {
    monitor,
    barrageManager
  };
}
