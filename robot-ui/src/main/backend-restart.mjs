// Coalesce saves while the old utility process exits and its ports are released.
// A single visible window must never leave multiple untracked backends running.
export function createBackendRestarter({ getBackend, startBackend, isClosing,
  delayMs = 2000, schedule = setTimeout, cancel = clearTimeout }) {
  let pending = false, timer = null, waitingFor = null
  const afterExit = () => {
    waitingFor = null
    timer = schedule(() => {
      timer = null
      pending = false
      if (!isClosing()) startBackend()
    }, delayMs)
  }
  const dispose = () => {
    cancel(timer)
    timer = null
    waitingFor?.removeListener('exit', afterExit)
    waitingFor = null
    pending = false
  }
  return {
    request() {
      if (isClosing()) return { ok: false, error: '应用正在退出' }
      if (pending) return { ok: true }
      pending = true
      waitingFor = getBackend()
      if (!waitingFor) afterExit()
      else {
        waitingFor.once('exit', afterExit)
        try {
          if (waitingFor.kill() === false) throw new Error('无法停止旧后台，请退出应用后重试')
        } catch (error) { dispose(); throw error }
      }
      return { ok: true }
    },
    dispose,
  }
}
