'use strict'
const EventEmitter = require('events')

const TASK_STATES = {
  IDLE:      'idle',
  RUNNING:   'running',
  COMPLETED: 'completed',
  FAILED:    'failed',
  ABORTED:   'aborted',
}

const STEP_STATES = {
  PENDING:   'pending',
  RUNNING:   'running',
  OBSERVING: 'observing',
  VERIFYING: 'verifying',
  RETRYING:  'retrying',
  PASSED:    'passed',
  FAILED:    'failed',
  SKIPPED:   'skipped',
}

class TaskStateMachine extends EventEmitter {
  constructor(task) {
    super()
    this.taskId   = task.id   || `task_${Date.now()}`
    this.name     = task.name || 'Unnamed Task'
    this.state    = TASK_STATES.IDLE
    this.startedAt    = null
    this.completedAt  = null
    this.executionLog = []

    this.steps = (task.steps || []).map((s, i) => ({
      id:            s.id            || `step_${i + 1}`,
      type:          s.type,
      params:        s.params        || {},
      verify:        s.verify        || null,
      required:      s.required      !== false,    // true by default
      maxRetries:    s.maxRetries    ?? 2,
      retryStrategy: s.retryStrategy || 'wait',
      retryDelayMs:  s.retryDelayMs  || 1500,
      state:         STEP_STATES.PENDING,
      retryCount:    0,
      result:        null,
      error:         null,
      beforeSnapshot: null,
      afterSnapshot:  null,
      verification:   null,
      startedAt:      null,
      completedAt:    null,
      log:            [],
    }))
  }

  // ── Task-level transitions ────────────────────────────────────────────────────

  start() {
    this._transition(TASK_STATES.RUNNING)
    this.startedAt = new Date().toISOString()
    this._log({ type: 'task_start', taskId: this.taskId, name: this.name, stepCount: this.steps.length })
  }

  complete() {
    this._transition(TASK_STATES.COMPLETED)
    this.completedAt = new Date().toISOString()
    const { passed, failed, skipped } = this._counts()
    this._log({ type: 'task_complete', passed, failed, skipped, durationMs: this._elapsed() })
  }

  fail(reason) {
    this._transition(TASK_STATES.FAILED)
    this.completedAt = new Date().toISOString()
    this._log({ type: 'task_fail', reason })
  }

  abort(reason) {
    this._transition(TASK_STATES.ABORTED)
    this.completedAt = new Date().toISOString()
    this._log({ type: 'task_abort', reason })
  }

  // ── Step-level transitions ────────────────────────────────────────────────────

  beginStep(idx) {
    const step = this._step(idx)
    step.state     = STEP_STATES.RUNNING
    step.startedAt = new Date().toISOString()
    this._stepLog(step, { type: 'step_start', stepId: step.id, stepType: step.type, params: step.params })
    this._log({ type: 'step_start', idx, stepId: step.id, stepType: step.type })
    return step
  }

  stepObserving(idx) {
    const step = this._step(idx)
    step.state = STEP_STATES.OBSERVING
    this._stepLog(step, { type: 'observing' })
  }

  stepVerifying(idx, verification) {
    const step = this._step(idx)
    step.state        = STEP_STATES.VERIFYING
    step.verification = verification
    if (verification) this._stepLog(step, { type: 'verifying', passed: verification.passed, confidence: verification.confidence })
  }

  stepPassed(idx, result) {
    const step = this._step(idx)
    step.state       = STEP_STATES.PASSED
    step.result      = result
    step.completedAt = new Date().toISOString()
    this._stepLog(step, { type: 'step_pass', retries: step.retryCount })
    this._log({ type: 'step_pass', idx, stepId: step.id, retries: step.retryCount })
  }

  stepFailed(idx, error) {
    const step = this._step(idx)
    step.state       = STEP_STATES.FAILED
    step.error       = errorMsg(error)
    step.completedAt = new Date().toISOString()
    this._stepLog(step, { type: 'step_fail', error: errorMsg(error) })
    this._log({ type: 'step_fail', idx, stepId: step.id, error: errorMsg(error) })
  }

  stepRetrying(idx, attempt, strategy) {
    const step = this._step(idx)
    step.state      = STEP_STATES.RETRYING
    step.retryCount = attempt
    this._stepLog(step, { type: 'retrying', attempt, strategy })
    this._log({ type: 'retrying', idx, stepId: step.id, attempt, strategy })
  }

  stepSkipped(idx, reason) {
    const step = this._step(idx)
    step.state       = STEP_STATES.SKIPPED
    step.completedAt = new Date().toISOString()
    this._stepLog(step, { type: 'step_skip', reason })
    this._log({ type: 'step_skip', idx, stepId: step.id, reason })
  }

  // ── Report ────────────────────────────────────────────────────────────────────

  getReport() {
    const { passed, failed, skipped } = this._counts()
    return {
      taskId:      this.taskId,
      name:        this.name,
      state:       this.state,
      startedAt:   this.startedAt,
      completedAt: this.completedAt,
      durationMs:  this._elapsed(),
      summary:     { total: this.steps.length, passed, failed, skipped },
      steps:       this.steps.map(s => ({
        id:           s.id,
        type:         s.type,
        state:        s.state,
        retryCount:   s.retryCount,
        result:       typeof s.result === 'string' ? s.result.slice(0, 400) : s.result,
        error:        s.error,
        verification: s.verification,
        durationMs:   s.startedAt && s.completedAt
                        ? new Date(s.completedAt) - new Date(s.startedAt) : null,
        log:          s.log,
      })),
      log: this.executionLog,
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  _step(idx) {
    const s = this.steps[idx]
    if (!s) throw new Error(`Step index ${idx} out of bounds (task has ${this.steps.length} steps)`)
    return s
  }

  _transition(next) {
    const prev  = this.state
    this.state  = next
    this.emit('stateChange', { from: prev, to: next, taskId: this.taskId })
  }

  _log(entry) {
    const r = { ...entry, ts: new Date().toISOString() }
    this.executionLog.push(r)
    this.emit('log', r)
  }

  _stepLog(step, entry) {
    step.log.push({ ...entry, ts: new Date().toISOString() })
  }

  _counts() {
    return {
      passed:  this.steps.filter(s => s.state === STEP_STATES.PASSED).length,
      failed:  this.steps.filter(s => s.state === STEP_STATES.FAILED).length,
      skipped: this.steps.filter(s => s.state === STEP_STATES.SKIPPED).length,
    }
  }

  _elapsed() {
    if (!this.startedAt) return null
    const end = this.completedAt ? new Date(this.completedAt) : new Date()
    return end - new Date(this.startedAt)
  }
}

function errorMsg(e) {
  if (!e) return null
  return typeof e === 'string' ? e : (e.message || String(e))
}

module.exports = { TaskStateMachine, TASK_STATES, STEP_STATES }
