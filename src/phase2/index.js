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
import { OcrTextJudge } from './ocr/text-judge.js';
import { BarrageDecisionClock } from './barrage-decisions.js';
import { barrageProvider } from '../knowledge/barrage-provider.js';

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

export function initPhase2({ robot, tour, llm, tts, uiBridge, transitAudio, checkGoalHandling, checkIsSpeaking, onBarrageSpeechStart, onBarrageSpeechEnd, ocrLoader = loadOcr, decisionOptions = {} }) {
  console.log('---------------------------------------------------------');
  console.log('[Phase 2] Sandbox Initialised');
  console.log('---------------------------------------------------------');

  const monitor = new Phase2Monitor({ robot, tour, llm });
  let barrageSpeechActive = false;
  let ocrTrackingActive = false;
  let ocrSessionEpoch = 0;
  let ocrWorkerGeneration = null;
  let ocrDestroyed = false;
  let barrageConfig = null;
  let configEpoch = 0;
  let observationCounter = 0;

  const barrageManager = new BarrageManager({
    tts,
    llm,
    tour,
    uiBridge,
    checkGoalHandling,
    checkIsSpeaking,
    onCancel: reason => {
      if (reason === 'host') decisionClock.invalidateCurrent();
      else { textJudge.reset(); decisionClock.reset(); }
    },
    onBarrageSpeechStart: () => {
      barrageSpeechActive = true;
      onBarrageSpeechStart?.();
    },
    onBarrageSpeechEnd: () => {
      barrageSpeechActive = false;
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
    decisionClock.stop();
    textJudge.reset();
    barrageManager.stop();

    const msg = `弹幕识别不可用：OCR 引擎失败（${ocrLoadError}）。其余功能不受影响。`;
    console.error(`[Phase 2] [OCR] ${msg}`);
    uiBridge.broadcast('ERROR', { message: msg });
    uiBridge.broadcast('BARRAGE_LOG', { text: msg });
    // Keep this last: a failed asynchronous start must leave the UI/capture off.
    uiBridge.broadcast('BARRAGE_STOP', {});
  }

  ocrLoader()
    .then(ocr => ocr.initOcr())
    .catch(err => disableOcr(err));

  const USER_DATA = process.env.USER_DATA_DIR;
  const DATA_DIR = USER_DATA ? path.join(USER_DATA, 'data') : './data';
  const logPath = path.join(DATA_DIR, 'barrage-ocr-log.txt');
  const ocrTextLog = new BoundedOcrTextLog({ filePath: logPath });

  const textJudge = new OcrTextJudge({
    judge: (system, user) => llm.judgeOcr(system, user),
    promptPath: path.join(process.env.USER_DATA_DIR || '.', 'config', 'barrage-prompt-judge.txt'),
  });
  const decisionClock = new BarrageDecisionClock({
    ...decisionOptions,
    isBusy: () => !barrageManager.canAcceptReply() || barrageSpeechActive,
    onRound: async (snapshot, config, { isCurrent }) => {
      if (!isCurrent() || !barrageManager.canAcceptReply()) return { ok: false };
      let text = snapshot.text;
      if (config.mode !== 'mp3') {
        const result = await textJudge.decide(snapshot, {
          isCurrent: () => isCurrent() && barrageManager.canAcceptReply(),
        });
        if (!result.ok || result.skipped) return result;
        text = result.text;
      }
      if (!isCurrent() || !barrageManager.canAcceptReply()) return { ok: false };
      uiBridge.broadcast('BARRAGE_TEXT_READ', { text });
      await barrageManager.handleOcrText(text, { config, isCurrent, requireReady: true, externalCadence: true });
      return { ok: true };
    },
    onError: (_error, { retrying } = {}) => uiBridge.broadcast('BARRAGE_LOG', {
      text: retrying ? '弹幕处理失败，将在下次冷却机会重试。' : '弹幕处理失败，本轮已跳过；请检查配置。',
    }),
  });

  function configureBarrage(config) {
    configEpoch++;
    if (barrageConfig && (barrageConfig.mode || 'llm-strict') !== (config.mode || 'llm-strict')) {
      barrageManager.cancelPendingSpeech();
    }
    barrageConfig = { ...config };
    decisionClock.configure(config);
  }

  // Raw OCR logging is independent of the judge and both playback modes.
  // Log every actual inference (including a blank), not cached image-gate hits.
  function appendOcrLog(text) {
    const timestamp = new Date().toLocaleString('zh-CN', { hour12: false });
    ocrTextLog.append('[' + timestamp + '] ' + (text.trim() || '[无文字]') + '\n');
  }

  async function routeObservation(observation, { log = true } = {}) {
    if (!barrageManager.isActive || ocrDestroyed) return;
    if (log && !observation.unchanged) appendOcrLog(observation.text);
    const sequence = ++observationCounter;
    const epoch = ocrSessionEpoch;
    const settingsEpoch = configEpoch;
    const config = await barrageProvider.getConfig();
    if (sequence !== observationCounter || epoch !== ocrSessionEpoch || !barrageManager.isActive || ocrDestroyed) return;
    if (settingsEpoch === configEpoch) configureBarrage(config);
    decisionClock.observe(observation);
  }

  let framesProcessed = 0;
  let lastHeartbeat = Date.now();

  function startOcrTrackingSession() {
    if (ocrDestroyed) return;
    const epoch = ++ocrSessionEpoch;
    ocrTrackingActive = true;
    ocrWorkerGeneration = null;
    ocrLoader()
      .then(async (ocr) => {
        if (!ocrTrackingActive || epoch !== ocrSessionEpoch) return;
        await ocr.initOcr();
        if (!ocrTrackingActive || epoch !== ocrSessionEpoch) return;
        const generation = ocr.startOcrSession();
        ocrWorkerGeneration = generation;
      })
      .catch(err => disableOcr(err));
  }

  function stopOcrTrackingSession() {
    decisionClock.stop();
    textJudge.reset();
    ocrTrackingActive = false;
    ocrWorkerGeneration = null;
    ocrSessionEpoch += 1;
    ocrLoader()
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
    textJudge.reset();
    barrageManager.stop();
    barrageManager.isActive = true;
    decisionClock.start();
    barrageManager.mp3Count = 0;
    barrageManager.llmCount = 0;
    startOcrTrackingSession();
    uiBridge.broadcast('BARRAGE_LOG', { text: '弹幕识别已启动，开始记录日志...' });

    // Reset is ordered with later appends but never blocks the audio event loop.
    ocrTextLog.reset();
    return true;
  });

  uiBridge.on('onBarrageStop', () => {
    textJudge.reset();
    console.log(`[Phase 2] Barrage OCR tracking STOPPED`);
    stopOcrTrackingSession();
    barrageManager.stop();
    // Clear manager's deduplication state when stopped
    barrageManager.lastRecognizedText = null;

    const summaryText = `弹幕识别已关闭。本次运行累计播报 MP3 语音包 ${barrageManager.mp3Count} 次，LLM 语音合成 ${barrageManager.llmCount} 次。`;
    uiBridge.broadcast('BARRAGE_LOG', { text: summaryText });
  });

  uiBridge.on('onBarrageTextRead', async (text) => {
    // Legacy raw-text input follows the same mode routing and log ownership.
    await routeObservation({ text: String(text || ''), unchanged: false });
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
      const { recognizeText } = await ocrLoader();
      const result = await recognizeText(buffer, { generation: workerGeneration });

      // Stop/reselection invalidates old results. Playback never gates this
      // observation/logging path; native OCR remains bounded in its worker.
      if (
        !ocrTrackingActive ||
        !barrageManager.isActive ||
        sessionEpoch !== ocrSessionEpoch ||
        workerGeneration !== ocrWorkerGeneration
      ) return;

      framesProcessed++;

      // Status heartbeat (not a per-frame log).
      const now = Date.now();
      if (now - lastHeartbeat > 5000) {
        console.log(`[Phase 2] [Status] OCR loop alive. Processed ${framesProcessed} frames so far.`);
        lastHeartbeat = now;
      }

      if (!result) return; // Superseded/stale capture, not a blank observation.
      const text = result.text || '';
      uiBridge.broadcast('BARRAGE_CURRENT_TEXT', { text }); // Blank clears stale UI.
      const currentText = (result.lines || [text]).join('\n');
      await routeObservation({ text: currentText, snapshotId: result.snapshotId,
        receivedAt: result.receivedAt, capturedAt: result.capturedAt, unchanged: result.unchanged });
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
    decisionClock,
    configureBarrage,
    async destroy() {
      if (ocrDestroyed) return;
      ocrDestroyed = true;
      decisionClock.stop();
      textJudge.reset();
      ocrTrackingActive = false;
      ocrWorkerGeneration = null;
      ocrSessionEpoch += 1;
      barrageManager.stop();
      try {
        const ocr = await ocrLoader();
        await ocr.shutdownOcr();
      } catch {
        // Native OCR may be exactly why shutdown is running. Other subsystems
        // must still be allowed to finish their cleanup.
      }
      await ocrTextLog.close();
    },
  };
}
