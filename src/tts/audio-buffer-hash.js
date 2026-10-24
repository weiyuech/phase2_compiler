import { createHash } from 'node:crypto'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { abortedError } from './prepared-audio-cache.js'

const HASH_CHUNK_BYTES = 1024 * 1024

/** Preserve cache identity while giving playback timers and stop requests turns
 * between large input chunks. subarray does not copy or retain extra audio. */
export async function hashAudioBuffer(buffer, signal) {
  const digest = createHash('sha256')
  for (let offset = 0; offset < buffer.length; offset += HASH_CHUNK_BYTES) {
    if (signal?.aborted) throw abortedError()
    digest.update(buffer.subarray(offset, offset + HASH_CHUNK_BYTES))
    if (offset + HASH_CHUNK_BYTES < buffer.length) await nextTurn()
  }
  if (signal?.aborted) throw abortedError()
  return digest.digest('hex')
}
