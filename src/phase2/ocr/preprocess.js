import sharp from 'sharp';

/**
 * Image Preprocessing for PP-OCRv6
 */

// Official PaddleOCR normalization (0.5 mean, 0.5 std)
const MEAN = [0.5, 0.5, 0.5];
const STD = [0.5, 0.5, 0.5];

export async function preprocessForDetection(imageBuffer) {
  // Decode the PNG once. The raw pixels are reused for detector resizing and
  // every recognition crop in the worker.
  const { data: sourceData, info } = await sharp(imageBuffer)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height } = info;

  const limitSide = 960;
  const ratio = Math.min(1, limitSide / Math.max(width, height));
  const targetW = Math.max(32, Math.round((width * ratio) / 32) * 32);
  const targetH = Math.max(32, Math.round((height * ratio) / 32) * 32);

  const resizedData = await sharp(sourceData, {
    raw: { width, height, channels: info.channels }
  })
    .resize(targetW, targetH)
    .raw()
    .toBuffer();

  const floatData = new Float32Array(3 * targetH * targetW);

  for (let i = 0; i < targetH * targetW; i++) {
    // PaddleOCR preprocessing uses OpenCV images, so channel order is BGR.
    for (let c = 0; c < 3; c++) {
      const val = resizedData[i * 3 + (2 - c)] / 255.0;
      floatData[c * targetH * targetW + i] = (val - MEAN[c]) / STD[c];
    }
  }

  return {
    tensor: floatData,
    dims: [1, 3, targetH, targetW],
    originalWidth: width,
    originalHeight: height,
    resizedWidth: targetW,
    resizedHeight: targetH,
    sourceData,
    sourceChannels: info.channels
  };
}

export async function preprocessForRecognition(imageBuffer, { raw = null, extract = null } = {}) {
  const targetH = 48;
  const metadata = raw || await sharp(imageBuffer).metadata();

  if (!metadata.width || !metadata.height) {
    throw new Error('Cannot read OCR image dimensions');
  }

  const maxW = parseInt(process.env.OCR_REC_MAX_WIDTH || '1920', 10);
  const sourceWidth = extract?.width || metadata.width;
  const sourceHeight = extract?.height || metadata.height;
  let targetW = Math.round((sourceWidth * targetH) / sourceHeight);
  targetW = Math.max(16, Math.min(maxW, targetW));

  let pipeline = raw ? sharp(imageBuffer, { raw }) : sharp(imageBuffer);
  if (extract) pipeline = pipeline.extract(extract);
  const resizedData = await pipeline
    .resize(targetW, targetH)
    .removeAlpha()
    .raw()
    .toBuffer();

  const floatData = new Float32Array(3 * targetH * targetW);

  for (let i = 0; i < targetH * targetW; i++) {
    // PaddleOCR preprocessing uses OpenCV images, so channel order is BGR.
    for (let c = 0; c < 3; c++) {
      const val = resizedData[i * 3 + (2 - c)] / 255.0;
      floatData[c * targetH * targetW + i] = (val - MEAN[c]) / STD[c];
    }
  }

  return {
    tensor: floatData,
    dims: [1, 3, targetH, targetW]
  };
}
