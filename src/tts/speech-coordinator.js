import { randomUUID } from 'node:crypto'

const PRIORITY = Object.freeze({ transit: 1, cruise: 2, barrage: 3 })

/** One speaker lease shared by local and robot output. Preparation owns no lease. */
export class SpeechCoordinator {
  constructor({ diagnostics = null } = {}) {
    this.diagnostics = diagnostics
    this.jobs = new Set()
    this.active = null
    this.pauses = new Map()
    this.serial = 0
    this._pumping = false
    this._repump = false
  }

  createJob({ id = randomUUID(), role = 'cruise', kind = 'tts', signal, pause, resume } = {}) {
    if (!(role in PRIORITY)) throw new Error(`Unknown speech role: ${role}`)
    const job = {
      id, role, kind, signal, pause, resume,
      order: this.serial++, ready: false, granted: false, suspended: false,
      closed: false, inSentence: false, waiters: [],
      get active() { return !this.closed && this.coordinator.active === this },
      acquire: () => {
        if (job.closed || signal?.aborted) return Promise.resolve(false)
        job.ready = true
        const result = new Promise(resolve => job.waiters.push(resolve))
        this._pump()
        if (!job.active) {
          job.waitingAt ??= performance.now()
          this.diagnostics?.event('waiting', { sessionId: id, role, reason: 'priority', prepared: true })
        }
        return result
      },
      boundary: (nextReady = false, { hold = false } = {}) => {
        if (job.closed) return
        // The engine advances its sentence cursor BEFORE calling this method.
        // A ready continuation participates in the SAME arbitration pass.
        if (this.active === job) this.active = null
        job.granted = false
        job.suspended = false
        job.inSentence = false
        // Waiting for synthesis is silence within the current narration, not
        // permission to insert transit. Higher priority ready speech may win.
        job.ready = nextReady || hold
        this.diagnostics?.event('sentence-boundary', { sessionId: id, role })
        this._pump()
      },
      finish: () => this._close(job, 'completed'),
      cancel: () => this._close(job, 'cancelled'),
      coordinator: this,
    }
    job.onAbort = job.cancel
    signal?.addEventListener('abort', job.onAbort, { once: true })
    this.jobs.add(job)
    if (signal?.aborted) job.cancel()
    return job
  }

  setPauseReason(reason, roles, active) {
    if (active) this.pauses.set(reason, new Set(roles))
    else this.pauses.delete(reason)
    this.diagnostics?.event(active ? 'pause' : 'resume', { reason })
    this._pump()
  }

  _blocked(job) {
    return [...this.pauses.values()].some(roles => roles.has(job.role))
  }

  _call(job, method) {
    try {
      Promise.resolve(job[method]?.()).catch(() => {
        this.diagnostics?.event('error', { sessionId: job.id, role: job.role, reason: `player-${method}` })
        job.cancel()
      })
    } catch {
      this.diagnostics?.event('error', { sessionId: job.id, role: job.role, reason: `player-${method}` })
      job.cancel()
    }
  }

  _suspend(job) {
    if (!job.suspended && job.granted && job.inSentence) {
      job.suspended = true
      this._call(job, 'pause')
    }
  }

  _pump() {
    if (this._pumping) { this._repump = true; return }
    this._pumping = true
    try {
      do {
        this._repump = false
        const old = this.active
        if (old && (old.closed || this._blocked(old))) {
          this._suspend(old)
          this.active = null
        }
        const candidates = [...this.jobs].filter(j => !j.closed && j.ready && !this._blocked(j))
          .sort((a, b) => PRIORITY[b.role] - PRIORITY[a.role] || a.order - b.order)
        const winner = candidates[0]
        const current = this.active
        if (current && winner && winner !== current && PRIORITY[winner.role] > PRIORITY[current.role]) {
          if (current.kind === 'tts' && current.inSentence && !current.suspended) {
            // TTS keeps its lease until the audible/sender-estimated sentence
            // boundary. A ready higher priority job must NOT pause it here.
            continue
          }
          this._suspend(current)
          this.active = null
        }
        if (!this.active && winner && !winner.closed) {
          this.active = winner
          if (winner.suspended) {
            winner.suspended = false
            this._call(winner, 'resume')
          }
          winner.granted = true
          this.diagnostics?.event('handoff', { sessionId: winner.id, role: winner.role, kind: winner.kind,
            reason: 'priority', waitMs: winner.waitingAt === undefined ? 0 : performance.now() - winner.waitingAt })
          winner.waitingAt = undefined
        }
        if (this.active) {
          if (this.active.waiters.length) this.active.inSentence = true
          for (const resolve of this.active.waiters.splice(0)) resolve(true)
        }
      } while (this._repump)
    } finally {
      this._pumping = false
    }
  }

  _close(job, reason) {
    if (job.closed) return
    job.closed = true
    job.ready = false
    job.signal?.removeEventListener('abort', job.onAbort)
    this.jobs.delete(job)
    if (this.active === job) this.active = null
    for (const resolve of job.waiters.splice(0)) resolve(false)
    this.diagnostics?.event(reason, { sessionId: job.id, role: job.role })
    this._pump()
  }

  cancelAll() {
    // Avoid transient resumes while tearing down an output/connection.
    const pumping = this._pumping
    this._pumping = true
    try { for (const job of [...this.jobs]) this._close(job, 'cancelled') }
    finally { this.active = null; this._pumping = pumping; this._repump = false }
  }
}
