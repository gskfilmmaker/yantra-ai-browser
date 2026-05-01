'use strict'

// ── Browser-side element scoring function ─────────────────────────────────────
// Serialised and injected into the renderer via executeJavaScript.
// Must be completely self-contained — no closure references allowed.
function _searchFn(params) {
  function buildSelector(el) {
    if (el.id) {
      try { return '#' + CSS.escape(el.id) } catch (e) { return '#' + el.id }
    }
    var tag  = el.tagName.toLowerCase()
    var aria = el.getAttribute('aria-label')
    if (aria)           return tag + '[aria-label=' + JSON.stringify(aria) + ']'
    var name = el.getAttribute('name')
    if (name)           return tag + '[name=' + JSON.stringify(name) + ']'
    var role = el.getAttribute('role')
    if (role)           return tag + '[role=' + JSON.stringify(role) + ']'
    var typ  = el.getAttribute('type')
    if (typ && typ !== 'text' && typ !== 'hidden') return tag + '[type=' + JSON.stringify(typ) + ']'
    var cls  = (el.className || '').trim().split(/\s+/).slice(0, 2).join('.')
    if (cls) return tag + '.' + cls
    return tag
  }

  function scoreEl(el, goal, roleHint, typeHint, ariaHint) {
    var text  = (el.innerText || el.value || el.placeholder || '').trim().toLowerCase().slice(0, 120)
    var aria  = (el.getAttribute('aria-label') || '').toLowerCase()
    var title = (el.getAttribute('title')      || '').toLowerCase()
    var ph    = (el.getAttribute('placeholder')|| '').toLowerCase()
    var name  = (el.getAttribute('name')       || '').toLowerCase()
    var role  = (el.getAttribute('role') || el.tagName).toLowerCase()
    var s     = 0

    // Text matching — tiered by exactness
    if (text === goal)                       s += 1.00
    else if (text.startsWith(goal))          s += 0.85
    else if (text.includes(goal))            s += 0.70
    else if (goal.includes(text) && text.length > 2) s += 0.55

    // Aria-label matching
    if (aria === goal)                       s += 0.95
    else if (aria.includes(goal))            s += 0.72

    // Title and placeholder
    if (title === goal)                      s += 0.80
    else if (title.includes(goal))           s += 0.58
    if (ph.includes(goal))                   s += 0.52

    // Name attribute
    if (name === goal)                       s += 0.60
    else if (name.includes(goal))            s += 0.40

    // Caller-supplied aria hint
    if (ariaHint && aria.includes(ariaHint)) s += 0.30

    // Role / type filters (penalise mismatches)
    if (roleHint && role !== roleHint)       s *= 0.50
    if (typeHint && el.type !== typeHint)    s *= 0.50

    // Prefer visible elements
    var r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0)    s *= 0.10
    if (r.top > window.innerHeight)         s *= 0.60

    return Math.round(s * 100) / 100
  }

  var tags = [
    'button', 'a', '[role="button"]', '[role="link"]', '[role="tab"]',
    '[role="menuitem"]', '[role="option"]', '[role="checkbox"]', '[role="radio"]',
    'input:not([type="hidden"])', 'textarea', 'select', 'label',
    '[onclick]', '[tabindex]',
  ].join(',')

  var els = Array.from(document.querySelectorAll(tags))

  return els.map(function(el) {
    var s = scoreEl(el, params.goal, params.role, params.type, params.ariaLabel)
    if (s <= 0) return null
    var r = el.getBoundingClientRect()
    return {
      selector:  buildSelector(el),
      text:      (el.innerText || el.value || el.placeholder || '').trim().slice(0, 80),
      ariaLabel: el.getAttribute('aria-label') || '',
      role:      el.getAttribute('role') || el.tagName.toLowerCase(),
      type:      el.type || '',
      rect:      { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      visible:   r.width > 0 && r.height > 0,
      confidence: s,
    }
  })
  .filter(Boolean)
  .sort(function(a, b) { return b.confidence - a.confidence })
  .slice(0, 6)
}

// ── Public API ────────────────────────────────────────────────────────────────

// Find the best DOM element matching an intent.
// intent: string | { goal, role?, type?, ariaLabel?, near? }
// Returns: { found, selector, confidence, method, element, alternatives }
async function findElement(webContents, intent) {
  if (!webContents) return { found: false, reason: 'no_webcontents' }

  const goal     = (typeof intent === 'string' ? intent : (intent.goal || intent.text || '')).toLowerCase().trim()
  const params   = JSON.stringify({
    goal,
    role:      (intent.role      || '').toLowerCase(),
    type:      (intent.type      || ''),
    ariaLabel: (intent.ariaLabel || '').toLowerCase(),
  })

  try {
    const candidates = await webContents.executeJavaScript(
      `(${_searchFn.toString()})(${params})`
    )

    if (!candidates || !candidates.length) {
      return { found: false, reason: `No DOM element matches "${goal}"`, candidates: [] }
    }

    const best = candidates[0]
    if (best.confidence < 0.35) {
      return { found: false, reason: `Best match "${best.text}" confidence too low (${best.confidence})`, candidates }
    }

    return {
      found:        true,
      selector:     best.selector,
      confidence:   best.confidence,
      method:       _resolveMethod(best),
      element:      best,
      alternatives: candidates.slice(1),
    }
  } catch (e) {
    return { found: false, reason: e.message, candidates: [] }
  }
}

// Augment a click/type step with the best available selector using semantic search.
// Falls back to the original params if confidence is too low.
async function resolveStepSelector(webContents, step) {
  if (!webContents) return { step, resolution: null }
  if (!['click', 'type'].includes(step.type)) return { step, resolution: null }

  // Use text param as the primary intent signal; fall back to selector text content
  const intent = step.params?.text || step.params?.goal || step.params?.selector || ''
  if (!intent) return { step, resolution: null }

  const match = await findElement(webContents, intent)
  if (!match.found) return { step, resolution: match }

  const augmented = {
    ...step,
    params: { ...step.params, selector: match.selector },
  }
  return {
    step:       augmented,
    resolution: { method: match.method, confidence: match.confidence, selector: match.selector },
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _resolveMethod(el) {
  if (!el) return 'unknown'
  if (el.selector.startsWith('#'))           return 'id_selector'
  if (el.ariaLabel && el.confidence >= 0.70) return 'aria_label'
  if (el.text      && el.confidence >= 0.70) return 'visible_text'
  if (el.role)                               return 'role_attribute'
  return 'css_selector'
}

module.exports = { findElement, resolveStepSelector }
