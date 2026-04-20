'use strict'
const registry = require('./registry')

const tm = () => require('../tabManager')

// ── getPageStructure ─────────────────────────────────────────────────────────

registry.register({
  name: 'getPageStructure',
  description: 'Get all interactive elements on the current page: buttons, links, inputs, forms. Always call this before clicking or typing.',
  input_schema: { type: 'object', properties: {}, required: [] },
  async execute() {
    const tab = tm().getActiveTab()
    if (!tab || tab.type !== 'browser') return 'No browser tab active.'
    try {
      const data = await tab.view.webContents.executeJavaScript(`
        (function() {
          function info(el) {
            var rect = el.getBoundingClientRect();
            return {
              tag:  el.tagName.toLowerCase(),
              id:   el.id || '',
              name: el.name || '',
              cls:  el.className ? el.className.split(' ').slice(0,3).join('.') : '',
              text: (el.innerText || el.value || el.placeholder || el.alt || '').trim().slice(0, 80),
              type: el.type || '',
              href: el.href ? el.href.slice(0, 80) : '',
              visible: rect.width > 0 && rect.height > 0,
            };
          }
          return {
            title:   document.title,
            url:     location.href,
            buttons: Array.from(document.querySelectorAll('button,[role="button"],input[type="submit"],input[type="button"]')).filter(function(e){ var r=e.getBoundingClientRect(); return r.width>0; }).slice(0,25).map(info),
            inputs:  Array.from(document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]),textarea,select')).slice(0,25).map(info),
            links:   Array.from(document.querySelectorAll('a[href]')).filter(function(e){ var r=e.getBoundingClientRect(); return r.width>0; }).slice(0,25).map(info),
          };
        })()
      `)

      const lines = [`**Page:** ${data.title} — ${data.url}`]

      if (data.buttons.length) {
        lines.push(`\n**Buttons (${data.buttons.length}):**`)
        data.buttons.forEach(b => {
          const sel = b.id ? `#${b.id}` : b.name ? `[name="${b.name}"]` : b.cls ? `.${b.cls}` : b.tag
          lines.push(`  • "${b.text || '(no text)'}" → selector: \`${sel}\``)
        })
      }
      if (data.inputs.length) {
        lines.push(`\n**Input Fields (${data.inputs.length}):**`)
        data.inputs.forEach(i => {
          const sel = i.id ? `#${i.id}` : i.name ? `[name="${i.name}"]` : i.tag
          lines.push(`  • ${i.tag}[${i.type || 'text'}] "${i.text || i.name || '(empty)'}" → selector: \`${sel}\``)
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

// ── clickElement ─────────────────────────────────────────────────────────────

registry.register({
  name: 'clickElement',
  description: 'Click an element on the current page by CSS selector or by its visible text.',
  input_schema: {
    type: 'object',
    properties: {
      selector: { type: 'string', description: 'CSS selector of the element to click (e.g. "#submit", ".btn-primary", \'[name="q"]\')' },
      text:     { type: 'string', description: 'Visible text of the element to click (e.g. "Sign In", "Accept all")' },
    },
    required: [],
  },
  async execute({ selector, text } = {}) {
    const tab = tm().getActiveTab()
    if (!tab || tab.type !== 'browser') return 'No browser tab active.'
    if (!selector && !text) return 'Provide either selector or text.'
    try {
      const params = JSON.stringify({ selector: selector || null, text: text ? text.toLowerCase() : null })
      const result = await tab.view.webContents.executeJavaScript(`
        (function() {
          var p = ${params};
          var el = null;
          if (p.selector) {
            try { el = document.querySelector(p.selector); } catch(e) { return { ok:false, error:'Bad selector: '+e.message }; }
          }
          if (!el && p.text) {
            var candidates = document.querySelectorAll('a,button,[role="button"],input[type="submit"],input[type="button"],label,[onclick]');
            for (var i = 0; i < candidates.length; i++) {
              var t = (candidates[i].innerText || candidates[i].value || '').trim().toLowerCase();
              if (t.includes(p.text)) { el = candidates[i]; break; }
            }
          }
          if (!el) return { ok:false, error:'Element not found' };
          el.click();
          return { ok:true, tag:el.tagName, text:(el.innerText||el.value||'').trim().slice(0,80) };
        })()
      `)
      return result.ok
        ? `Clicked <${result.tag.toLowerCase()}> "${result.text}"`
        : `Could not find element: ${result.error}`
    } catch (e) {
      return `Error clicking element: ${e.message}`
    }
  },
})

// ── typeInField ──────────────────────────────────────────────────────────────

registry.register({
  name: 'typeInField',
  description: 'Type text into an input field or textarea on the current page.',
  input_schema: {
    type: 'object',
    properties: {
      selector: { type: 'string', description: 'CSS selector of the input field. If omitted, uses the currently focused or first visible input.' },
      text:     { type: 'string', description: 'Text to type' },
      clear:    { type: 'boolean', description: 'Clear existing value first (default: true)' },
      submit:   { type: 'boolean', description: 'Press Enter after typing (default: false)' },
    },
    required: ['text'],
  },
  async execute({ selector, text, clear = true, submit = false } = {}) {
    const tab = tm().getActiveTab()
    if (!tab || tab.type !== 'browser') return 'No browser tab active.'
    try {
      const params = JSON.stringify({ selector: selector || null, text: String(text), clear, submit })
      const result = await tab.view.webContents.executeJavaScript(`
        (function() {
          var p = ${params};
          var el = null;
          if (p.selector) {
            try { el = document.querySelector(p.selector); } catch(e) { return { ok:false, error:'Bad selector: '+e.message }; }
          }
          if (!el) {
            el = document.activeElement;
            if (!el || !['INPUT','TEXTAREA'].includes(el.tagName)) {
              el = document.querySelector('input:not([type="hidden"]):not([type="submit"]):not([type="button"]),textarea');
            }
          }
          if (!el) return { ok:false, error:'No input field found' };
          el.focus();
          if (p.clear) {
            el.value = '';
            el.dispatchEvent(new Event('input', { bubbles:true }));
          }
          // Use native input value setter to trigger React/Vue/etc state
          var nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value') ||
                                       Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
          if (nativeInputValueSetter && nativeInputValueSetter.set) {
            nativeInputValueSetter.set.call(el, (p.clear ? '' : el.value) + p.text);
          } else {
            el.value = (p.clear ? '' : el.value) + p.text;
          }
          el.dispatchEvent(new Event('input',  { bubbles:true }));
          el.dispatchEvent(new Event('change', { bubbles:true }));
          if (p.submit) {
            el.dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', keyCode:13, bubbles:true }));
            el.dispatchEvent(new KeyboardEvent('keyup',   { key:'Enter', keyCode:13, bubbles:true }));
          }
          return { ok:true, tag:el.tagName, name:el.name||el.id||'', value:el.value.slice(0,60) };
        })()
      `)
      if (!result.ok) return `Could not find input: ${result.error}`
      return `Typed into ${result.tag.toLowerCase()}${result.name ? `[${result.name}]` : ''}: "${result.value}"${submit ? ' + Enter' : ''}`
    } catch (e) {
      return `Error typing in field: ${e.message}`
    }
  },
})

// ── pressKey ─────────────────────────────────────────────────────────────────

registry.register({
  name: 'pressKey',
  description: 'Press a keyboard key on the current page (dispatched to the active/focused element).',
  input_schema: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        enum: ['Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace', 'Space'],
        description: 'Key to press',
      },
    },
    required: ['key'],
  },
  async execute({ key } = {}) {
    const tab = tm().getActiveTab()
    if (!tab || tab.type !== 'browser') return 'No browser tab active.'
    try {
      tab.view.webContents.sendInputEvent({ type: 'keyDown', keyCode: key })
      tab.view.webContents.sendInputEvent({ type: 'keyUp',   keyCode: key })
      return `Pressed ${key}`
    } catch (e) {
      return `Error pressing key: ${e.message}`
    }
  },
})

// ── scrollPage ───────────────────────────────────────────────────────────────

registry.register({
  name: 'scrollPage',
  description: 'Scroll the current page up, down, to the top, or to the bottom.',
  input_schema: {
    type: 'object',
    properties: {
      direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'], description: 'Scroll direction' },
      amount:    { type: 'number', description: 'Pixels to scroll for up/down (default: 600)' },
    },
    required: ['direction'],
  },
  async execute({ direction, amount = 600 } = {}) {
    const tab = tm().getActiveTab()
    if (!tab || tab.type !== 'browser') return 'No browser tab active.'
    try {
      const params = JSON.stringify({ direction, amount })
      await tab.view.webContents.executeJavaScript(`
        (function() {
          var p = ${params};
          if      (p.direction === 'top')    window.scrollTo({ top: 0,                          behavior:'smooth' });
          else if (p.direction === 'bottom') window.scrollTo({ top: document.body.scrollHeight, behavior:'smooth' });
          else if (p.direction === 'down')   window.scrollBy({ top:  p.amount,                  behavior:'smooth' });
          else if (p.direction === 'up')     window.scrollBy({ top: -p.amount,                  behavior:'smooth' });
        })()
      `)
      return `Scrolled ${direction}` + (direction === 'up' || direction === 'down' ? ` (${amount}px)` : '')
    } catch (e) {
      return `Error scrolling: ${e.message}`
    }
  },
})

// ── waitForElement ───────────────────────────────────────────────────────────

registry.register({
  name: 'waitForElement',
  description: 'Wait for a CSS selector to appear on the page (up to 5 seconds). Useful after navigation or clicking.',
  input_schema: {
    type: 'object',
    properties: {
      selector: { type: 'string', description: 'CSS selector to wait for' },
      timeout:  { type: 'number', description: 'Max wait in ms (default: 5000, max: 10000)' },
    },
    required: ['selector'],
  },
  async execute({ selector, timeout = 5000 } = {}) {
    const tab = tm().getActiveTab()
    if (!tab || tab.type !== 'browser') return 'No browser tab active.'
    const ms = Math.min(timeout || 5000, 10000)
    const params = JSON.stringify({ selector, ms })
    try {
      const result = await tab.view.webContents.executeJavaScript(`
        new Promise(function(resolve) {
          var p = ${params};
          if (document.querySelector(p.selector)) return resolve({ found:true, elapsed:0 });
          var start = Date.now();
          var obs = new MutationObserver(function() {
            if (document.querySelector(p.selector)) {
              obs.disconnect();
              resolve({ found:true, elapsed: Date.now()-start });
            }
          });
          obs.observe(document.body, { childList:true, subtree:true });
          setTimeout(function() { obs.disconnect(); resolve({ found:false, elapsed:p.ms }); }, p.ms);
        })
      `)
      return result.found
        ? `Element "${selector}" appeared after ${result.elapsed}ms`
        : `Timeout: "${selector}" not found within ${ms}ms`
    } catch (e) {
      return `Error waiting for element: ${e.message}`
    }
  },
})

// ── captureScreenshot ────────────────────────────────────────────────────────

registry.register({
  name: 'captureScreenshot',
  description: 'Take a screenshot of the current browser page for visual analysis. Returns the image directly to you.',
  input_schema: { type: 'object', properties: {}, required: [] },
  async execute() {
    const tab = tm().getActiveTab()
    if (!tab || tab.type !== 'browser') return 'No browser tab active.'
    try {
      const img     = await tab.view.webContents.capturePage()
      const { width } = img.getSize()
      const resized = width > 1280 ? img.resize({ width: 1280, quality: 'good' }) : img
      const jpeg    = resized.toJPEG(80)
      return 'data:image/jpeg;base64,' + jpeg.toString('base64')
    } catch (e) {
      return `Error capturing screenshot: ${e.message}`
    }
  },
})
