import { performance } from 'node:perf_hooks';
import { normalizeBarrageTiming } from './barrage-timing.js';

// Fixed, recurring reply opportunities. Busy slots are skipped, never queued
// or replayed immediately when speech finishes. All modes share this clock.
export class BarrageDecisionClock {
  constructor({ onRound, isBusy, onError = () => {}, now = () => performance.now(),
    setTimer = setTimeout, clearTimer = clearTimeout }) {
    Object.assign(this, { onRound, isBusy, onError, now, setTimer, clearTimer });
    this.config = { mode: 'llm-strict', ...normalizeBarrageTiming() };
    this.active = false;
    this.epoch = 0;
    this.running = false;
    this.timer = null;
    this.latest = null;
    this.version = 0;
    this.completedVersion = -1;
    this.attempts = 0;
    this.attemptVersion = -1;
    this.nextAt = null;
  }

  configure(config) {
    const next = { ...config, ...normalizeBarrageTiming(config) };
    const periodChanged = next.cooldown !== this.config.cooldown;
    this.config = next;
    // A changed setting establishes a new future slot, not a burst of replies.
    if (periodChanged && this.nextAt !== null) this.nextAt = this.now() + next.cooldown * 1000;
    this._arm();
  }

  start() { this.reset(); this.active = true; }
  stop() { this.active = false; this.reset(); }
  invalidateCurrent() { this.epoch++; }
  reset() {
    this.epoch++;
    this._clearTimer();
    this.latest = null;
    this.version = 0;
    this.completedVersion = -1;
    this.attempts = 0;
    this.attemptVersion = -1;
    this.nextAt = null;
    // An invalidated external call may still be finishing. Keep its running
    // reservation until it settles: mode changes cannot overlap paid calls.
  }

  observe(observation) {
    if (!this.active) return;
    if (!this.latest || !observation.unchanged) this.version++;
    this.latest = Object.freeze({ ...observation, text: String(observation.text || '').slice(0, 16000) });
    if (this.nextAt === null) {
      this.nextAt = this.now();
      this.tick(); // First completed observation is eligible immediately.
    }
  }

  _clearTimer() {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  _arm() {
    this._clearTimer();
    if (!this.active || this.nextAt === null) return;
    this.timer = this.setTimer(() => { this.timer = null; this.tick(); }, Math.max(0, this.nextAt - this.now()));
    this.timer.unref?.();
  }

  tick() {
    if (!this.active || this.nextAt === null) return;
    const now = this.now(), period = this.config.cooldown * 1000;
    if (now < this.nextAt) { this._arm(); return; }
    // Timer/event-loop delays coalesce into one opportunity, never a catch-up loop.
    this.nextAt += (Math.floor((now - this.nextAt) / period) + 1) * period;
    this._arm();
    if (!this.latest) return;
    if (this.running || this.isBusy() || !this.latest.text.trim()) return;
    const mp3 = this.config.mode === 'mp3';
    // MP3 matches the current OCR on every available slot: no semantic history.
    // TTS avoids paying to judge an unchanged, already-successful observation.
    if (!mp3 && this.version === this.completedVersion) return;
    if (this.attemptVersion !== this.version) { this.attemptVersion = this.version; this.attempts = 0; }
    if (!mp3 && this.attempts >= 2) return; // One retry; changed OCR gets a new budget.
    this.attempts++;
    const snapshot = this.latest, version = this.version, epoch = this.epoch;
    const config = { ...this.config };
    const isCurrent = () => this.active && epoch === this.epoch;
    this.running = true;
    void (async () => {
      try {
        const result = await this.onRound(snapshot, config, { isCurrent });
        if (isCurrent() && result?.ok !== false) this.completedVersion = version;
      } catch (error) {
        if (isCurrent()) this.onError(error, { retrying: mp3 || this.attempts < 2 });
      } finally { this.running = false; }
    })();
  }
}
