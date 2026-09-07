import { Worker } from 'node:worker_threads';
import path from 'node:path';

function defaultWorkerFactory() {
  return new Worker(new URL('./worker.js', import.meta.url));
}

function toError(value, fallback) {
  const error = new Error(value?.message || fallback);
  if (value?.stack) error.stack = value.stack;
  return error;
}

function markFatal(error) {
  const fatal = error instanceof Error ? error : new Error(String(error));
  fatal.ocrFatal = true;
  return fatal;
}

/**
 * Serialises OCR work through one worker. At most one frame is executing and
 * one newer frame is retained; an even newer frame replaces the pending one.
 * This keeps native OCR work away from the backend/audio event loop without
 * allowing a slow crop to create an unbounded screenshot queue.
 */
export class OcrWorkerClient {
  constructor({
    workerFactory = defaultWorkerFactory,
    modelsPath = path.resolve('./data/models'),
    debugImagePath = process.env.OCR_DEBUG_IMAGES === '1'
      ? path.resolve('./data/debug-ocr-crop.png')
      : null,
  } = {}) {
    this.workerFactory = workerFactory;
    this.modelsPath = modelsPath;
    this.debugImagePath = debugImagePath;

    this.worker = null;
    this.ready = false;
    this.initializing = null;
    this.resolveInit = null;
    this.rejectInit = null;
    this.fatalError = null;
    this.shuttingDown = false;

    this.sessionActive = false;
    this.generation = 0;
    this.paused = false;
    this.nextRequestId = 1;
    this.activeRequest = null;
    this.pendingRequest = null;
  }

  init() {
    if (this.shuttingDown) return Promise.reject(new Error('OCR worker has been shut down'));
    if (this.ready) return Promise.resolve();
    if (this.fatalError) return Promise.reject(this.fatalError);
    if (this.initializing) return this.initializing;

    this.initializing = new Promise((resolve, reject) => {
      this.resolveInit = resolve;
      this.rejectInit = reject;
    });

    const initialization = this.initializing;
    let worker;
    try {
      worker = this.workerFactory();
      this.worker = worker;
      worker.on('message', (message) => this._onMessage(worker, message));
      worker.on('error', (error) => this._failWorker(worker, error));
      worker.on('exit', (code) => {
        if (this.shuttingDown || worker !== this.worker) return;
        this._failWorker(worker, new Error(`OCR worker exited unexpectedly (code ${code})`));
      });
      worker.postMessage({
        type: 'INIT',
        modelsPath: this.modelsPath,
        debugImagePath: this.debugImagePath,
      });
    } catch (error) {
      this._failWorker(worker, error);
      try { void worker?.terminate?.(); } catch {}
    }

    return initialization;
  }

  startSession() {
    this.generation += 1;
    this.sessionActive = true;
    this.paused = false;
    this._discardPending();
    return this.generation;
  }

  stopSession() {
    this.generation += 1;
    this.sessionActive = false;
    this.paused = false;
    this._discardPending();
    return this.generation;
  }

  setPaused(paused) {
    this.paused = Boolean(paused);
    if (!this.paused) this._pump();
  }

  async recognize(imageBuffer, { generation = this.generation } = {}) {
    if (this.shuttingDown) return null;
    if (!this.sessionActive || generation !== this.generation) return null;
    await this.init();
    if (!this.sessionActive || generation !== this.generation) return null;

    const image = Buffer.isBuffer(imageBuffer)
      ? Buffer.from(imageBuffer)
      : Buffer.from(imageBuffer || []);

    return new Promise((resolve, reject) => {
      const request = {
        id: this.nextRequestId++,
        generation,
        image,
        resolve,
        reject,
      };

      // Keep only the newest not-yet-started frame.
      this._discardPending();
      this.pendingRequest = request;
      this._pump();
    });
  }

  async shutdown() {
    if (this.shuttingDown && !this.worker) return;
    this.shuttingDown = true;
    this.sessionActive = false;
    this.generation += 1;
    this._discardPending();
    const rejectInit = this.rejectInit;
    this.resolveInit = null;
    this.rejectInit = null;
    this.initializing = null;
    rejectInit?.(new Error('OCR worker shut down during initialization'));
    if (this.activeRequest) {
      this.activeRequest.resolve(null);
      this.activeRequest = null;
    }
    const worker = this.worker;
    this.worker = null;
    this.ready = false;
    if (worker) await worker.terminate();
  }

  _pump() {
    if (
      !this.ready ||
      !this.sessionActive ||
      this.paused ||
      this.activeRequest ||
      !this.pendingRequest
    ) return;

    const request = this.pendingRequest;
    this.pendingRequest = null;

    if (request.generation !== this.generation) {
      request.resolve(null);
      this._pump();
      return;
    }

    this.activeRequest = request;
    try {
      this.worker.postMessage({
        type: 'RECOGNIZE',
        requestId: request.id,
        image: request.image,
      });
    } catch (error) {
      this.activeRequest = null;
      request.reject(error);
      this._pump();
    }
  }

  _discardPending() {
    if (!this.pendingRequest) return;
    this.pendingRequest.resolve(null);
    this.pendingRequest = null;
  }

  _onMessage(worker, message) {
    if (worker !== this.worker || !message) return;

    if (message.type === 'READY') {
      this.ready = true;
      const resolve = this.resolveInit;
      this.resolveInit = null;
      this.rejectInit = null;
      this.initializing = null;
      resolve?.();
      this._pump();
      return;
    }

    if (message.type === 'INIT_ERROR') {
      const error = toError(message.error, 'OCR worker failed to initialize');
      this._failWorker(worker, error);
      void worker.terminate();
      return;
    }

    if (message.type !== 'RESULT') return;
    const request = this.activeRequest;
    if (!request || request.id !== message.requestId) return;
    this.activeRequest = null;

    if (!this.sessionActive || request.generation !== this.generation) {
      request.resolve(null);
    } else if (message.error) {
      request.reject(toError(message.error, 'OCR recognition failed'));
    } else {
      request.resolve(message.result ?? null);
    }
    this._pump();
  }

  _failWorker(worker, error) {
    if (worker && worker !== this.worker) return;
    if (this.fatalError) return;
    this.fatalError = markFatal(error);
    this.ready = false;

    const reject = this.rejectInit;
    this.resolveInit = null;
    this.rejectInit = null;
    this.initializing = null;
    reject?.(this.fatalError);

    if (this.activeRequest) {
      this.activeRequest.reject(this.fatalError);
      this.activeRequest = null;
    }
    if (this.pendingRequest) {
      this.pendingRequest.reject(this.fatalError);
      this.pendingRequest = null;
    }
  }
}

const defaultClient = new OcrWorkerClient();

export function initOcr() {
  return defaultClient.init();
}

export function startOcrSession() {
  return defaultClient.startSession();
}

export function stopOcrSession() {
  return defaultClient.stopSession();
}

export function setOcrPaused(paused) {
  defaultClient.setPaused(paused);
}

export function recognizeText(imageBuffer, options) {
  return defaultClient.recognize(imageBuffer, options);
}

export function shutdownOcr() {
  return defaultClient.shutdown();
}
