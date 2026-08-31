import { format } from 'node:util'
import { RollingLog } from './rolling-log.js'

/** Electron owns packaged stdout/stderr history; only dev needs a console tee. */
export function startBackendLogCapture({ directory }) {
  if (process.env.BACKEND_LOG_OWNER === 'electron') {
    return { flush: async () => {}, destroy: async () => {}, snapshot: () => ({ owner: 'electron' }) }
  }
  const writer = new RollingLog({ directory, name: 'backend.log' })
  const originals = new Map()
  for (const method of ['log', 'warn', 'error', 'info', 'debug']) {
    const original = console[method]
    const wrapped = (...args) => {
      original.apply(console, args)
      writer.append(`[${method}] ${format(...args)}`)
    }
    originals.set(method, { original, wrapped })
    console[method] = wrapped
  }
  return {
    snapshot: () => writer.snapshot(),
    flush: () => writer.flush(),
    async destroy() {
      for (const [method, { original, wrapped }] of originals) if (console[method] === wrapped) console[method] = original
      await writer.destroy()
    },
  }
}
