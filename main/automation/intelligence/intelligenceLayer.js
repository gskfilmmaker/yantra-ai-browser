'use strict'
const { executeTaskRaw }      = require('../executionOrchestrator')
const { resolveStepSelector } = require('./semanticMatcher')
const { describePageForFallback } = require('./visionDomFusion')
const taskMemory              = require('./taskMemory')
const { replan, classifyFailure } = require('./adaptivePlanner')

const MAX_REPLANS = 3  // maximum replan rounds before giving up

// ── Public entry point ────────────────────────────────────────────────────────
// Drop-in replacement for executeTask that adds:
//   • task memory (known selectors pre-loaded)
//   • semantic selector augmentation before first run
//   • adaptive replanning on failure (up to MAX_REPLANS rounds)
//   • vision fallback when DOM matching exhausted
//   • structured reasoning output attached to every response
//
// Returns a string (Markdown report + reasoning JSON block).

async function executeIntelligent(task) {
  const startMs  = Date.now()
  const wc       = _getWebContents()
  const url      = await _currentUrl(wc)

  const reasoning = {
    planAdjustments:          [],
    elementResolutionStrategy:'none',
    fallbackUsed:             null,
    confidence:               0.5,
    replansCount:             0,
    memoryHit:                false,
    memoryKey:                null,
    visionContexts:           [],   // screenshots captured during fallbacks
  }

  // ── 1. Task memory lookup ─────────────────────────────────────────────────
  const memKey = taskMemory.computeKey(task, url)
  reasoning.memoryKey = memKey
  const memEntry = taskMemory.lookup(memKey)

  let workingSteps = task.steps.map(s => ({ ...s }))  // defensive copy

  if (memEntry) {
    reasoning.memoryHit = true
    const { steps: augmented, appliedCount } = taskMemory.applyMemoryPatterns(task, memEntry)
    workingSteps = augmented
    if (appliedCount > 0) {
      reasoning.planAdjustments.push({
        type:   'memory_augmentation',
        detail: `Applied ${appliedCount} known selector(s) from prior runs on ${memEntry.domain}`,
      })
    }
  }

  // ── 2. Semantic pre-augmentation ──────────────────────────────────────────
  // For click/type steps, try to resolve semantic intents to concrete selectors
  // before the first run (cheap — avoids one failure round).
  if (wc) {
    const semResults = await _augmentStepsSemantics(workingSteps, wc)
    workingSteps = semResults.steps
    reasoning.planAdjustments.push(...semResults.adjustments)
    if (semResults.adjustments.length > 0) {
      reasoning.elementResolutionStrategy = 'semantic_pre_augmentation'
    }
  }

  // ── 3. Outer OAVR loop with adaptive replanning ───────────────────────────
  const passedIds      = new Set()
  let lastFormattedReport = ''
  let hadCaptcha = false

  for (let round = 0; round <= MAX_REPLANS; round++) {
    // Only run steps that haven't passed yet
    const pending = workingSteps.filter(s => !passedIds.has(s.id))
    if (!pending.length) break

    // Run the v2 orchestrator for the pending steps
    const { formatted, report } = await executeTaskRaw({
      id:    task.id   + (round > 0 ? `_r${round}` : ''),
      name:  task.name + (round > 0 ? ` (replan ${round})` : ''),
      steps: pending.map(s => ({ ...s, required: true })),
    })

    lastFormattedReport = formatted
    if (!report) break

    // Mark newly passed steps
    for (const sr of report.steps) {
      if (sr.state === 'passed') passedIds.add(sr.id)
    }

    // Check for CAPTCHA
    const captchaStep = report.steps.find(s =>
      /captcha|needs_human/i.test(s.error || '')
    )
    if (captchaStep) {
      hadCaptcha = true
      reasoning.fallbackUsed    = 'captcha_halt'
      reasoning.confidence      = 0.0
      break
    }

    // Find first failed step
    const failedReport = report.steps.find(s => s.state === 'failed')
    if (!failedReport) break  // all pending steps passed ✓

    if (round >= MAX_REPLANS) {
      reasoning.confidence = 0.10
      break
    }

    // ── Adaptive replan ────────────────────────────────────────────────────
    const replanResult = await replan(workingSteps, [failedReport], wc, passedIds)
    reasoning.replansCount++
    reasoning.planAdjustments.push(...replanResult.adjustments)

    // Capture vision contexts for any fallbacks that used screenshots
    for (const vf of (replanResult.visionFallbacks || [])) {
      if (vf.screenshot) reasoning.visionContexts.push(vf)
      if (!reasoning.fallbackUsed) reasoning.fallbackUsed = 'vision_dom_fusion'
    }

    // Hard abort (CAPTCHA, no tab, etc.)
    if (replanResult.abortReason) {
      reasoning.confidence = replanResult.abortReason === 'captcha' ? 0.0 : 0.05
      reasoning.fallbackUsed = replanResult.abortReason
      break
    }

    // Update working steps with the new plan
    workingSteps = replanResult.newSteps

    // Update resolution strategy label
    const semAdj = replanResult.adjustments.filter(a => a.type === 'selector_updated')
    const visAdj = replanResult.adjustments.filter(a => a.type === 'vision_fallback')
    if      (semAdj.length && !visAdj.length) reasoning.elementResolutionStrategy = 'semantic_fallback'
    else if (visAdj.length)                   reasoning.elementResolutionStrategy = 'vision_dom_fusion'
    else                                      reasoning.elementResolutionStrategy = 'structural_replan'
  }

  // ── 4. Final confidence calculation ──────────────────────────────────────
  const totalRequired  = task.steps.filter(s => s.required !== false).length
  const passedRequired = task.steps.filter(s => s.required !== false && passedIds.has(s.id)).length
  if (totalRequired > 0 && reasoning.confidence > 0.1) {
    const base = passedRequired / totalRequired
    const replanPenalty = reasoning.replansCount * 0.05
    reasoning.confidence = Math.round(Math.max(0.05, Math.min(0.99, base - replanPenalty)) * 100) / 100
  }

  // ── 5. Save to task memory ────────────────────────────────────────────────
  const allPassed = passedIds.size >= task.steps.length
  taskMemory.record(memKey, {
    task,
    url,
    passedIds,
    adjustments:  reasoning.planAdjustments,
    durationMs:   Date.now() - startMs,
    finalState:   hadCaptcha ? 'aborted' : (allPassed ? 'completed' : 'failed'),
    hadCaptcha,
  })

  // ── 6. Assemble final output ──────────────────────────────────────────────
  return _buildOutput(lastFormattedReport, reasoning, passedIds, task)
}

// ── Semantic pre-augmentation ─────────────────────────────────────────────────
// Attempts to resolve selectors for click/type steps before the first run.

async function _augmentStepsSemantics(steps, wc) {
  const augmented   = []
  const adjustments = []

  for (const step of steps) {
    if (!['click', 'type'].includes(step.type)) {
      augmented.push(step)
      continue
    }
    const { step: resolved, resolution } = await resolveStepSelector(wc, step)
    augmented.push(resolved)
    if (resolution) {
      adjustments.push({
        type:       'selector_pre_resolved',
        stepId:     step.id,
        to:         resolution.selector,
        method:     resolution.method,
        confidence: resolution.confidence,
      })
    }
  }

  return { steps: augmented, adjustments }
}

// ── Output builder ────────────────────────────────────────────────────────────

function _buildOutput(executorReport, reasoning, passedIds, task) {
  const reasoningBlock = {
    planAdjustments:           reasoning.planAdjustments.map(a => _summariseAdj(a)),
    elementResolutionStrategy: reasoning.elementResolutionStrategy,
    fallbackUsed:              reasoning.fallbackUsed,
    confidence:                reasoning.confidence,
    replansCount:              reasoning.replansCount,
    memoryHit:                 reasoning.memoryHit,
    stepsPassed:               passedIds.size,
    stepsTotal:                task.steps.length,
  }

  const sections = [
    executorReport,
    '',
    '---',
    '**Intelligence Layer Reasoning:**',
    '```json',
    JSON.stringify(reasoningBlock, null, 2),
    '```',
  ]

  // Append vision context summaries (without base64 to keep output readable)
  if (reasoning.visionContexts.length > 0) {
    sections.push('')
    sections.push('**Visual Fallback Context:**')
    for (const vf of reasoning.visionContexts) {
      sections.push(`- ${vf.description || '(visual context captured)'}`)
    }
  }

  return sections.join('\n')
}

function _summariseAdj(a) {
  switch (a.type) {
    case 'selector_updated':
      return { type: a.type, step: a.stepId, from: a.from, to: a.to, method: a.method, confidence: a.confidence }
    case 'selector_pre_resolved':
      return { type: a.type, step: a.stepId, to: a.to, method: a.method, confidence: a.confidence }
    case 'step_inserted':
      return { type: a.type, before: a.before, inserted: a.stepId, reason: a.reason }
    case 'param_modified':
      return { type: a.type, step: a.stepId, change: a.change }
    case 'memory_augmentation':
      return { type: a.type, detail: a.detail }
    case 'vision_fallback':
      return { type: a.type, step: a.stepId, reason: a.reason }
    case 'abort':
      return { type: a.type, step: a.stepId, reason: a.reason }
    default:
      return a
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _getWebContents() {
  try {
    const tm  = require('../../tabManager')
    const tab = tm.getActiveTab()
    return tab?.view?.webContents || null
  } catch { return null }
}

async function _currentUrl(wc) {
  if (!wc) return ''
  try { return await wc.executeJavaScript('location.href') } catch { return '' }
}

module.exports = { executeIntelligent }
