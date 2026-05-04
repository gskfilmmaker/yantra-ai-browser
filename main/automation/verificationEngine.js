'use strict'
const { snapshotDiff, waitForElement } = require('./observeEngine')

// ── Main entry point ──────────────────────────────────────────────────────────
// Verifies whether a step succeeded by applying explicit rules (step.verify)
// or falling back to heuristics based on step type.
//
// Parameters:
//   step        — the step object (type, params, verify rules)
//   before      — DOM snapshot taken before the action
//   after       — DOM snapshot taken after the action
//   toolResult  — string returned by the tool
//   webContents — optional; needed only for live element-presence checks
//
// Returns: { passed, confidence, reason, checks }

async function verify(step, before, after, toolResult, webContents) {
  const rules = step.verify

  // ── Explicit error from tool output ──────────────────────────────────────────
  const resultStr = typeof toolResult === 'string' ? toolResult : ''
  if (isToolError(resultStr)) {
    return {
      passed:     false,
      confidence: 'high',
      reason:     `Tool returned error: ${resultStr.slice(0, 120)}`,
      checks:     [{ rule: 'tool_error', passed: false, detail: resultStr.slice(0, 120) }],
    }
  }

  // ── CAPTCHA detected after action ────────────────────────────────────────────
  if (after?.hasCaptcha && !before?.hasCaptcha) {
    return {
      passed:     false,
      confidence: 'high',
      reason:     'CAPTCHA appeared after action — human intervention required',
      checks:     [{ rule: 'captcha_guard', passed: false }],
    }
  }

  // ── No explicit rules → use heuristics ───────────────────────────────────────
  if (!rules || !Object.keys(rules).length) {
    return heuristicVerify(step, before, after, resultStr)
  }

  // ── Apply explicit rules ──────────────────────────────────────────────────────
  const checks = await applyRules(rules, before, after, resultStr, webContents)
  const failed  = checks.filter(c => !c.passed)

  return {
    passed:       failed.length === 0,
    confidence:   failed.length === 0 ? 'high' : (failed.length < checks.length ? 'medium' : 'high'),
    reason:       failed.length === 0
                    ? `All ${checks.length} check(s) passed`
                    : failed.map(c => c.detail || c.rule).join('; '),
    checks,
    failedChecks: failed,
  }
}

// ── Rule runners ──────────────────────────────────────────────────────────────

async function applyRules(rules, before, after, resultStr, webContents) {
  const checks = []

  if (rules.urlChanged)     checks.push(checkUrlChanged(before, after))
  if (rules.urlContains)    checks.push(checkUrlContains(after, rules.urlContains))
  if (rules.urlMatches)     checks.push(checkUrlMatches(after, rules.urlMatches))
  if (rules.textPresent)    checks.push(checkTextPresent(after, rules.textPresent))
  if (rules.textAbsent)     checks.push(checkTextAbsent(after, rules.textAbsent))
  if (rules.pageChanged)    checks.push(checkPageChanged(before, after))
  if (rules.noError)        checks.push(checkNoError(after))
  if (rules.resultContains) checks.push(checkResultContains(resultStr, rules.resultContains))
  if (rules.inputValue)     checks.push(checkInputValue(after, rules.inputValue))

  // Element presence/absence needs live DOM check when webContents is available
  if (rules.elementPresent) {
    checks.push(await checkElementLive(webContents, rules.elementPresent, true))
  }
  if (rules.elementAbsent) {
    checks.push(await checkElementLive(webContents, rules.elementAbsent, false))
  }

  return checks
}

// ── Individual checks ─────────────────────────────────────────────────────────

function checkUrlChanged(before, after) {
  const passed = !!before && !!after && before.url !== after.url
  return {
    rule:   'urlChanged',
    passed,
    detail: passed ? `URL changed: ${before?.url} → ${after?.url}` : `URL unchanged: ${after?.url}`,
  }
}

function checkUrlContains(after, substr) {
  const passed = (after?.url || '').includes(substr)
  return {
    rule:   'urlContains',
    passed,
    detail: `URL "${after?.url}" ${passed ? 'contains' : 'missing'} "${substr}"`,
  }
}

function checkUrlMatches(after, pattern) {
  let passed = false
  try { passed = new RegExp(pattern, 'i').test(after?.url || '') } catch { /* bad regex */ }
  return {
    rule:   'urlMatches',
    passed,
    detail: `URL "${after?.url}" vs pattern "${pattern}"`,
  }
}

function checkTextPresent(after, text) {
  const body   = (after?.bodyText || '').toLowerCase()
  const passed = body.includes(text.toLowerCase())
  return {
    rule:   'textPresent',
    passed,
    detail: `"${text}" ${passed ? 'found' : 'not found'} in page text`,
  }
}

function checkTextAbsent(after, text) {
  const body   = (after?.bodyText || '').toLowerCase()
  const passed = !body.includes(text.toLowerCase())
  return {
    rule:   'textAbsent',
    passed,
    detail: `"${text}" ${passed ? 'absent (good)' : 'still present'} in page text`,
  }
}

function checkPageChanged(before, after) {
  const diff    = snapshotDiff(before, after)
  const changed = diff.urlChanged || diff.textChanged || Math.abs(diff.elementDelta) > 2 || diff.titleChanged
  return {
    rule:   'pageChanged',
    passed: changed,
    detail: `urlChanged=${diff.urlChanged} textChanged=${diff.textChanged} elementDelta=${diff.elementDelta}`,
  }
}

function checkNoError(after) {
  const passed = !after?.hasError
  return {
    rule:   'noError',
    passed,
    detail: passed ? 'No error signals on page' : 'Error detected in page title/body',
  }
}

function checkResultContains(resultStr, text) {
  const passed = resultStr.includes(text)
  return {
    rule:   'resultContains',
    passed,
    detail: `Tool result ${passed ? 'contains' : 'missing'} "${text}"`,
  }
}

function checkInputValue(after, expectedMap) {
  if (typeof expectedMap !== 'object') return { rule: 'inputValue', passed: true, confidence: 'low' }
  const vals    = after?.inputValues || {}
  const entries = Object.entries(expectedMap)
  const results = entries.map(([k, v]) => ({ k, expected: v, actual: vals[k] || '', match: (vals[k] || '').includes(String(v)) }))
  const passed  = results.every(r => r.match)
  return {
    rule:   'inputValue',
    passed,
    detail: results.map(r => `${r.k}: expected "${r.expected}" got "${r.actual}"`).join(', '),
  }
}

async function checkElementLive(webContents, selector, shouldBePresent) {
  if (!webContents) {
    return {
      rule:       shouldBePresent ? 'elementPresent' : 'elementAbsent',
      passed:     true,
      confidence: 'low',
      detail:     'Live check skipped (no webContents)',
    }
  }
  // Short timeout — we're doing a spot-check, not a full wait
  const res = await waitForElement(webContents, selector, { timeout: 2000, present: shouldBePresent })
  const passed = res.found === shouldBePresent
  return {
    rule:   shouldBePresent ? 'elementPresent' : 'elementAbsent',
    passed,
    detail: `Selector "${selector}" ${res.found ? 'present' : 'absent'} (expected: ${shouldBePresent ? 'present' : 'absent'})`,
  }
}

// ── Heuristic verification ────────────────────────────────────────────────────
// Applied when no explicit rules are set. Uses step type + snapshot diff to
// infer success with a confidence level.

function heuristicVerify(step, before, after, resultStr) {
  const diff = snapshotDiff(before, after)

  switch (step.type) {
    case 'navigate': {
      const passed = diff.urlChanged
      return { passed, confidence: 'high', reason: passed ? `URL changed to ${after?.url}` : 'URL did not change after navigation' }
    }

    case 'click': {
      // Any observable change counts as success for a click
      const changed = diff.urlChanged || diff.textChanged || Math.abs(diff.elementDelta) > 0
      return {
        passed:     changed,
        confidence: changed ? 'medium' : 'low',
        reason:     changed ? 'DOM or URL changed after click' : 'No observable change after click',
      }
    }

    case 'type': {
      // Type very rarely fails silently — only fail if tool explicitly errored
      return { passed: true, confidence: 'medium', reason: 'Type action completed without error' }
    }

    case 'extract_table':
    case 'extract_entities':
    case 'extract': {
      const hasData = resultStr.length > 20
        && !resultStr.toLowerCase().includes('no tables found')
        && !resultStr.toLowerCase().includes('no entities')
      return { passed: hasData, confidence: 'high', reason: hasData ? 'Extraction returned data' : 'Extraction returned no data' }
    }

    case 'wait': {
      const timedOut = resultStr.toLowerCase().includes('timeout') || resultStr.toLowerCase().includes('not found')
      return { passed: !timedOut, confidence: 'high', reason: resultStr.slice(0, 100) }
    }

    case 'screenshot': {
      const passed = resultStr.startsWith('data:image')
      return { passed, confidence: 'high', reason: passed ? 'Screenshot captured' : 'Screenshot failed' }
    }

    default: {
      // Generic: if tool returned something non-empty and non-error, pass
      const passed = resultStr.length > 0
      return { passed, confidence: 'low', reason: passed ? 'Tool returned output' : 'Tool returned empty result' }
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isToolError(str) {
  if (!str) return false
  const lower = str.toLowerCase()
  return (
    lower.startsWith('error') ||
    lower.startsWith('tool error') ||
    lower.includes('no browser tab active') ||
    lower.includes('could not find element') ||
    lower.includes('bad selector') ||
    lower.includes('element not found')
  )
}

module.exports = { verify }
