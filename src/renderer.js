'use strict'

// ─── Tab state ────────────────────────────────────────────────────────────────

let tabs = []
let activeTabId = null
let tabIdCounter = 0

function genId() { return ++tabIdCounter }

function createTab(url = '') {
  const id = genId()
  tabs.push({ id, url, title: 'New Tab', loading: false, favicon: '🌐' })

  const webview = document.createElement('webview')
  webview.id = `wv-${id}`
  webview.style.position = 'absolute'
  webview.style.inset = '0'
  webview.style.display = 'none'
  webview.setAttribute('allowpopups', '')
  webview.setAttribute('partition', 'persist:strawberry')
  if (url) webview.src = url

  document.getElementById('webviewContainer').appendChild(webview)
  bindWebviewEvents(webview, id)

  if (!url) renderNewTabPage(id)
  switchToTab(id)
  return id
}

function bindWebviewEvents(webview, id) {
  webview.addEventListener('did-start-loading', () => {
    setTabProp(id, 'loading', true)
    if (activeTabId === id) syncNavBar()
  })

  webview.addEventListener('did-stop-loading', () => {
    setTabProp(id, 'loading', false)
    if (activeTabId === id) syncNavBar()
  })

  webview.addEventListener('page-title-updated', (e) => {
    setTabProp(id, 'title', e.title || 'Untitled')
    renderTabs()
  })

  webview.addEventListener('page-favicon-updated', (e) => {
    if (e.favicons && e.favicons[0]) setTabProp(id, 'faviconUrl', e.favicons[0])
  })

  webview.addEventListener('did-navigate', (e) => {
    setTabProp(id, 'url', e.url)
    if (activeTabId === id) {
      document.getElementById('urlBar').value = e.url
      syncNavBar()
    }
  })

  webview.addEventListener('did-navigate-in-page', (e) => {
    setTabProp(id, 'url', e.url)
    if (activeTabId === id) document.getElementById('urlBar').value = e.url
  })

  webview.addEventListener('new-window', (e) => {
    createTab(e.url)
  })
}

function setTabProp(id, key, val) {
  const t = tabs.find(t => t.id === id)
  if (t) t[key] = val
}

function switchToTab(id) {
  // Remove new-tab overlay if switching to an existing webview
  const existing = document.getElementById('newTabOverlay')
  if (existing) existing.remove()

  // Hide all webviews
  tabs.forEach(t => {
    const wv = document.getElementById(`wv-${t.id}`)
    if (wv) wv.style.display = 'none'
  })

  activeTabId = id
  const wv = document.getElementById(`wv-${id}`)
  if (wv) wv.style.display = 'block'

  const tab = tabs.find(t => t.id === id)
  if (tab) {
    document.getElementById('urlBar').value = tab.url || ''
    if (!tab.url) renderNewTabPage(id)
  }

  syncNavBar()
  renderTabs()
}

function closeTab(id) {
  const idx = tabs.findIndex(t => t.id === id)
  if (idx === -1) return

  const wv = document.getElementById(`wv-${id}`)
  if (wv) wv.remove()

  const overlay = document.getElementById('newTabOverlay')
  if (overlay && activeTabId === id) overlay.remove()

  tabs.splice(idx, 1)

  if (tabs.length === 0) { createTab(); return }

  if (activeTabId === id) {
    switchToTab(tabs[Math.min(idx, tabs.length - 1)].id)
  } else {
    renderTabs()
  }
}

function renderTabs() {
  const bar = document.getElementById('tabBar')
  bar.innerHTML = ''
  tabs.forEach(tab => {
    const el = document.createElement('div')
    el.className = `tab${tab.id === activeTabId ? ' active' : ''}`
    el.dataset.id = tab.id

    const faviconEl = document.createElement('span')
    faviconEl.className = 'tab-favicon'
    if (tab.faviconUrl) {
      const img = document.createElement('img')
      img.src = tab.faviconUrl
      img.width = 14
      img.height = 14
      img.onerror = () => { img.style.display = 'none' }
      faviconEl.appendChild(img)
    } else {
      faviconEl.textContent = tab.loading ? '⋯' : '🌐'
    }

    const titleEl = document.createElement('span')
    titleEl.className = 'tab-title'
    titleEl.textContent = tab.loading ? 'Loading…' : (tab.title || 'New Tab')

    const closeEl = document.createElement('button')
    closeEl.className = 'tab-close'
    closeEl.textContent = '×'
    closeEl.title = 'Close tab'
    closeEl.addEventListener('click', (e) => { e.stopPropagation(); closeTab(tab.id) })

    el.appendChild(faviconEl)
    el.appendChild(titleEl)
    el.appendChild(closeEl)
    el.addEventListener('click', () => switchToTab(tab.id))
    bar.appendChild(el)
  })
}

// ─── New-tab page ─────────────────────────────────────────────────────────────

function renderNewTabPage(id) {
  const container = document.getElementById('webviewContainer')
  const old = document.getElementById('newTabOverlay')
  if (old) old.remove()

  const overlay = document.createElement('div')
  overlay.id = 'newTabOverlay'
  overlay.className = 'new-tab-page'
  overlay.innerHTML = `
    <div class="new-tab-logo">🍓</div>
    <div class="new-tab-title">Good to see you.</div>
    <div class="new-tab-search">
      <input id="ntSearch" placeholder="Search or enter a URL…" autocomplete="off" spellcheck="false"/>
      <button class="new-tab-search-btn" id="ntSearchBtn">Search</button>
    </div>
  `
  container.appendChild(overlay)

  const input = overlay.querySelector('#ntSearch')
  const btn = overlay.querySelector('#ntSearchBtn')

  const go = () => {
    const val = input.value.trim()
    if (val) navigateTo(val)
  }

  input.addEventListener('keydown', e => { if (e.key === 'Enter') go() })
  btn.addEventListener('click', go)
  input.focus()
}

// ─── Navigation ───────────────────────────────────────────────────────────────

function navigateTo(raw) {
  let url = raw.trim()
  if (!url) return

  const overlay = document.getElementById('newTabOverlay')
  if (overlay) overlay.remove()

  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    if (/^[\w-]+(\.[a-z]{2,})(\/.*)?$/.test(url) && !url.includes(' ')) {
      url = 'https://' + url
    } else {
      url = `https://www.google.com/search?q=${encodeURIComponent(url)}`
    }
  }

  const wv = getActiveWebview()
  if (wv) {
    wv.src = url
    setTabProp(activeTabId, 'url', url)
  }

  document.getElementById('urlBar').value = url
}

function getActiveWebview() {
  if (!activeTabId) return null
  return document.getElementById(`wv-${activeTabId}`)
}

function syncNavBar() {
  const wv = getActiveWebview()
  const tab = tabs.find(t => t.id === activeTabId)

  document.getElementById('backBtn').disabled = wv ? !wv.canGoBack() : true
  document.getElementById('forwardBtn').disabled = wv ? !wv.canGoForward() : true

  const refreshBtn = document.getElementById('refreshBtn')
  const isLoading = tab ? tab.loading : false
  refreshBtn.title = isLoading ? 'Stop' : 'Refresh'
  refreshBtn.innerHTML = isLoading
    ? `<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M1 1l10 10M11 1L1 11" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`
    : `<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M12 2.5A5.5 5.5 0 1 0 13 8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><polyline points="9,1 12,2.5 10.5,5.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>`
}

// ─── Nav bar events ───────────────────────────────────────────────────────────

document.getElementById('backBtn').addEventListener('click', () => getActiveWebview()?.goBack())
document.getElementById('forwardBtn').addEventListener('click', () => getActiveWebview()?.goForward())

document.getElementById('refreshBtn').addEventListener('click', () => {
  const wv = getActiveWebview()
  if (!wv) return
  const tab = tabs.find(t => t.id === activeTabId)
  tab?.loading ? wv.stop() : wv.reload()
})

document.getElementById('urlBar').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') navigateTo(e.target.value)
})

document.getElementById('urlBar').addEventListener('focus', (e) => e.target.select())

document.getElementById('newTabBtn').addEventListener('click', () => createTab())

// ─── AI Panel ─────────────────────────────────────────────────────────────────

let aiHistory = []
let aiStreaming = false

document.getElementById('aiToggle').addEventListener('click', () => {
  document.getElementById('aiPanel').classList.toggle('open')
})
document.getElementById('aiClose').addEventListener('click', () => {
  document.getElementById('aiPanel').classList.remove('open')
})

document.getElementById('sendBtn').addEventListener('click', sendAiMessage)
document.getElementById('aiInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAiMessage() }
})

document.getElementById('captureBtn').addEventListener('click', async () => {
  const wv = getActiveWebview()
  if (!wv) return
  const input = document.getElementById('aiInput')
  input.value = (input.value ? input.value + '\n' : '') + 'Analyze what you see on the current page and summarize it.'
  input.focus()
})

async function sendAiMessage() {
  if (aiStreaming) return

  const inputEl = document.getElementById('aiInput')
  const message = inputEl.value.trim()
  if (!message) return

  inputEl.value = ''
  aiStreaming = true
  document.getElementById('sendBtn').disabled = true

  appendMessage('user', escapeHtml(message))

  const wv = getActiveWebview()
  let webContentsId = null
  if (wv) {
    try { webContentsId = wv.getWebContentsId() } catch (_) {}
  }

  const { el: assistantEl, bubble } = appendStreamingMessage()

  window.api.onAiChunk((chunk) => {
    // Remove cursor, append text, re-add cursor
    const cursor = bubble.querySelector('.stream-cursor')
    if (cursor) cursor.remove()
    // Accumulate raw text in dataset
    bubble.dataset.raw = (bubble.dataset.raw || '') + chunk
    bubble.innerHTML = renderMarkdown(bubble.dataset.raw)
    bubble.insertAdjacentHTML('beforeend', '<span class="stream-cursor"></span>')
    scrollMessages()
  })

  window.api.onAiDone((fullResponse) => {
    aiStreaming = false
    document.getElementById('sendBtn').disabled = false

    const cursor = bubble.querySelector('.stream-cursor')
    if (cursor) cursor.remove()

    bubble.innerHTML = renderMarkdown(fullResponse)
    delete bubble.dataset.raw

    aiHistory.push({ role: 'user', content: message })
    aiHistory.push({ role: 'assistant', content: fullResponse })
    if (aiHistory.length > 20) aiHistory = aiHistory.slice(-20)

    const autoMatch = fullResponse.match(/```automation\n([\s\S]*?)```/)
    if (autoMatch) {
      try {
        const payload = JSON.parse(autoMatch[1])
        executeAutomation(payload.actions, webContentsId)
      } catch (_) {}
    }

    scrollMessages()
  })

  await window.api.sendAiMessage({
    message,
    webContentsId,
    history: aiHistory,
  })
}

function appendMessage(role, htmlContent) {
  const msgs = document.getElementById('aiMessages')
  const el = document.createElement('div')
  el.className = `ai-message ${role}`
  el.innerHTML = `<div class="message-bubble">${htmlContent}</div>`
  msgs.appendChild(el)
  scrollMessages()
  return el
}

function appendStreamingMessage() {
  const msgs = document.getElementById('aiMessages')
  const el = document.createElement('div')
  el.className = 'ai-message assistant'
  el.innerHTML = '<div class="message-bubble"><span class="stream-cursor"></span></div>'
  msgs.appendChild(el)
  scrollMessages()
  return { el, bubble: el.querySelector('.message-bubble') }
}

function scrollMessages() {
  const msgs = document.getElementById('aiMessages')
  msgs.scrollTop = msgs.scrollHeight
}

// ─── Markdown renderer (minimal) ──────────────────────────────────────────────

function renderMarkdown(text) {
  let html = escapeHtml(text)

  // Code blocks
  html = html.replace(/```[\w]*\n([\s\S]*?)```/g, (_, code) => {
    if (_.startsWith('```automation')) {
      return '<span class="automation-badge">⚡ Automation executed</span>'
    }
    return `<pre><code>${code}</code></pre>`
  })

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>')

  // Bold
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')

  // Italic
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>')

  // Line breaks
  html = html.replace(/\n/g, '<br>')

  return html
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ─── Browser automation ───────────────────────────────────────────────────────

async function executeAutomation(actions, webContentsId) {
  if (!webContentsId || !Array.isArray(actions)) return

  for (const action of actions) {
    try {
      switch (action.type) {
        case 'click':
          await window.api.executeJs(webContentsId, `
            (function(){
              var el = document.querySelector(${JSON.stringify(action.selector)});
              if(el){ el.click(); return true; }
              return false;
            })()
          `)
          break

        case 'type':
          await window.api.executeJs(webContentsId, `
            (function(){
              var el = document.querySelector(${JSON.stringify(action.selector)});
              if(el){
                el.focus();
                el.value = ${JSON.stringify(action.text || '')};
                el.dispatchEvent(new Event('input',{bubbles:true}));
                el.dispatchEvent(new Event('change',{bubbles:true}));
                return true;
              }
              return false;
            })()
          `)
          break

        case 'navigate':
          navigateTo(action.url)
          break

        case 'scroll':
          await window.api.executeJs(webContentsId, `
            window.scrollBy(0, ${action.direction === 'up' ? -(action.amount || 300) : (action.amount || 300)})
          `)
          break

        case 'wait':
          await new Promise(r => setTimeout(r, action.ms || 1000))
          break

        case 'extract': {
          const val = await window.api.executeJs(webContentsId, `
            (function(){
              var el = document.querySelector(${JSON.stringify(action.selector)});
              return el ? el.innerText : null;
            })()
          `)
          if (val) appendMessage('assistant', `<strong>Extracted:</strong> ${escapeHtml(String(val))}`)
          break
        }
      }
    } catch (e) {
      // continue with remaining actions
    }
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

createTab()
