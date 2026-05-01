'use strict'
const { TaskStateMachine, TASK_STATES, STEP_STATES } = require('./taskStateMachine')
const observe  = require('./observeEngine')
const { verify }       = require('./verificationEngine')
const { RetryEngine }  = require('./retryEngine')
const registry = require('../tools/registry')

const retryEngine = new RetryEngine()

// ── Step type → registry tool name ───────────────────────────────────────────
const STEP_TO_TOOL = {
  navigate:         'open_url',
  click:            'clickElement',
  type:             'typeInField',
  press_key:        'pressKey',
  scroll:           'scrollPage',
  wait:             'waitForElement',
  screenshot:       'captureScreenshot',
  get_structure:    'getPageStructure',
  extract_table:    'extractTable',
  extract_entities: 'extractEntities',
  extract_text:     'getSelectedText',
  fetch:            'fetch_webpage',
  detect_captcha:   'detectCaptcha',
  confirm:          'confirmAction',
}

// ── Main entry point ──────────────────────────────────────────────────────────
// Accepts a task object: { id?, name?, steps: [ { type, params, verify?, ... } ] }
// Returns a formatted string report (compatible with Anthropic tool_result).

async function executeTask(task) {
  if (!Array.isArray(task.steps) || task.steps.length === 0) {
    return 'Error: task.steps must be a non-empty array.'
  }

  const sm  = new TaskStateMachine(task)
  const wc  = _getWebContents()        // may be null for non-browser tabs
  const ctx = { webContents: wc }

  sm.start()

  for (let i = 0; i < sm.steps.length; i++) {
    const step = sm.beginStep(i)

    try {
      // ── 1. OBSERVE before ──────────────────────────────────────────────────
      sm.stepObserving(i)
      const before      = await observe.snapshot(wc)
      step.beforeSnapshot = before

      // ── 1b. CAPTCHA guard ──────────────────────────────────────────────────
      if (before?.hasCaptcha) {
        sm.stepFailed(i, 'CAPTCHA detected before step — automation paused')
        if (step.required) {
          sm.fail('CAPTCHA requires human intervention')
          return _formatReport(sm)
        }
        sm.stepSkipped(i, 'captcha_block')
        continue
      }

      // ── 2. ACT ────────────────────────────────────────────────────────────
      const toolResult = await _executeAction(step)
      step.result      = toolResult

      // ── 3. POST-ACT WAIT (intelligent, type-aware) ───────────────────────
      await _postActWait(step, wc, before)

      // ── 4. OBSERVE after ──────────────────────────────────────────────────
      const after       = await observe.snapshot(wc)
      step.afterSnapshot = after

      // ── 5. VERIFY ─────────────────────────────────────────────────────────
      sm.stepVerifying(i, null)
      const v1 = await verify(step, before, after, toolResult, wc)
      sm.stepVerifying(i, v1)

      if (v1.passed) {
        sm.stepPassed(i, toolResult)
        continue
      }

      // ── 6. RETRY LOOP ─────────────────────────────────────────────────────
      let finallyPassed = false

      for (let attempt = 1; attempt <= step.maxRetries; attempt++) {
        const shouldRetry = retryEngine.shouldRetry(step, v1.reason || 'verification failed', attempt)
        if (!shouldRetry) break

        const strategy = retryEngine.getStrategyName(step, attempt)
        sm.stepRetrying(i, attempt, strategy)

        await retryEngine.prepareRetry(step, attempt, registry)

        const retryResult = await _executeAction(step)
        step.result       = retryResult

        await _postActWait(step, wc, before)

        const retryAfter = await observe.snapshot(wc)
        step.afterSnapshot = retryAfter

        const vR = await verify(step, before, retryAfter, retryResult, wc)
        sm.stepVerifying(i, vR)

        if (vR.passed) {
          sm.stepPassed(i, retryResult)
          finallyPassed = true
          break
        }
      }

      if (!finallyPassed) {
        const lastV      = step.verification
        const failReason = lastV?.reason || lastV?.failedChecks?.map(c => c.detail).join('; ') || 'Verification failed'
        sm.stepFailed(i, failReason)

        if (step.required) {
          sm.fail(`Required step "${step.id}" failed: ${failReason}`)
          return _formatReport(sm)
        }
      }

    } catch (err) {
      sm.stepFailed(i, err)
      if (step.required) {
        sm.fail(`Required step "${step.id}" threw: ${err.message}`)
        return _formatReport(sm)
      }
    }
  }

  // All steps processed — determine final task state
  const anyRequired = sm.steps.some(s => s.required && s.state === STEP_STATES.FAILED)
  if (anyRequired) {
    sm.fail('One or more required steps failed')
  } else {
    sm.complete()
  }

  return _formatReport(sm)
}

// ── Step action dispatcher ────────────────────────────────────────────────────
async function _executeAction(step) {
  const toolName = STEP_TO_TOOL[step.type]
  if (!toolName) {
    const valid = Object.keys(STEP_TO_TOOL).join(', ')
    throw new Error(`Unknown step type: "${step.type}". Valid types: ${valid}`)
  }
  return await registry.execute(toolName, step.params || {})
}

// ── Post-action wait ──────────────────────────────────────────────────────────
// Chooses the right waiting strategy based on what the step type is likely
// to trigger in the browser.
async function _postActWait(step, wc, beforeSnap) {
  if (!wc) return

  switch (step.type) {
    case 'navigate': {
      // Wait for URL to change from the before-URL, then for the page to load
      const fromUrl = beforeSnap?.url
      if (fromUrl) {
        await observe.waitForNavigation(wc, { fromUrl, timeout: 12000 })
      }
      break
    }

    case 'click': {
      // Wait for any DOM change (navigation OR content update) to settle
      const changed = await observe.waitForDOMChange(wc, { timeout: 4000, stable: 350 })
      if (!changed.changed) {
        // If nothing moved, might be a navigation — wait a bit anyway
        await observe.sleep(400)
      }
      break
    }

    case 'type': {
      // React/Vue frameworks process input events; give them a tick
      await observe.sleep(150)
      break
    }

    case 'press_key': {
      // Enter may trigger form submit / navigation
      if (step.params?.key === 'Enter') {
        await observe.waitForDOMChange(wc, { timeout: 3000, stable: 300 })
      } else {
        await observe.sleep(100)
      }
      break
    }

    case 'wait': {
      // waitForElement already waited internally — no extra sleep needed
      await observe.sleep(150)
      break
    }

    default: {
      await observe.sleep(300)
      break
    }
  }
}

// ── WebContents helper ────────────────────────────────────────────────────────
function _getWebContents() {
  try {
    const tm  = require('../tabManager')
    const tab = tm.getActiveTab()
    return tab?.view?.webContents || null
  } catch { return null }
}

// ── Report formatter ──────────────────────────────────────────────────────────
function _formatReport(sm) {
  const r     = sm.getReport()
  const ICONS = { passed: '✅', failed: '❌', skipped: '⏭', pending: '⏳', retrying: '🔄', running: '▶️' }
  const stateLabel = { completed: '✅ COMPLETED', failed: '❌ FAILED', aborted: '⛔ ABORTED', running: '▶ RUNNING' }

  const lines = [
    `**Task: ${r.name}** — ${stateLabel[r.state] || r.state.toUpperCase()}`,
    `Steps: ${r.summary.passed}✅ passed  ${r.summary.failed}❌ failed  ${r.summary.skipped}⏭ skipped  (${r.summary.total} total)`,
    r.durationMs ? `Duration: ${(r.durationMs / 1000).toFixed(1)}s` : '',
    '',
  ]

  for (const s of r.steps) {
    const icon     = ICONS[s.state] || '•'
    const retries  = s.retryCount > 0 ? ` · ${s.retryCount} retr${s.retryCount === 1 ? 'y' : 'ies'}` : ''
    const duration = s.durationMs != null ? ` · ${(s.durationMs / 1000).toFixed(1)}s` : ''
    lines.push(`${icon} **${s.id}** \`[${s.type}]\`${retries}${duration}`)

    if (typeof s.result === 'string' && s.result.length > 0) {
      // Truncate long results (e.g. screenshot data)
      const preview = s.result.startsWith('data:image') ? '[screenshot captured]' : s.result.slice(0, 160)
      lines.push(`   → ${preview}`)
    }
    if (s.error) {
      lines.push(`   ⚠ ${s.error}`)
    }
    if (s.verification && !s.verification.passed && s.verification.reason) {
      lines.push(`   ✗ ${s.verification.reason}`)
    }
  }

  // Compact JSON summary at the bottom for programmatic consumers
  lines.push('', '```json', JSON.stringify({
    taskId:   r.taskId,
    state:    r.state,
    summary:  r.summary,
    duration: r.durationMs,
  }, null, 2), '```')

  return lines.filter(l => l !== null).join('\n')
}

module.exports = { executeTask }
