'use strict'
const { findElement }        = require('./semanticMatcher')
const { describePageForFallback } = require('./visionDomFusion')
const { sleep }              = require('../observeEngine')

// ── Failure classification ────────────────────────────────────────────────────
// Maps a failed step report to a typed failure reason + recommended action.

const FAILURE_RULES = [
  {
    test: s => /captcha|needs_human/i.test(_err(s)),
    type: 'captcha',
    action: 'abort',
  },
  {
    test: s => /no browser tab active|no active tab/i.test(_err(s)),
    type: 'no_tab',
    action: 'abort',
  },
  {
    test: s => /element not found|could not find|bad selector/i.test(_err(s)),
    type: 'element_not_found',
    action: 'semantic_match',
  },
  {
    test: s => /url did not change|url unchanged/i.test(_err(s)),
    type: 'navigation_failed',
    action: 'wait_and_retry',
  },
  {
    test: s => s.type === 'click' && /no observable change/i.test(_err(s)),
    type: 'click_ineffective',
    action: 'semantic_match_with_scroll',
  },
  {
    test: s => /timeout|not found within/i.test(_err(s)),
    type: 'timeout',
    action: 'extend_wait',
  },
  {
    test: s => /no tables found|no entities|no data/i.test(_err(s)),
    type: 'no_data',
    action: 'scroll_to_content',
  },
  {
    test: s => /error detected|error in page/i.test(_err(s)),
    type: 'page_error',
    action: 'navigate_back',
  },
]

function classifyFailure(stepReport) {
  for (const rule of FAILURE_RULES) {
    if (rule.test(stepReport)) return { type: rule.type, action: rule.action }
  }
  return { type: 'unknown', action: 'semantic_match' }
}

// ── Recovery generators ───────────────────────────────────────────────────────
// Each returns { recoveredSteps: Step[], adjustments: Adjustment[], abort: bool }

async function recoverElementNotFound(step, webContents) {
  const intent   = step.params?.text || step.params?.goal || step.params?.selector || ''
  const adjustments = []

  if (!intent || !webContents) {
    // No hint to search by — try vision fallback
    const visual = await describePageForFallback(webContents)
    adjustments.push({
      type:          'vision_fallback',
      stepId:        step.id,
      reason:        'No search intent; using visual context',
      visualSummary: visual.description,
      screenshot:    visual.screenshot,
    })
    // Return original step unchanged — intelligence layer will surface visual context
    return { recoveredSteps: [step], adjustments, visionFallback: visual }
  }

  const match = await findElement(webContents, intent)

  if (match.found && match.confidence >= 0.45) {
    const recovered = {
      ...step,
      id:     step.id + '_sem',
      params: { ...step.params, selector: match.selector },
      maxRetries:    1,
      retryStrategy: 'immediate',
    }
    adjustments.push({
      type:       'selector_updated',
      stepId:     step.id,
      from:       step.params?.selector || '(none)',
      to:         match.selector,
      method:     match.method,
      confidence: match.confidence,
    })
    return { recoveredSteps: [recovered], adjustments }
  }

  // Low confidence — try vision fallback
  const visual = await describePageForFallback(webContents)
  adjustments.push({
    type:          'vision_fallback',
    stepId:        step.id,
    reason:        `Semantic match confidence too low (${match.confidence})`,
    visualSummary: visual.description,
    screenshot:    visual.screenshot,
  })
  return { recoveredSteps: [step], adjustments, visionFallback: visual }
}

async function recoverClickIneffective(step, webContents) {
  // Insert a scroll step before click, then reattempt with semantic matching
  const scrollStep = {
    id:            `scroll_before_${step.id}`,
    type:          'scroll',
    params:        { direction: 'down', amount: 400 },
    required:      false,
    maxRetries:    0,
    retryStrategy: 'immediate',
  }

  const { recoveredSteps: matched, adjustments: semAdj } =
    await recoverElementNotFound(step, webContents)

  return {
    recoveredSteps: [scrollStep, ...matched],
    adjustments: [
      { type: 'step_inserted', before: step.id, stepId: scrollStep.id, reason: 'scroll before retry' },
      ...semAdj,
    ],
  }
}

function recoverNavigationFailed(step) {
  // Insert a 2s wait step before re-navigating
  const waitStep = {
    id:            `wait_before_${step.id}`,
    type:          'wait',
    params:        { selector: 'body', timeout: 2000 },
    required:      false,
    maxRetries:    0,
    retryStrategy: 'immediate',
  }
  const recovered = { ...step, id: step.id + '_retry', maxRetries: 1, retryDelayMs: 1000 }
  return {
    recoveredSteps: [waitStep, recovered],
    adjustments: [
      { type: 'step_inserted', before: step.id, stepId: waitStep.id, reason: 'wait before re-navigate' },
      { type: 'step_modified', stepId: step.id, change: 'added retry' },
    ],
  }
}

function recoverTimeout(step) {
  // Double the timeout (or use a sensible floor)
  const currentTimeout = step.params?.timeout || 5000
  const newTimeout     = Math.min(currentTimeout * 2, 15000)
  const recovered = {
    ...step,
    id:     step.id + '_ext',
    params: { ...step.params, timeout: newTimeout },
    maxRetries: 1,
  }
  return {
    recoveredSteps: [recovered],
    adjustments: [{
      type:    'param_modified',
      stepId:  step.id,
      change:  `timeout ${currentTimeout}ms → ${newTimeout}ms`,
    }],
  }
}

function recoverScrollToContent(step) {
  const scrollStep = {
    id:            `scroll_bottom_before_${step.id}`,
    type:          'scroll',
    params:        { direction: 'bottom' },
    required:      false,
    maxRetries:    0,
    retryStrategy: 'immediate',
  }
  const recovered = { ...step, id: step.id + '_after_scroll', maxRetries: 1 }
  return {
    recoveredSteps: [scrollStep, recovered],
    adjustments: [
      { type: 'step_inserted', before: step.id, stepId: scrollStep.id, reason: 'scroll to load lazy content' },
    ],
  }
}

function recoverPageError(step) {
  // Insert a navigate-back step to escape the error page
  const backStep = {
    id:            `back_before_${step.id}`,
    type:          'navigate',
    params:        { url: 'javascript:history.back()' },
    required:      false,
    maxRetries:    0,
    retryStrategy: 'immediate',
  }
  const waitStep = {
    id:            `wait_after_back_${step.id}`,
    type:          'wait',
    params:        { selector: 'body', timeout: 2000 },
    required:      false,
    maxRetries:    0,
    retryStrategy: 'immediate',
  }
  return {
    recoveredSteps: [backStep, waitStep, { ...step, id: step.id + '_retry' }],
    adjustments: [
      { type: 'step_inserted', before: step.id, stepId: backStep.id, reason: 'navigate back from error page' },
    ],
  }
}

// ── Main replan entry point ───────────────────────────────────────────────────
// Accepts: currentSteps (the full step list), failedStepReports (from SM report),
//          webContents (for live DOM queries), passedIds (Set of already-passed step IDs)
// Returns: { newSteps, adjustments, abortReason, visionFallbacks }

async function replan(currentSteps, failedStepReports, webContents, passedIds = new Set()) {
  const allAdjustments = []
  const visionFallbacks = []
  const replacements = new Map()  // old step id → recovered steps[]

  for (const failedReport of failedStepReports) {
    const original = currentSteps.find(s => s.id === failedReport.id)
    if (!original) continue

    const classification = classifyFailure(failedReport)

    // Hard abort conditions
    if (classification.action === 'abort') {
      return {
        newSteps:     currentSteps,
        adjustments:  [{ type: 'abort', stepId: failedReport.id, reason: classification.type }],
        abortReason:  classification.type,
        visionFallbacks,
      }
    }

    let recovery
    switch (classification.action) {
      case 'semantic_match':
        recovery = await recoverElementNotFound(original, webContents)
        break
      case 'semantic_match_with_scroll':
        recovery = await recoverClickIneffective(original, webContents)
        break
      case 'wait_and_retry':
        recovery = recoverNavigationFailed(original)
        break
      case 'extend_wait':
        recovery = recoverTimeout(original)
        break
      case 'scroll_to_content':
        recovery = recoverScrollToContent(original)
        break
      case 'navigate_back':
        recovery = recoverPageError(original)
        break
      default:
        recovery = await recoverElementNotFound(original, webContents)
    }

    allAdjustments.push(...recovery.adjustments)
    if (recovery.visionFallback) visionFallbacks.push(recovery.visionFallback)
    replacements.set(original.id, recovery.recoveredSteps)
  }

  // Rebuild step list: keep passed steps as-is, replace failed with recovered,
  // keep downstream steps (they'll re-run after the recovery steps)
  const newSteps = []
  for (const step of currentSteps) {
    if (passedIds.has(step.id)) {
      // Already passed — skip (don't re-run)
      continue
    }
    const recovered = replacements.get(step.id)
    if (recovered) {
      newSteps.push(...recovered)
    } else {
      newSteps.push(step)
    }
  }

  return { newSteps, adjustments: allAdjustments, abortReason: null, visionFallbacks }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _err(stepReport) {
  return [
    stepReport.error || '',
    stepReport.verification?.reason || '',
    (stepReport.verification?.failedChecks || []).map(c => c.detail || '').join(' '),
  ].join(' ')
}

module.exports = { replan, classifyFailure }
