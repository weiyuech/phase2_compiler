// Shared by backend validation and the renderer. Ties round up; there is no
// zero-cooldown mode. Changing either value always yields a valid pair.
export function normalizeBarrageTiming({ scan_interval = 1, cooldown = 0 } = {}) {
  const interval = Math.max(1, Math.min(60, Math.round(Number(scan_interval) || 1)));
  const requested = Math.max(0, Number(cooldown) || 0);
  const multiples = Math.max(1, Math.min(Math.floor(3000 / interval), Math.round(requested / interval)));
  return { scan_interval: interval, cooldown: multiples * interval };
}
