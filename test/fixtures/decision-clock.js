import assert from 'node:assert/strict';
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises';

export function fakeClock() {
  let time = 0, id = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimer: (callback, delay) => { const token = ++id; timers.set(token, { callback, at: time + delay }); return token; },
    clearTimer: token => timers.delete(token),
    at: async target => {
      assert.ok(target >= time);
      for (;;) {
        const due = [...timers].filter(([, item]) => item.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        time = due[1].at; timers.delete(due[0]); due[1].callback();
        await nextTurn();
      }
      time = target;
      await nextTurn();
    },
    jump: target => { time = target; },
    pendingTimers: () => timers.size,
  };
}

export async function until(predicate) {
  // Native/filesystem completion is not bounded by a count of event-loop turns.
  // Give slower Windows runners a real deadline without busy-spinning.
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await delay(1);
  }
  assert.fail('asynchronous condition did not settle');
}

export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
