'use strict'

// ── Browser-side visual map builder ──────────────────────────────────────────
// Serialised and injected into renderer — must be self-contained.
function _buildVisualMapFn(params) {
  function buildSelector(el) {
    if (el.id) {
      try { return '#' + CSS.escape(el.id) } catch (e) { return '#' + el.id }
    }
    var tag  = el.tagName.toLowerCase()
    var aria = el.getAttribute('aria-label')
    if (aria) return tag + '[aria-label=' + JSON.stringify(aria) + ']'
    var name = el.getAttribute('name')
    if (name) return tag + '[name=' + JSON.stringify(name) + ']'
    var role = el.getAttribute('role')
    if (role) return tag + '[role=' + JSON.stringify(role) + ']'
    var typ  = el.getAttribute('type')
    if (typ && typ !== 'text') return tag + '[type=' + JSON.stringify(typ) + ']'
    return tag
  }

  function elementType(el) {
    var t = el.tagName.toLowerCase()
    var r = (el.getAttribute('role') || '').toLowerCase()
    if (r === 'button' || t === 'button') return 'button'
    if (r === 'link'   || t === 'a')      return 'link'
    if (t === 'input' || t === 'textarea' || t === 'select') return 'field'
    if (t === 'label')                    return 'label'
    return 'interactive'
  }

  var tags = [
    'button', 'a[href]', '[role="button"]', '[role="link"]', '[role="tab"]',
    '[role="menuitem"]', '[role="checkbox"]', '[role="radio"]', '[role="combobox"]',
    'input:not([type="hidden"])', 'textarea', 'select',
  ].join(',')

  var els = Array.from(document.querySelectorAll(tags))
  var vp  = { w: window.innerWidth, h: window.innerHeight }

  return {
    url:      location.href,
    title:    document.title,
    viewport: vp,
    elements: els.map(function(el) {
      var r = el.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) return null
      return {
        selector:  buildSelector(el),
        kind:      elementType(el),
        text:      (el.innerText || el.value || el.placeholder || '').trim().slice(0, 60),
        ariaLabel: el.getAttribute('aria-label') || '',
        type:      el.type || '',
        disabled:  el.disabled || el.getAttribute('aria-disabled') === 'true',
        rect:      { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        inViewport: r.top >= 0 && r.left >= 0 && r.bottom <= vp.h && r.right <= vp.w,
        aboveTheFold: r.top < vp.h,
      }
    }).filter(Boolean).slice(0, params.maxElements || 60),
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

// Returns a rich page context combining DOM spatial map + optional screenshot.
// opts.includeScreenshot: also capture a downsized JPEG (for visual reasoning fallback)
async function getFusionContext(webContents, { includeScreenshot = false } = {}) {
  const result = { domMap: null, screenshot: null, timestamp: new Date().toISOString() }

  if (!webContents) return result

  // DOM spatial map
  try {
    const params = JSON.stringify({ maxElements: 60 })
    result.domMap = await webContents.executeJavaScript(
      `(${_buildVisualMapFn.toString()})(${params})`
    )
  } catch (e) {
    result.domMapError = e.message
  }

  // Optional screenshot
  if (includeScreenshot) {
    try {
      const img     = await webContents.capturePage()
      const { width } = img.getSize()
      const small   = width > 800 ? img.resize({ width: 800, quality: 'good' }) : img
      result.screenshot = {
        dataUri: 'data:image/jpeg;base64,' + small.toJPEG(72).toString('base64'),
        width:   small.getSize().width,
        height:  small.getSize().height,
      }
    } catch (e) {
      result.screenshotError = e.message
    }
  }

  return result
}

// Find the element nearest to a reference element in a given direction.
// direction: 'right' | 'left' | 'below' | 'above'
async function findByProximity(webContents, { nearSelector, direction = 'right', kind }) {
  if (!webContents || !nearSelector) return null

  const ctx = await getFusionContext(webContents)
  if (!ctx.domMap) return null

  // Find the anchor element
  const anchor = ctx.domMap.elements.find(e => e.selector === nearSelector)
  if (!anchor) return null

  const ax = anchor.rect.x + anchor.rect.w / 2
  const ay = anchor.rect.y + anchor.rect.h / 2

  // Score each element by spatial proximity and direction alignment
  const scored = ctx.domMap.elements
    .filter(e => e.selector !== nearSelector && (!kind || e.kind === kind))
    .map(e => {
      const ex = e.rect.x + e.rect.w / 2
      const ey = e.rect.y + e.rect.h / 2
      const dx = ex - ax
      const dy = ey - ay
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (dist < 1) return null

      // Direction alignment score: how well does dx/dy match the requested direction?
      let alignScore = 0
      if (direction === 'right' && dx > 0)  alignScore = dx / dist
      if (direction === 'left'  && dx < 0)  alignScore = (-dx) / dist
      if (direction === 'below' && dy > 0)  alignScore = dy / dist
      if (direction === 'above' && dy < 0)  alignScore = (-dy) / dist

      return { ...e, dist, alignScore, score: alignScore / (1 + dist / 200) }
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)

  return scored[0] || null
}

// Produce a human-readable description of the visual page layout for the agent.
// Used when DOM matching has failed — helps the LLM reason about what it's seeing.
async function describePageForFallback(webContents) {
  const ctx = await getFusionContext(webContents, { includeScreenshot: true })
  if (!ctx.domMap) return { description: 'Could not read page structure.', screenshot: null }

  const { elements, url, title, viewport } = ctx.domMap

  const buttons = elements.filter(e => e.kind === 'button' && e.inViewport)
  const fields  = elements.filter(e => e.kind === 'field'  && e.inViewport)
  const links   = elements.filter(e => e.kind === 'link'   && e.inViewport)

  const desc = [
    `URL: ${url}`,
    `Title: ${title}`,
    `Viewport: ${viewport.w}×${viewport.h}`,
    buttons.length ? `Visible buttons: ${buttons.map(b => `"${b.text || b.ariaLabel || b.selector}"`).join(', ')}` : '',
    fields.length  ? `Visible fields:  ${fields.map(f => `"${f.text || f.type || f.selector}"`).join(', ')}` : '',
    links.length   ? `Visible links:   ${links.slice(0, 5).map(l => `"${l.text}"`).join(', ')}` : '',
  ].filter(Boolean).join('\n')

  return {
    description:  desc,
    screenshot:   ctx.screenshot,        // base64 JPEG for visual context
    elementCount: elements.length,
    url,
    title,
  }
}

module.exports = { getFusionContext, findByProximity, describePageForFallback }
