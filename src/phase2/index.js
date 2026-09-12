/**
 * Phase 2 Sandbox Entry Point
 * 
 * This module allows for non-intrusive extension of Phase 1 functionality.
 * It hooks into events and provides a dedicated space for experimental logic.
 */

import { Phase2Monitor } from './monitor.js';
import { BarrageManager } from './barrage-manager.js';
import path from 'path';
import { BoundedOcrTextLog } from './ocr/text-log.js';
import { CommentHistory } from './ocr/comment-history.js';

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

export function initPhase2({ robot, tour, llm, tts, uiBridge, transitAudio, checkGoalHandling, checkIsSpeaking, onBarrageSpeechStart, onBarrageSpeechEnd }) {
  console.log('---------------------------------------------------------');
  console.log('[Phase 2] Sandbox Initialised');
  console.log('---------------------------------------------------------');

  const monitor = new Phase2Monitor({ robot, tour, llm });
  let barrageSpeechActive = false;
  let ocrTrackingActive = false;
  let ocrSessionEpoch = 0;
  let ocrWorkerGeneration = null;
  let ocrDestroyed = false;

  const setOcrPlaybackPaused = (paused) => {
    loadOcr()
      .then(ocr => ocr.setOcrPaused(paused))
      .catch(err => disableOcr(err));
  };

  const barrageManager = new BarrageManager({
    tts,
    llm,
    tour,
    uiBridge,
    checkGoalHandling,
    checkIsSpeaking,
    onBarrageSpeechStart: () => {
      barrageSpeechActive = true;
      if (ocrTrackingActive) setOcrPlaybackPaused(true);
      onBarrageSpeechStart?.();
    },
    onBarrageSpeechEnd: () => {
      barrageSpeechActive = false;
      if (ocrTrackingActive) setOcrPlaybackPaused(false);
      onBarrageSpeechEnd?.();
    },
  });

  // Initialize the Node.js OCR engine
  let ocrLoadError = null;
  let ocrFailureReported = false;

  function disableOcr(error) {
    if (ocrDestroyed) return;
    _ocrUnavailable = true;
    if (ocrFailureReported) return;
    ocrFailureReported = true;
    ocrLoadError = error?.message || String(error);
    ocrTrackingActive = false;
    ocrWorkerGeneration = null;
    ocrSessionEpoch += 1;
    barrageManager.stop();

    const msg = `弹幕识别不可用：OCR 引擎失败（${ocrLoadError}）。其余功能不受影响。`;
    console.error(`[Phase 2] [OCR] ${msg}`);
    uiBridge.broadcast('ERROR', { message: msg });
    uiBridge.broadcast('BARRAGE_LOG', { text: msg });
    // Keep this last: a failed asynchronous start must leave the UI/capture off.
    uiBridge.broadcast('BARRAGE_STOP', {});
  }

  loadOcr()
    .then(ocr => ocr.initOcr())
    .catch(err => disableOcr(err));

  const USER_DATA = process.env.USER_DATA_DIR;
  const DATA_DIR = USER_DATA ? path.join(USER_DATA, 'data') : './data';
  const logPath = path.join(DATA_DIR, 'barrage-ocr-log.txt');
  const ocrTextLog = new BoundedOcrTextLog({ filePath: logPath });

  let lastLoggedText = null;
  const commentHistory = new CommentHistory();

  function appendOcrLog(text) {
    if (!text || !text.trim()) return;
    if (text === lastLoggedText) return;
    lastLoggedText = text;

    const timestamp = new Date().toLocaleString('zh-CN', { hour12: false });
    ocrTextLog.append(`[${timestamp}] ${text}\n`);
  }

  let framesProcessed = 0;
  let lastHeartbeat = Date.now();

  function startOcrTrackingSession() {
    if (ocrDestroyed) return;
    const epoch = ++ocrSessionEpoch;
    ocrTrackingActive = true;
    ocrWorkerGeneration = null;
    loadOcr()
      .then(async (ocr) => {
        if (!ocrTrackingActive || epoch !== ocrSessionEpoch) return;
        await ocr.initOcr();
        if (!ocrTrackingActive || epoch !== ocrSessionEpoch) return;
        const generation = ocr.startOcrSession();
        ocrWorkerGeneration = generation;
        if (barrageSpeechActive) ocr.setOcrPaused(true);
      })
      .catch(err => disableOcr(err));
  }

  function stopOcrTrackingSession() {
    ocrTrackingActive = false;
    ocrWorkerGeneration = null;
    ocrSessionEpoch += 1;
    loadOcr()
      .then(ocr => ocr.stopOcrSession())
      .catch(err => {
        if (!_ocrUnavailable) disableOcr(err);
      });
  }

  // -- Hook into Phase 2 Barrage UI Commands --
  uiBridge.on('onBarrageStart', (rect) => {
    // OCR 引擎没加载起来就直说，别让用户对着一个"已开启"却毫无反应的界面等
    if (_ocrUnavailable) {
      const msg = `弹幕识别无法启动：OCR 引擎不可用（${ocrLoadError || '加载失败'}）。请导出诊断日志发给技术支持。`;
      console.error(`[Phase 2] ${msg}`);
      uiBridge.broadcast('ERROR', { message: msg });
      uiBridge.broadcast('BARRAGE_LOG', { text: msg });
      uiBridge.broadcast('BARRAGE_STOP', {});   // 让界面的开关回到关闭状态
      return false;
    }
    console.log(`[Phase 2] Barrage OCR tracking STARTED on region:`, rect);
    lastLoggedText = null;
    commentHistory.reset();
    barrageManager.isActive = true;
    barrageManager.mp3Count = 0;
    barrageManager.llmCount = 0;
    startOcrTrackingSession();
    uiBridge.broadcast('BARRAGE_LOG', { text: '弹幕识别已启动，开始记录日志...' });

    // Reset is ordered with later appends but never blocks the audio event loop.
    ocrTextLog.reset();
    return true;
  });

  uiBridge.on('onBarrageStop', () => {
    console.log(`[Phase 2] Barrage OCR tracking STOPPED`);
    stopOcrTrackingSession();
    barrageManager.stop();
    // Clear manager's deduplication state when stopped
    barrageManager.lastRecognizedText = null;

    const summaryText = `弹幕识别已关闭。本次运行累计播报 MP3 语音包 ${barrageManager.mp3Count} 次，LLM 语音合成 ${barrageManager.llmCount} 次。`;
    uiBridge.broadcast('BARRAGE_LOG', { text: summaryText });
  });

  uiBridge.on('onBarrageTextRead', (text) => {
    // Legacy fallback, in case UI sends text directly
    console.log(`[Phase 2] OCR Output (from UI):`, text);
    if (!barrageManager.isActive || checkIsSpeaking?.()) return;
    const newText = commentHistory.extract(String(text || '').split(/\n/));
    if (newText) appendOcrLog(newText);
    barrageManager.handleOcrText(newText).catch(err => {
      console.error('[Phase 2] BarrageManager text processing failed:', err.message);
    });
  });

  uiBridge.on('onBarrageImage', async (data) => {
    if (!barrageManager.isActive || !ocrTrackingActive) return;
    if (_ocrUnavailable) return;     // OCR 引擎加载失败过：直接丢帧，别每秒重试+刷日志
    const sessionEpoch = ocrSessionEpoch;
    const workerGeneration = ocrWorkerGeneration;
    if (workerGeneration === null) return;

    try {
      // Support both raw Buffer (binary) and Base64 string (fallback)
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'base64');
      const { recognizeText } = await loadOcr();
      const result = await recognizeText(buffer, { generation: workerGeneration });

      // A stop/reselection, a newer OCR session, or active barrage speech makes
      // this result stale. While speech is active the worker client retains only
      // the newest pending screenshot and resumes it after playback.
      if (
        !ocrTrackingActive ||
        !barrageManager.isActive ||
        sessionEpoch !== ocrSessionEpoch ||
        workerGeneration !== ocrWorkerGeneration ||
        barrageSpeechActive
      ) return;

      framesProcessed++;

      // Status heartbeat (not a per-frame log).
      const now = Date.now();
      if (now - lastHeartbeat > 5000) {
        console.log(`[Phase 2] [Status] OCR loop alive. Processed ${framesProcessed} frames so far.`);
        lastHeartbeat = now;
      }

      const text = result?.text;
      if (text) {
        // Broadcast the raw full text to UI for current display box
        uiBridge.broadcast('BARRAGE_CURRENT_TEXT', { text });

        // Do not consume comments while the host blocks replies. The worker
        // returns cached recognition for unchanged images after the host stops.
        if (checkIsSpeaking?.()) return;
        const newText = commentHistory.extract(result.lines || text.split(/\n/));

        // Log only newly observed comments.
        if (newText && newText.trim()) {
          console.log(`[Phase 2] [OCR Result - New]:`, newText);
          appendOcrLog(newText);
          uiBridge.broadcast('BARRAGE_TEXT_READ', { text: newText });
        }

        // Playback Trigger: feed payload to BarrageManager if host is quiet.
        // The history above is only advanced while the host is quiet.
        const isHostSpeaking = checkIsSpeaking && checkIsSpeaking();
        if (!isHostSpeaking) {
          const playbackPayload = newText;

          if (playbackPayload && playbackPayload.trim()) {
            console.log(`[Phase 2] [Playback Trigger]: Feeding "${playbackPayload}" to BarrageManager`);
            barrageManager.handleOcrText(playbackPayload).catch(err => {
              console.error('[Phase 2] BarrageManager text processing failed:', err.message);
            });
          }

        }
      }
    } catch (err) {
      if (err?.ocrFatal) {
        disableOcr(err);
        return;
      }
      console.error('[Phase 2] [OCR] Pipeline error:', err.message);
    }
  });

  return {
    monitor,
    barrageManager,
    async destroy() {
      if (ocrDestroyed) return;
      ocrDestroyed = true;
      ocrTrackingActive = false;
      ocrWorkerGeneration = null;
      ocrSessionEpoch += 1;
      barrageManager.stop();
      try {
        const ocr = await loadOcr();
        await ocr.shutdownOcr();
      } catch {
        // Native OCR may be exactly why shutdown is running. Other subsystems
        // must still be allowed to finish their cleanup.
      }
      await ocrTextLog.close();
    },
  };
}
