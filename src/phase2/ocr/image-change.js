// Compare grayscale pixels against the last recognized capture, so small
// accumulating changes cannot evade recognition indefinitely.
export function imagesEquivalent(previous, current) {
  if (!previous || previous.width !== current.width || previous.height !== current.height || previous.data.length !== current.data.length) return false;
  let changed = 0;
  const allowance = Math.max(4, Math.floor(current.data.length * 0.00005));
  for (let i = 0; i < current.data.length; i++) {
    if (Math.abs(previous.data[i] - current.data[i]) > 12 && ++changed > allowance) return false;
  }
  return true;
}
