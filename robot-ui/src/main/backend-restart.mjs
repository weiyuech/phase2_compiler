// Each machine owns one restarter. All saves made while its old process exits
// share the same result, and settings are read by startBackend only at launch.
export function createBackendRestarter({ getBackend, startBackend, isClosing,
  delayMs = 250, exitTimeoutMs = 10_000, schedule = setTimeout, cancel = clearTimeout }) {
  let pending = null
  let disposed = false
  const closedResult = () => ({ ok: false, error: '工作区已关闭' })
  const closing = () => disposed || isClosing()

  function finish(operation, result) {
    if (pending !== operation) return
    if (operation.exitTimer !== null) cancel(operation.exitTimer)
    if (operation.launchTimer !== null) cancel(operation.launchTimer)
    operation.backend?.removeListener('exit', operation.onExit)
    pending = null
    operation.resolve(result)
  }

  function launchAfterExit(operation) {
    if (pending !== operation || operation.exited) return
    operation.exited = true
    if (operation.exitTimer !== null) cancel(operation.exitTimer)
    operation.exitTimer = null
    operation.backend?.removeListener('exit', operation.onExit)
    if (closing()) { finish(operation, closedResult()); return }
    operation.launchTimer = schedule(() => {
      operation.launchTimer = null
      if (pending !== operation) return
      if (closing()) { finish(operation, closedResult()); return }
      try {
        const result = startBackend()
        finish(operation, result?.ok === false ? result : { ok: true })
      } catch (error) {
        finish(operation, { ok: false, error: `启动后端进程失败：${error?.message || error}` })
      }
    }, delayMs)
  }

  return {
    request() {
      if (closing()) {
        if (pending) finish(pending, closedResult())
        return Promise.resolve(closedResult())
      }
      if (pending) return pending.promise
      let resolve
      const promise = new Promise(done => { resolve = done })
      const operation = { promise, resolve, backend: null, onExit: null,
        exitTimer: null, launchTimer: null, exited: false }
      pending = operation
      try {
        operation.backend = getBackend()
        operation.onExit = () => launchAfterExit(operation)
        if (!operation.backend) launchAfterExit(operation)
        else {
          operation.backend.once('exit', operation.onExit)
          operation.exitTimer = schedule(() => {
            if (pending !== operation || operation.exited) return
            finish(operation, { ok: false, error: '等待旧后台退出超时，设置已保存，请重试或退出应用后重新打开' })
          }, exitTimeoutMs)
          // kill() only requests termination; the exit event permits replacement.
          if (operation.backend.kill() === false) throw new Error('无法停止旧后台，请重试或退出应用后重新打开')
        }
      } catch (error) {
        // Also cancels a launch queued by a synchronous exit emitted from kill().
        finish(operation, { ok: false, error: error?.message || String(error) })
      }
      return promise
    },
    dispose() {
      disposed = true
      if (pending) finish(pending, closedResult())
    },
  }
}
