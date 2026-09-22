#!/usr/bin/env node
// Real native OCR, synthetic image only: no screen capture, API calls or robot.
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertRecognition, FIXTURE_PATH, SYNTHETIC_TEXT } from '../robot-ui/scripts/verify-packaged-runtime.mjs'

export async function runOcrCheck({ client, image, timeoutMs = 60000 }) {
  let timer
  try {
    return await Promise.race([
      (async () => {
        await client.init()
        const generation = client.startSession()
        const result = await client.recognize(image, { generation })
        return assertRecognition(result)
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('OCR check timed out')), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
    // Required on success and failure; otherwise the native worker stays alive.
    await client.shutdown()
  }
}

async function main() {
  console.log(`[OCR check] Node ${process.version}, ${process.platform}/${process.arch}`)
  const { default: sharp } = await import('sharp')
  const { OcrWorkerClient } = await import('../src/phase2/ocr/index.js')
  const image = await sharp(FIXTURE_PATH).png().toBuffer()
  const client = new OcrWorkerClient({
    modelsPath: fileURLToPath(new URL('../data/models', import.meta.url)),
    debugImagePath: null,
  })
  const evidence = await runOcrCheck({ client, image })
  console.log(`[OCR check] PASS: "${SYNTHETIC_TEXT}" (confidence ${evidence.confidence.toFixed(3)})`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error('[OCR check] FAIL: ' + error.message); process.exitCode = 1 })
}
