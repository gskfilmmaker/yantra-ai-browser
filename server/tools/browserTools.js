'use strict'
/**
 * Playwright-based browser tools for the headless server.
 * A single shared Chromium browser instance is launched on first use.
 * Each agent session gets its own page, stored in `sessionPages`.
 */

const { register } = require('./registry')

let _browser = null
// sessionId → playwright Page
const sessionPages = new Map()

// ── Browser lifecycle ──────────────────────────────────────────────────────────

async function getBrowser() {
  if (_browser && _browser.isConnected()) return _browser
  const { chromium } = require('playwright')
  _browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  })
  console.log('[browser] Chromium launched')
  return _browser
}

async function getPage(sessionId) {
  if (sessionPages.has(sessionId)) {
    const p = sessionPages.get(sessionId)
    if (!p.isClosed()) return p
    sessionPages.delete(sessionId)
  }
  const browser = await getBrowser()
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  })
  const page = await context.newPage()
  sessionPages.set(sessionId, page)
  return page
}

async function closePage(sessionId) {
  if (!sessionPages.has(sessionId)) return
  const page = sessionPages.get(sessionId)
  try {
    await page.context().close()
  } catch {}
  sessionPages.delete(sessionId)
}

async function closeBrowser() {
  if (_browser) {
    try { await _browser.close() } catch {}
    _browser = null
  }
}

// Get browser state for a session (url + title), used by polling endpoint
async function getBrowserState(sessionId) {
  if (!sessionPages.has(sessionId)) return { url: null, title: null }
  const page = sessionPages.get(sessionId)
  if (page.isClosed()) return { url: null, title: null }
  return { url: page.url(), title: await page.title().catch(() => '') }
}

// ── Tool registration ──────────────────────────────────────────────────────────

register({
  name: 'navigate_to',
  description: 'Navigate the headless browser to a URL and wait for the page to load.',
  inputSchema: {
    type: 'object',
    properties: { url: { type: 'string', description: 'Full URL to navigate to (must include http:// or https://)' } },
    required: ['url'],
  },
  async execute({ url } = {}, { sessionId } = {}) {
    if (!url) return 'Error: url is required'
    if (!url.match(/^https?:\/\//i)) url = 'https://' + url
    const page = await getPage(sessionId || 'default')
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
      const title = await page.title()
      return `Navigated to: ${page.url()}\nTitle: ${title}`
    } catch (e) {
      return `Navigation error: ${e.message}`
    }
  },
})

register({
  name: 'get_current_page',
  description: "Get the title, URL, and text content of the current browser page. Use when the user says 'this page', 'current page', etc.",
  inputSchema: { type: 'object', properties: {} },
  async execute({} = {}, { sessionId } = {}) {
    const page = await getPage(sessionId || 'default')
    try {
      const url   = page.url()
      if (url === 'about:blank') return 'No page loaded. Use navigate_to first.'
      const title = await page.title()
      const text  = await page.evaluate(() => {
        // Remove script/style tags and return readable text
        const clone = document.cloneNode(true)
        clone.querySelectorAll('script,style,noscript,nav,footer,aside').forEach(el => el.remove())
        return (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 4000)
      })
      const links = await page.evaluate(() =>
        Array.from(document.querySelectorAll('a[href]'))
          .filter(a => { const r = a.getBoundingClientRect(); return r.width > 0 })
          .slice(0, 20)
          .map(a => ({ text: a.innerText.trim().slice(0, 60), href: a.href }))
      )
      const linkLines = links.map(l => `• [${l.text}](${l.href})`).join('\n')
      return `Title: ${title}\nURL: ${url}\n\nContent:\n${text}\n\nLinks:\n${linkLines}`
    } catch (e) {
      return `Error reading page: ${e.message}`
    }
  },
})

register({
  name: 'click_element',
  description: 'Click an element on the current browser page. Provide a CSS selector, or a text string to find by visible text.',
  inputSchema: {
    type: 'object',
    properties: {
      selector: { type: 'string', description: 'CSS selector (e.g. "#submit", ".btn", \'[name="q"]\')' },
      text:     { type: 'string', description: 'Visible text of the element to click (e.g. "Sign In", "Search")' },
    },
  },
  async execute({ selector, text } = {}, { sessionId } = {}) {
    if (!selector && !text) return 'Provide either selector or text.'
    const page = await getPage(sessionId || 'default')
    try {
      if (selector) {
        try {
          await page.click(selector, { timeout: 5000 })
          return `Clicked element matching selector: ${selector}`
        } catch {
          // fall through to text match
        }
      }
      if (text) {
        // Try getByText (Playwright built-in), then manual JS fallback
        try {
          await page.getByText(text, { exact: false }).first().click({ timeout: 5000 })
          return `Clicked element with text: "${text}"`
        } catch {
          const found = await page.evaluate((t) => {
            const candidates = document.querySelectorAll('a,button,[role="button"],input[type="submit"],input[type="button"],label,[onclick]')
            for (const el of candidates) {
              if ((el.innerText || el.value || '').toLowerCase().includes(t.toLowerCase())) {
                el.click()
                return (el.innerText || el.value || el.tagName).trim().slice(0, 80)
              }
            }
            return null
          }, text)
          if (found) return `Clicked element with text: "${found}"`
          return `Could not find element with text: "${text}"`
        }
      }
      return 'No matching element found.'
    } catch (e) {
      return `Error clicking element: ${e.message}`
    }
  },
})

register({
  name: 'type_in_field',
  description: 'Type text into an input field or textarea on the current browser page.',
  inputSchema: {
    type: 'object',
    properties: {
      selector: { type: 'string', description: 'CSS selector of the input field (e.g. "input[name=q]", "#search")' },
      text:     { type: 'string', description: 'Text to type into the field' },
      clear:    { type: 'boolean', description: 'Clear existing value first (default: true)' },
      submit:   { type: 'boolean', description: 'Press Enter after typing (default: false)' },
    },
    required: ['text'],
  },
  async execute({ selector, text, clear = true, submit = false } = {}, { sessionId } = {}) {
    if (!text) return 'Error: text is required'
    const page = await getPage(sessionId || 'default')
    try {
      let locator
      if (selector) {
        locator = page.locator(selector).first()
      } else {
        // Find first visible input or textarea
        locator = page.locator('input:visible:not([type=hidden]):not([type=submit]):not([type=button]),textarea:visible').first()
      }
      if (clear) {
        await locator.fill(text, { timeout: 5000 })
      } else {
        await locator.type(text, { timeout: 5000 })
      }
      if (submit) await locator.press('Enter')
      const tag = await locator.evaluate(el => el.tagName.toLowerCase())
      const name = await locator.evaluate(el => el.name || el.id || '')
      return `Typed into ${tag}${name ? `[${name}]` : ''}: "${text.slice(0, 60)}"${submit ? ' + Enter' : ''}`
    } catch (e) {
      return `Error typing in field: ${e.message}`
    }
  },
})

register({
  name: 'scroll_page',
  description: 'Scroll the current browser page up, down, to the top, or to the bottom.',
  inputSchema: {
    type: 'object',
    properties: {
      direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'], description: 'Direction to scroll' },
      amount:    { type: 'number', description: 'Pixels to scroll for up/down (default: 600)' },
    },
    required: ['direction'],
  },
  async execute({ direction, amount = 600 } = {}, { sessionId } = {}) {
    const page = await getPage(sessionId || 'default')
    try {
      await page.evaluate(({ direction, amount }) => {
        if      (direction === 'top')    window.scrollTo({ top: 0, behavior: 'smooth' })
        else if (direction === 'bottom') window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })
        else if (direction === 'down')   window.scrollBy({ top:  amount, behavior: 'smooth' })
        else if (direction === 'up')     window.scrollBy({ top: -amount, behavior: 'smooth' })
      }, { direction, amount })
      return `Scrolled ${direction}` + (direction === 'up' || direction === 'down' ? ` (${amount}px)` : '')
    } catch (e) {
      return `Error scrolling: ${e.message}`
    }
  },
})

register({
  name: 'capture_screenshot',
  description: 'Take a screenshot of the current browser page for visual analysis. Returns a base64 PNG image.',
  inputSchema: { type: 'object', properties: {} },
  async execute({} = {}, { sessionId } = {}) {
    const page = await getPage(sessionId || 'default')
    try {
      const buf = await page.screenshot({ type: 'png', fullPage: false })
      return 'data:image/png;base64,' + buf.toString('base64')
    } catch (e) {
      return `Error capturing screenshot: ${e.message}`
    }
  },
})

register({
  name: 'wait_for_element',
  description: 'Wait for a CSS selector to appear on the page. Useful after navigation or clicking.',
  inputSchema: {
    type: 'object',
    properties: {
      selector: { type: 'string', description: 'CSS selector to wait for' },
      timeout:  { type: 'number', description: 'Max wait in milliseconds (default: 5000, max: 15000)' },
    },
    required: ['selector'],
  },
  async execute({ selector, timeout = 5000 } = {}, { sessionId } = {}) {
    if (!selector) return 'Error: selector is required'
    const ms = Math.min(timeout || 5000, 15000)
    const page = await getPage(sessionId || 'default')
    try {
      const start = Date.now()
      await page.waitForSelector(selector, { timeout: ms })
      const elapsed = Date.now() - start
      return `Element "${selector}" found after ${elapsed}ms`
    } catch {
      return `Timeout: "${selector}" not found within ${ms}ms`
    }
  },
})

register({
  name: 'get_page_structure',
  description: 'Get all interactive elements on the current page: buttons, links, inputs. Call this before clicking or typing to find correct selectors.',
  inputSchema: { type: 'object', properties: {} },
  async execute({} = {}, { sessionId } = {}) {
    const page = await getPage(sessionId || 'default')
    try {
      const data = await page.evaluate(() => {
        function info(el) {
          const rect = el.getBoundingClientRect()
          return {
            tag:  el.tagName.toLowerCase(),
            id:   el.id || '',
            name: el.name || '',
            cls:  el.className ? String(el.className).split(' ').slice(0, 3).join('.') : '',
            text: (el.innerText || el.value || el.placeholder || el.alt || '').trim().slice(0, 80),
            type: el.type || '',
            href: el.href ? String(el.href).slice(0, 80) : '',
            visible: rect.width > 0 && rect.height > 0,
          }
        }
        return {
          title:   document.title,
          url:     location.href,
          buttons: Array.from(document.querySelectorAll('button,[role="button"],input[type="submit"],input[type="button"]'))
            .filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 }).slice(0, 25).map(info),
          inputs:  Array.from(document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]),textarea,select'))
            .slice(0, 25).map(info),
          links:   Array.from(document.querySelectorAll('a[href]'))
            .filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 }).slice(0, 25).map(info),
        }
      })
      const lines = [`**Page:** ${data.title} — ${data.url}`]
      if (data.buttons.length) {
        lines.push(`\n**Buttons (${data.buttons.length}):**`)
        data.buttons.forEach(b => {
          const sel = b.id ? `#${b.id}` : b.name ? `[name="${b.name}"]` : b.cls ? `.${b.cls}` : b.tag
          lines.push(`  • "${b.text || '(no text)'}" → \`${sel}\``)
        })
      }
      if (data.inputs.length) {
        lines.push(`\n**Input Fields (${data.inputs.length}):**`)
        data.inputs.forEach(i => {
          const sel = i.id ? `#${i.id}` : i.name ? `[name="${i.name}"]` : i.tag
          lines.push(`  • ${i.tag}[${i.type || 'text'}] "${i.text || i.name || '(empty)'}" → \`${sel}\``)
        })
      }
      if (data.links.length) {
        lines.push(`\n**Links (${data.links.length}):**`)
        data.links.forEach(l => lines.push(`  • "${l.text}" → ${l.href}`))
      }
      return lines.join('\n') || 'No interactive elements found.'
    } catch (e) {
      return `Error reading page structure: ${e.message}`
    }
  },
})

module.exports = { getBrowser, getPage, closePage, closeBrowser, getBrowserState, sessionPages }
