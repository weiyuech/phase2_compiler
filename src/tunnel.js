// @ngrok/ngrok 使用 Rust 编译的 native binary，静态 import 在 Windows 上
// 可能因为 DLL 依赖缺失或 ABI 不匹配而失败，导致整个后端崩溃。
// 改为动态 import，失败时只打印日志，不影响后端其他功能。

let _listener = null
let _url      = null

export async function startTunnel(port, authtoken) {
  if (!authtoken) return null
  console.log('[tunnel] 正在启动，端口:', port)
  try {
    const { forward } = await import('@ngrok/ngrok')
    _listener = await forward({ addr: port, authtoken })
    _url = _listener.url()
    console.log('[tunnel] 启动成功，URL:', _url)
    return _url
  } catch (err) {
    // 用 console.log 而非 console.error，确保写入 stdout 实时出现在 backend.log 里
    console.log('[tunnel] 启动失败:', err.message)
    return null
  }
}

export async function stopTunnel() {
  if (_listener) {
    try {
      const { disconnect } = await import('@ngrok/ngrok')
      await disconnect()
    } catch {}
    _listener = null
    _url      = null
  }
}

export function getTunnelUrl() { return _url }
