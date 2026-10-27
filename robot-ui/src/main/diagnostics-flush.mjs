import { randomBytes } from 'node:crypto'

// A dead/old backend must never prevent exporting evidence already on disk.
export function flushBackendDiagnostics(backend, { timeoutMs = 1000 } = {}) {
  if (!backend) return Promise.resolve('unavailable')
  return new Promise(resolve => {
    const requestId = randomBytes(16).toString('hex')
    let settled = false
    let timer
    const finish = status => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      backend.removeListener('message', onMessage)
      backend.removeListener('exit', onExit)
      resolve(status)
    }
    const onMessage = message => {
      if (message?.type === 'DIAGNOSTICS_FLUSHED' && message.requestId === requestId) {
        finish(message.ok === true ? 'flushed' : 'failed')
      }
    }
    const onExit = () => finish('unavailable')
    backend.on('message', onMessage)
    backend.once('exit', onExit)
    timer = setTimeout(() => finish('timeout'), timeoutMs)
    try { backend.postMessage({ type: 'FLUSH_DIAGNOSTICS', requestId }) }
    catch { finish('failed') }
  })
}
