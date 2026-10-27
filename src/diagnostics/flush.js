/** Drain local writers only; this request never sends commands to the robot. */
export function registerDiagnosticsFlush(port, collectors) {
  if (!port) return () => {}
  const onMessage = async ({ data } = {}) => {
    if (data?.type !== 'FLUSH_DIAGNOSTICS' || !/^[a-f0-9]{32}$/.test(data.requestId || '')) return
    const results = await Promise.allSettled(collectors.map(async collector => {
      await collector?.flush?.()
      const state = collector?.snapshot?.()
      // Writers deliberately absorb disk failures to protect robot control.
      // A fulfilled flush alone therefore does not confirm successful storage.
      return ![state, state?.storage, state?.incidentStorage].some(value =>
        value?.status === 'error' || value?.errorCode != null)
    }))
    try {
      port.postMessage({ type: 'DIAGNOSTICS_FLUSHED', requestId: data.requestId,
        ok: results.every(result => result.status === 'fulfilled' && result.value === true) })
    } catch { /* The desktop may have closed while writes were pending. */ }
  }
  port.on('message', onMessage)
  return () => port.removeListener('message', onMessage)
}
