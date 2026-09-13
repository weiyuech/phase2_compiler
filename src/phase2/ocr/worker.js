import { parentPort } from 'node:worker_threads';
import fs from 'node:fs/promises';
import path from 'node:path';
import ort from 'onnxruntime-node';
import sharp from 'sharp';
import { preprocessForDetection, preprocessForRecognition } from './preprocess.js';
import { CTCDecoder } from './decoder.js';
import { extractTextLineBoxes } from './postprocess.js';
import { imagesEquivalent } from './image-change.js';

// Sharp has its own native thread pool. One worker is sufficient for the OCR
// crop pipeline; ORT has a separately bounded inference pool below.
sharp.concurrency(1);

const SESSION_OPTIONS = Object.freeze({
  executionProviders: ['cpu'],
  intraOpNumThreads: 2,
  interOpNumThreads: 1,
  executionMode: 'sequential',
  graphOptimizationLevel: 'all',
});

let detSession = null;
let recSession = null;
let decoder = null;
let debugImagePath = null;
let lastDebugSave = 0;
let previousImage = null;
let previousResult = null;
let imageGeneration = null;

function serialiseError(error) {
  return {
    message: error?.message || String(error),
    stack: error?.stack,
  };
}

async function initialize(modelsPath, requestedDebugImagePath) {
  const resolvedModelsPath = path.resolve(modelsPath);
  detSession = await ort.InferenceSession.create(
    path.join(resolvedModelsPath, 'PP-OCRv6_medium_det.onnx'),
    { ...SESSION_OPTIONS },
  );
  recSession = await ort.InferenceSession.create(
    path.join(resolvedModelsPath, 'PP-OCRv6_medium_rec.onnx'),
    { ...SESSION_OPTIONS },
  );
  decoder = new CTCDecoder(path.join(resolvedModelsPath, 'ppocrv6_dict.txt'));
  debugImagePath = requestedDebugImagePath || null;

  console.log(
    `[Phase 2] [OCR] Worker ready (CPU, intra-op ${SESSION_OPTIONS.intraOpNumThreads}, ` +
    `inter-op ${SESSION_OPTIONS.interOpNumThreads}, sequential)`,
  );
}

function maybeSaveDebugImage(imageBuffer) {
  if (!debugImagePath) return;
  const now = Date.now();
  if (now - lastDebugSave < 5000) return;
  lastDebugSave = now;
  // Debug output is opt-in and never delays inference or backend audio.
  void fs.writeFile(debugImagePath, imageBuffer).catch((error) => {
    console.warn('[Phase 2] [OCR] Failed to save debug crop:', error.message);
  });
}

async function recognize(imageBuffer) {
  if (!detSession || !recSession || !decoder) {
    throw new Error('OCR worker is not initialized');
  }

  maybeSaveDebugImage(imageBuffer);

  const {
    tensor,
    dims,
    sourceData,
    sourceChannels,
    ...imageInfo
  } = await preprocessForDetection(imageBuffer);
  const detInput = new ort.Tensor('float32', tensor, dims);
  const detOutputs = await detSession.run({ [detSession.inputNames[0]]: detInput });
  const detOutputTensor = detOutputs[detSession.outputNames[0]];
  const boxes = extractTextLineBoxes(detOutputTensor, imageInfo);

  if (boxes.length === 0) return { text: '', lines: [], boxes: 0, score: 0 };

  // Deliberately serial: Promise.all previously let every detected row enter
  // Sharp and the native ORT pool together, multiplying CPU pressure.
  const unsortedResults = [];
  for (const box of boxes) {
    try {
      const extract = {
        left: Math.round(box.left),
        top: Math.round(box.top),
        width: Math.round(box.width),
        height: Math.round(box.height),
      };
      const { tensor: recTensor, dims: recDims } = await preprocessForRecognition(sourceData, {
        raw: {
          width: imageInfo.originalWidth,
          height: imageInfo.originalHeight,
          channels: sourceChannels,
        },
        extract,
      });
      const recInput = new ort.Tensor('float32', recTensor, recDims);
      const recOutputs = await recSession.run({ [recSession.inputNames[0]]: recInput });
      const outputTensor = recOutputs[recSession.outputNames[0]];
      const decoded = decoder.decode(outputTensor.data, outputTensor.dims);
      if (decoded?.text?.trim()) {
        unsortedResults.push({ ...decoded, top: box.top, left: box.left });
      }
    } catch (error) {
      console.error('[Phase 2] [OCR] Crop/recognition failed for box:', box, error.message);
    }
  }

  const results = unsortedResults.sort((a, b) => {
    const rowTolerance = 10;
    if (Math.abs(a.top - b.top) > rowTolerance) return a.top - b.top;
    return a.left - b.left;
  });

  if (results.length === 0) return { text: '', lines: [], boxes: 0, score: 0 };
  return {
    text: results.map((result) => result.text).join(' '),
    lines: results.map(result => result.text),
    score: results.reduce((sum, result) => sum + result.score, 0) / results.length,
    boxes: results.length,
  };
}

parentPort.on('message', async (message) => {
  if (message?.type === 'INIT') {
    try {
      await initialize(message.modelsPath, message.debugImagePath);
      parentPort.postMessage({ type: 'READY' });
    } catch (error) {
      parentPort.postMessage({ type: 'INIT_ERROR', error: serialiseError(error) });
    }
    return;
  }

  if (message?.type !== 'RECOGNIZE') return;
  try {
    const imageBuffer = Buffer.from(message.image);
    if (imageGeneration !== message.generation) {
      imageGeneration = message.generation;
      previousImage = null;
      previousResult = null;
    }
    const { data, info } = await sharp(imageBuffer).greyscale().raw().toBuffer({ resolveWithObject: true });
    const image = { data, width: info.width, height: info.height };
    if (imagesEquivalent(previousImage, image)) {
      parentPort.postMessage({ type: 'RESULT', requestId: message.requestId, result: { ...previousResult, unchanged: true } });
      return;
    }
    const result = await recognize(imageBuffer);
    previousImage = image;
    previousResult = result;
    parentPort.postMessage({ type: 'RESULT', requestId: message.requestId, result: { ...result, unchanged: false } });
  } catch (error) {
    parentPort.postMessage({
      type: 'RESULT',
      requestId: message.requestId,
      error: serialiseError(error),
    });
  }
});
