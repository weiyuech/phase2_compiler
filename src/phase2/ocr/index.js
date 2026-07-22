import ort from 'onnxruntime-node';
import path from 'path';
import sharp from 'sharp';
import { preprocessForDetection, preprocessForRecognition } from './preprocess.js';
import { CTCDecoder } from './decoder.js';
import { extractTextLineBoxes } from './postprocess.js';

let detSession = null;
let recSession = null;
let decoder = null;
let isReady = false;

export async function initOcr() {
  if (isReady) return;
  console.log('[Phase 2] [OCR] Initializing Manual v6 Pipeline (ONNX + Sharp)...');
  
  try {
    const modelsPath = path.resolve('./data/models');
    
    detSession = await ort.InferenceSession.create(path.join(modelsPath, 'PP-OCRv6_medium_det.onnx'));
    recSession = await ort.InferenceSession.create(path.join(modelsPath, 'PP-OCRv6_medium_rec.onnx'));
    
    console.log('[Phase 2] [DEBUG] Det Inputs:', detSession.inputNames, detSession.handler.inputNames);
    console.log('[Phase 2] [DEBUG] Rec Inputs:', recSession.inputNames, recSession.handler.inputNames);
    
    decoder = new CTCDecoder(path.join(modelsPath, 'ppocrv6_dict.txt'));

    isReady = true;
    console.log('[Phase 2] [OCR] Manual Pipeline Ready!');
  } catch (error) {
    console.error('[Phase 2] [OCR] Failed to initialize pipeline:', error);
  }
}

export async function recognizeText(imageBuffer) {
  if (!isReady) return null;

  try {
    // 1. Detection
    const { tensor, dims, ...imageInfo } = await preprocessForDetection(imageBuffer);
    const detInput = new ort.Tensor('float32', tensor, dims);
    const detOutputs = await detSession.run({ [detSession.inputNames[0]]: detInput });
    const detOutputTensor = detOutputs[detSession.outputNames[0]];
    
    const boxes = extractTextLineBoxes(detOutputTensor, imageInfo);
    console.log(`[Phase 2] [DEBUG] Detector found ${boxes.length} boxes`);
    
    if (boxes.length === 0) {
      return null;
    }

    // 2. Recognition for each box (Concurrent)
    const promises = boxes.map(async (box) => {
      try {
        const crop = await sharp(imageBuffer)
          .extract({
            left: Math.round(box.left),
            top: Math.round(box.top),
            width: Math.round(box.width),
            height: Math.round(box.height)
          })
          .toBuffer();

        const { tensor: recTensor, dims: recDims } = await preprocessForRecognition(crop);
        const recInput = new ort.Tensor('float32', recTensor, recDims);
        
        // Inference runs concurrently in C++ thread pool
        const recOutputs = await recSession.run({ [recSession.inputNames[0]]: recInput });
        const outputTensor = recOutputs[recSession.outputNames[0]];
        
        const decoded = decoder.decode(outputTensor.data, outputTensor.dims);
        if (decoded && decoded.text.trim()) {
          // Preserve the original box top/left for sorting later if needed
          return { ...decoded, top: box.top, left: box.left };
        }
      } catch (cropError) {
        console.error('[Phase 2] [OCR] Crop/Rec failed for box:', box, cropError);
      }
      return null;
    });

    const unsortedResults = (await Promise.all(promises)).filter(Boolean);
    
    // Sort top-to-bottom, then left-to-right to maintain natural reading order
    const results = unsortedResults.sort((a, b) => {
      const rowTolerance = 10; // Pixels
      if (Math.abs(a.top - b.top) > rowTolerance) {
        return a.top - b.top;
      }
      return a.left - b.left;
    });
    
    if (results.length === 0) return null;

    // Combine results
    const combinedText = results.map(r => r.text).join(' ');
    const avgScore = results.reduce((sum, r) => sum + r.score, 0) / results.length;
    
    const finalResult = {
      text: combinedText,
      score: avgScore,
      boxes: results.length // Metadata for tracking
    };

    console.log(`[Phase 2] [OCR Result]:`, finalResult.text);
    return finalResult;
  } catch (error) {
    console.error('[Phase 2] [OCR] Recognition failed:', error);
    return null;
  }
}
