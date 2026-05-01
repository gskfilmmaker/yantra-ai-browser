'use strict'
const { EventEmitter } = require('events')

// ── Background job queue ──────────────────────────────────────────────────────
// In-memory; one job = one graph orchestration run.
// Emits: 'progress', 'completed', 'failed' on the instance.
// Consumers (tools, IPC) listen to the global queue instance.

class Job {
  constructor(id, params) {
    this.id          = id
    this.params      = params
    this.state       = 'queued'      // queued | running | completed | failed
    this.progress    = 0             // 0–100
    this.createdAt   = Date.now()
    this.startedAt   = null
    this.completedAt = null
    this.result      = null
    this.error       = null
    this.log         = []
  }

  _log(msg) {
    this.log.push({ ts: Date.now(), msg })
  }

  toJSON() {
    return {
      id:          this.id,
      state:       this.state,
      progress:    this.progress,
      createdAt:   this.createdAt,
      startedAt:   this.startedAt,
      completedAt: this.completedAt,
      result:      this.result,
      error:       this.error,
      log:         this.log,
    }
  }
}

class JobQueue extends EventEmitter {
  constructor() {
    super()
    this._jobs       = new Map()
    this._running    = 0
    this._maxConcurrent = 3
  }

  // ── Enqueue ───────────────────────────────────────────────────────────────

  enqueue(jobId, params, executorFn) {
    const job = new Job(jobId, params)
    this._jobs.set(jobId, job)
    this._run(job, executorFn)
    return job
  }

  // ── Internal runner ───────────────────────────────────────────────────────

  async _run(job, executorFn) {
    // If already at capacity, poll until a slot opens
    while (this._running >= this._maxConcurrent) {
      await _sleep(200)
    }

    this._running++
    job.state     = 'running'
    job.startedAt = Date.now()
    job._log('Job started')
    this.emit('progress', { jobId: job.id, progress: 0, state: 'running' })

    try {
      const onProgress = (pct, msg) => {
        job.progress = Math.round(Math.min(100, Math.max(0, pct)))
        if (msg) job._log(msg)
        this.emit('progress', { jobId: job.id, progress: job.progress, state: 'running', msg })
      }

      job.result      = await executorFn(job, onProgress)
      job.state       = 'completed'
      job.progress    = 100
      job.completedAt = Date.now()
      job._log('Job completed')
      this.emit('completed', { jobId: job.id, result: job.result })
    } catch (err) {
      job.state       = 'failed'
      job.error       = err.message
      job.completedAt = Date.now()
      job._log(`Job failed: ${err.message}`)
      this.emit('failed', { jobId: job.id, error: err.message })
    } finally {
      this._running--
    }
  }

  // ── Status queries ────────────────────────────────────────────────────────

  get(jobId) {
    return this._jobs.get(jobId) || null
  }

  list({ limit = 20 } = {}) {
    return [...this._jobs.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map(j => j.toJSON())
  }

  stats() {
    let queued = 0, running = 0, completed = 0, failed = 0
    for (const j of this._jobs.values()) {
      if (j.state === 'queued')    queued++
      if (j.state === 'running')   running++
      if (j.state === 'completed') completed++
      if (j.state === 'failed')    failed++
    }
    return { queued, running, completed, failed, total: this._jobs.size }
  }
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// Singleton queue shared across the process
const globalQueue = new JobQueue()

module.exports = { JobQueue, globalQueue }
