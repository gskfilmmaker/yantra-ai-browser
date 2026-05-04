'use strict'

// ── DOM snapshot ──────────────────────────────────────────────────────────────
// Returns a rich state object for before/after comparison.
// All ops run inside executeJavaScript — no Electron imports needed here.

async function snapshot(webContents) {
  if (!webContents) return null
  try {
    return await webContents.executeJavaScript(`
      (function() {
        var inputs = {};
        document.querySelectorAll('input:not([type=hidden]),textarea,select').forEach(function(el) {
          var k = el.id || el.name || (el.type + '_' + el.tagName);
          inputs[k] = el.value || '';
        });
        var bodyText = document.body ? document.body.innerText : '';
        return {
          url:          location.href,
          title:        document.title,
          readyState:   document.readyState,
          elementCount: document.querySelectorAll('*').length,
          inputCount:   document.querySelectorAll('input,textarea,select').length,
          buttonCount:  document.querySelectorAll('button,[role="button"]').length,
          linkCount:    document.querySelectorAll('a[href]').length,
          formCount:    document.querySelectorAll('form').length,
          scrollY:      window.scrollY,
          bodyText:     bodyText.slice(0, 600),
          inputValues:  inputs,
          hasError:     /\\b(error|404|403|500|not found|forbidden|failed|unavailable)\\b/i
                          .test(document.title + ' ' + bodyText.slice(0, 400)),
          hasCaptcha:   !!(
            document.querySelector('.g-recaptcha,[data-sitekey],iframe[src*="captcha"],iframe[src*="recaptcha"],iframe[src*="hcaptcha"]') ||
            /captcha|hcaptcha|recaptcha|cloudflare.*challenge|prove.*human/i.test(bodyText.slice(0, 1000))
          ),
        };
      })()
    `)
  } catch (e) {
    return { url: '', title: '', readyState: 'unknown', elementCount: 0, _snapshotError: e.message }
  }
}

// ── Post-action waits ─────────────────────────────────────────────────────────

// Waits until the URL changes from `fromUrl`. Useful after click-navigation or form submit.
async function waitForNavigation(webContents, { fromUrl, timeout = 10000 } = {}) {
  if (!webContents) return { navigated: false, reason: 'no_webcontents' }
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      const cur = await webContents.executeJavaScript(`location.href`)
      if (cur !== fromUrl && cur !== 'about:blank') {
        // Also wait for readyState === 'complete'
        await waitForReadyState(webContents, 3000)
        return { navigated: true, url: cur, elapsed: Date.now() - (deadline - timeout) }
      }
    } catch { /* page mid-load — keep polling */ }
    await sleep(150)
  }
  return { navigated: false, elapsed: timeout }
}

// Waits for document.readyState === 'complete'
async function waitForReadyState(webContents, timeout = 5000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      const state = await webContents.executeJavaScript(`document.readyState`)
      if (state === 'complete') return true
    } catch { /* loading */ }
    await sleep(200)
  }
  return false
}

// Waits for a CSS selector to appear (present=true) or disappear (present=false) in the DOM.
async function waitForElement(webContents, selector, { timeout = 6000, present = true } = {}) {
  if (!webContents) return { found: false, reason: 'no_webcontents' }
  const ms     = Math.min(timeout, 15000)
  const params = JSON.stringify({ selector, present, ms })
  try {
    return await webContents.executeJavaScript(`
      new Promise(function(resolve) {
        var p = ${params};
        function check() { return !!document.querySelector(p.selector); }
        if (check() === p.present) return resolve({ found: p.present, elapsed: 0 });
        var t0  = Date.now();
        var obs = new MutationObserver(function() {
          if (check() === p.present) {
            obs.disconnect();
            resolve({ found: p.present, elapsed: Date.now() - t0 });
          }
        });
        var root = document.body || document.documentElement;
        obs.observe(root, { childList: true, subtree: true, attributes: true });
        setTimeout(function() {
          obs.disconnect();
          resolve({ found: check(), elapsed: p.ms, timedOut: true });
        }, p.ms);
      })
    `)
  } catch (e) {
    return { found: false, error: e.message }
  }
}

// Waits for any DOM mutation to settle (at least `stable` ms with no further changes).
async function waitForDOMChange(webContents, { timeout = 5000, stable = 400 } = {}) {
  if (!webContents) return { changed: false, reason: 'no_webcontents' }
  const ms     = Math.min(timeout, 15000)
  const params = JSON.stringify({ ms, stable })
  try {
    return await webContents.executeJavaScript(`
      new Promise(function(resolve) {
        var p       = ${params};
        var changed = false;
        var lastMut = Date.now();
        var obs     = new MutationObserver(function(muts) {
          if (muts.length) { changed = true; lastMut = Date.now(); }
        });
        var root = document.body || document.documentElement;
        obs.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
        var ticker = setInterval(function() {
          if (changed && (Date.now() - lastMut) >= p.stable) {
            clearInterval(ticker); obs.disconnect();
            resolve({ changed: true, elapsed: Date.now() - lastMut + p.stable });
          }
        }, 80);
        setTimeout(function() {
          clearInterval(ticker); obs.disconnect();
          resolve({ changed: changed, elapsed: p.ms, timedOut: !changed });
        }, p.ms);
      })
    `)
  } catch (e) {
    return { changed: false, error: e.message }
  }
}

// ── Page-type classifier ──────────────────────────────────────────────────────
// Returns: 'captcha' | 'auth' | 'error' | 'loading' | 'normal' | 'unknown'
async function detectPageType(webContents) {
  try {
    const snap = await snapshot(webContents)
    if (!snap)              return 'unknown'
    if (snap.hasCaptcha)    return 'captcha'
    if (snap.hasError)      return 'error'
    if (snap.readyState !== 'complete') return 'loading'
    const url = (snap.url || '').toLowerCase()
    if (/\/(login|signin|sign-in|auth|authenticate)/.test(url)) return 'auth'
    return 'normal'
  } catch { return 'unknown' }
}

// ── Diff helper ───────────────────────────────────────────────────────────────
// Computes meaningful differences between two snapshots.
function snapshotDiff(before, after) {
  if (!before || !after) return { changed: false, noData: true }
  return {
    urlChanged:    before.url          !== after.url,
    titleChanged:  before.title        !== after.title,
    textChanged:   before.bodyText     !== after.bodyText,
    scrollChanged: before.scrollY      !== after.scrollY,
    elementDelta:  after.elementCount  -  before.elementCount,
    inputDelta:    after.inputCount    -  before.inputCount,
    newError:      !before.hasError    &&  after.hasError,
    captchaAdded:  !before.hasCaptcha  &&  after.hasCaptcha,
  }
}

// ── Utility ───────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

module.exports = {
  snapshot,
  waitForNavigation,
  waitForReadyState,
  waitForElement,
  waitForDOMChange,
  detectPageType,
  snapshotDiff,
  sleep,
}
