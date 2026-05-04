'use strict'
const { sleep } = require('./observeEngine')

// ── Strategy definitions ──────────────────────────────────────────────────────
// Each strategy controls how long to wait and what pre-action to run before
// retrying the failed step.

const STRATEGIES = {
  // Retry immediately with the same params
  immediate: {
    delay:     () => 0,
    preAction: null,
  },
  // Wait a fixed 1.5 s then retry
  wait: {
    delay:     () => 1500,
    preAction: null,
  },
  // Wait longer (3 s) — for slower pages or API-driven content
  wait_long: {
    delay:     () => 3000,
    preAction: null,
  },
  // Exponential backoff: 1 s, 2 s, 4 s … capped at 10 s
  exponential: {
    delay:     (attempt) => Math.min(1000 * (2 ** (attempt - 1)), 10000),
    preAction: null,
  },
  // Scroll the target element into the viewport before retrying
  scroll_and_retry: {
    delay:     () => 600,
    preAction: 'scroll',
  },
  // Re-fetch the page structure and try to recover a better CSS selector
  refetch_structure: {
    delay:     () => 800,
    preAction: 'refetch',
  },
}

class RetryEngine {

  // ── shouldRetry ───────────────────────────────────────────────────────────────
  // Returns true if the step should be retried given the error and attempt count.
  shouldRetry(step, errorOrReason, attemptCount) {
    if (attemptCount >= (step.maxRetries || 2)) return false

    const msg = errorMsg(errorOrReason).toLowerCase()

    // Hard stops — never retry these
    if (msg.includes('no browser tab active'))              return false
    if (msg.includes('captcha') || msg.includes('needs_human')) return false
    if (msg.includes('403') || msg.includes('forbidden'))   return false
    if (/bad selector/.test(msg))                           return false

    // Retry these transient conditions
    if (msg.includes('element not found'))    return true
    if (msg.includes('could not find'))       return true
    if (msg.includes('timeout'))              return true
    if (msg.includes('detached'))             return true
    if (msg.includes('verification failed'))  return true
    if (msg.includes('no observable change')) return true
    if (msg.includes('url did not change'))   return true

    // Unknown failure — retry up to maxRetries
    return true
  }

  // ── getStrategyName ───────────────────────────────────────────────────────────
  // Escalates the strategy on later attempts: first retry uses the step's own
  // strategy; subsequent retries escalate to refetch_structure.
  getStrategyName(step, attempt) {
    if (attempt >= 2) return 'refetch_structure'
    return step.retryStrategy || 'wait'
  }

  // ── prepareRetry ──────────────────────────────────────────────────────────────
  // Executes pre-actions and waits before the retry. May mutate step.params
  // in-place (e.g. updated selector from refetch).
  // Returns the (possibly modified) step.
  async prepareRetry(step, attempt, registry) {
    const stratName = this.getStrategyName(step, attempt)
    const strategy  = STRATEGIES[stratName] || STRATEGIES.wait

    // Wait
    const delay = strategy.delay(attempt)
    if (delay > 0) await sleep(delay)

    // Pre-action
    if (strategy.preAction === 'scroll' && step.params?.selector) {
      try {
        // Scroll down slightly to bring hidden elements into view
        await registry.execute('scrollPage', { direction: 'down', amount: 300 })
        await sleep(300)
      } catch { /* non-fatal */ }
    }

    if (strategy.preAction === 'refetch') {
      try {
        const structure = await registry.execute('getPageStructure', {})
        const recovered = recoverSelector(step, structure)
        if (recovered) {
          step.params = { ...step.params, selector: recovered }
          step.log.push({
            type: 'selector_recovered',
            original: step.params.selector,
            recovered,
            ts: new Date().toISOString(),
          })
        }
      } catch { /* non-fatal */ }
    }

    return step
  }
}

// ── Selector recovery ─────────────────────────────────────────────────────────
// Parses getPageStructure output looking for an element whose visible text
// matches the step's `text` param. Returns the first matching selector string,
// or null if nothing is found.

function recoverSelector(step, structureText) {
  // Only makes sense for click/type steps with a text hint
  const target = (step.params?.text || '').toLowerCase().trim()
  if (!target || !structureText) return null

  for (const line of structureText.split('\n')) {
    if (line.toLowerCase().includes(target)) {
      // getPageStructure lines look like: • "Submit" → selector: `#submit`
      const m = line.match(/selector:\s*`([^`]+)`/)
      if (m) return m[1]
    }
  }
  return null
}

function errorMsg(e) {
  if (!e) return ''
  if (typeof e === 'string') return e
  return e.message || String(e)
}

module.exports = { RetryEngine }
