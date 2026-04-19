'use strict'
/* global api */

// ─── State ────────────────────────────────────────────────────────────────────

let tabs = []           // [{id, url, title, loading, favicon}]
let activeTabId = null
let isRunning = false

// Per-tab conversation: tabId → {items:[], history:[]}
const convos = {}

// ─── IPC event wiring ─────────────────────────────────────────────────────────

api.on.tabSwitched(({ tabId, tabs: t }) => {
  tabs = t; activeTabId = tabId
  if (!convos[tabId]) convos[tabId] = { items: [], history: [] }
  renderTabs()
  syncURL()
  renderThread()
  scheduleBoundsUpdate()
})

api.on.tabUpdated((tab) => {
  const existing = tabs.find(t => t.id === tab.id)
  if (existing) Object.assign(existing, tab)
  else tabs.push(tab)
  renderTabs()
  if (tab.id === activeTabId) {
    syncURL(tab)
    syncNavLoading(tab.loading)
    // Hide new-tab page once a URL is navigating
    if (tab.url && tab.url !== 'about:blank') hideNewTabPage()
  }
})

api.on.tabClosed(({ tabs: t }) => { tabs = t; renderTabs() })

api.on.agentEvent(handleAgentEvent)

// ─── Tabs ─────────────────────────────────────────────────────────────────────

function renderTabs() {
  const list = $('tabsList')
  list.innerHTML = ''
  tabs.forEach(tab => {
    const el = document.createElement('div')
    el.className = `tab${tab.id === activeTabId ? ' active' : ''}`

    // Favicon
    const faviconHTML = tab.favicon
      ? `<img class="tab-favicon" src="${tab.favicon}" onerror="this.style.display='none'">`
      : `<span class="tab-favicon-emoji">🌐</span>`

    el.innerHTML = `
      ${faviconHTML}
      <span class="tab-title">${esc(tab.loading ? 'Loading…' : tab.title || 'New Tab')}</span>
      <button class="tab-close" title="Close tab">×</button>
    `
    el.addEventListener('click', e => {
      if (!e.target.classList.contains('tab-close')) api.tab.switch(tab.id)
    })
    el.querySelector('.tab-close').addEventListener('click', e => {
      e.stopPropagation(); api.tab.close(tab.id)
    })
    list.appendChild(el)
  })
}

$('tabAdd').addEventListener('click', () => api.tab.create({ type: 'browser', url: '' }))
$('sbNew').addEventListener('click',  () => api.tab.create({ type: 'browser', url: '' }))

// ─── Navigation ───────────────────────────────────────────────────────────────

function syncURL(tab) {
  const t = tab || tabs.find(t => t.id === activeTabId)
  if (!t) return
  // URL bar shows "strawberry / title" when a page is loaded, raw URL otherwise
  const input = $('urlInput')
  if (t.title && t.url && !t.url.startsWith('about:')) {
    input.value = `strawberry / ${t.title}`
    input.dataset.realUrl = t.url
  } else {
    input.value = ''
    input.dataset.realUrl = ''
  }
}

function syncNavLoading(loading) {
  const btn = $('navReload')
  btn.innerHTML = loading
    ? `<svg width="13" height="13" viewBox="0 0 13 13"><path d="M1 1l11 11M12 1L1 12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`
    : `<svg width="15" height="15" viewBox="0 0 15 15"><path d="M13 3A6 6 0 1 0 14 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/><polyline points="10,1 13,3 11,6" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" fill="none"/></svg>`
}

function navigate(raw) {
  let url = raw.trim()
  if (!url) return
  hideNewTabPage()
  api.browser.navigate(url)
}

$('navBack').addEventListener('click', () => api.browser.goBack())
$('navForward').addEventListener('click', () => api.browser.goForward())
$('navReload').addEventListener('click', () => api.browser.reload())

$('urlInput').addEventListener('focus', e => {
  // Show real URL when focused
  if (e.target.dataset.realUrl) e.target.value = e.target.dataset.realUrl
  e.target.select()
})
$('urlInput').addEventListener('blur', e => syncURL())
$('urlInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') { navigate(e.target.value); e.target.blur() }
  if (e.key === 'Escape') { e.target.blur() }
})

// New tab page search
$('ntSearch').addEventListener('keydown', e => { if (e.key === 'Enter') navigate($('ntSearch').value) })
$('ntGo').addEventListener('click', () => navigate($('ntSearch').value))

function hideNewTabPage() { $('newTabPage').classList.add('hidden') }
function showNewTabPage() { $('newTabPage').classList.remove('hidden'); $('ntSearch').focus() }

// Top right buttons
$('btnChat').addEventListener('click', () => {
  const overlay = $('aiOverlay')
  overlay.style.display = overlay.style.display === 'none' ? 'flex' : 'flex'
  scheduleBoundsUpdate()
})
$('btnUpdateNow').addEventListener('click', () => sendMessage('What\'s new? Give me a quick update on what you can help me with.'))

// History sidebar button
$('sbHistory').addEventListener('click', async () => {
  const hist = await api.memory.getHistory(10)
  const text = hist.length
    ? hist.map(h => `**${h.title||h.type}** — ${h.timestamp?.slice(0,10)}\n${(h.result||'').slice(0,200)}`).join('\n\n---\n\n')
    : 'No history yet.'
  addCard({ id: `hist-${Date.now()}`, type: 'text', text: '## Recent Research\n\n' + text })
})

// ─── BrowserView bounds ───────────────────────────────────────────────────────
// Tells the main process exactly where to place the BrowserView
// so it fills the space above the AI overlay.

let boundsTimer = null
function scheduleBoundsUpdate() {
  clearTimeout(boundsTimer)
  boundsTimer = setTimeout(updateBrowserViewBounds, 30)
}

function updateBrowserViewBounds() {
  const sidebar   = $('sidebar')
  const navRow    = $('navRow')
  const overlay   = $('aiOverlay')
  const tabStrip  = $('tabStrip')

  const sidebarW = sidebar.offsetWidth
  const topY     = tabStrip.offsetHeight + navRow.offsetHeight
  const winH     = window.innerHeight
  const overlayH = overlay.offsetHeight

  api.browser.setBounds({
    x: Math.round(sidebarW),
    y: Math.round(topY),
    width:  Math.round(window.innerWidth - sidebarW),
    height: Math.round(winH - topY - overlayH),
  })
}

window.addEventListener('resize', scheduleBoundsUpdate)

// ─── AI overlay resize (drag handle) ─────────────────────────────────────────

let dragStart = null
const dragHandle = $('aiDragHandle')
const aiOverlay  = $('aiOverlay')

dragHandle.addEventListener('mousedown', e => {
  dragStart = { y: e.clientY, h: aiOverlay.offsetHeight }
  document.addEventListener('mousemove', onDragMove)
  document.addEventListener('mouseup', onDragUp)
})

function onDragMove(e) {
  if (!dragStart) return
  const delta = dragStart.y - e.clientY
  const newH = Math.max(68, Math.min(500, dragStart.h + delta))
  aiOverlay.style.minHeight = newH + 'px'
  scheduleBoundsUpdate()
}
function onDragUp() {
  dragStart = null
  document.removeEventListener('mousemove', onDragMove)
  document.removeEventListener('mouseup', onDragUp)
}

// ─── AI Thread ────────────────────────────────────────────────────────────────

function convo() { return convos[activeTabId] || { items: [], history: [] } }

function renderThread() {
  const thread = $('aiThread')
  thread.innerHTML = ''
  convo().items.forEach(item => thread.appendChild(buildCard(item)))
  scrollThread()
}

function buildCard(item) {
  const el = document.createElement('div')
  el.id = `card-${item.id}`
  el.innerHTML = cardHTML(item)
  return el
}

function cardHTML(item) {
  switch (item.type) {
    case 'user':
      return `<div class="card card-user"><div class="card-user-bubble">${esc(item.text)}</div></div>`

    case 'text':
      return `<div class="card"><div class="card-text">${renderMd(item.text)}</div></div>`

    case 'tool_call': {
      const icons = { web_search:'🔍', fetch_webpage:'📄', get_current_page:'🖥️', open_url:'🔗', get_all_tabs:'📑', save_note:'💾' }
      const icon = icons[item.toolName] || '⚙️'
      const title = item.toolName === 'web_search'       ? `Searching: "${item.toolInput?.query}"`
                  : item.toolName === 'get_current_page' ? 'Reading current page…'
                  : item.toolName === 'get_all_tabs'     ? 'Reading all open tabs…'
                  : item.toolName === 'save_note'        ? `Saving "${item.toolInput?.filename}"`
                  : item.toolName === 'open_url'         ? `Opening ${item.toolInput?.url}`
                  : `Fetching ${item.toolInput?.url || ''}`
      const st = item.status || 'running'
      const badge = st === 'running' ? '<span class="spinner"></span> Working…' : st === 'done' ? '✓ Done' : '✗ Error'
      return `<div class="card-tool ${st}">
        <span class="ct-icon">${icon}</span>
        <div class="ct-body">
          <div class="ct-title">${esc(title)}</div>
          ${item.summary ? `<div class="ct-sub">${esc(item.summary)}</div>` : ''}
        </div>
        <div class="ct-badge ${st}">${badge}</div>
      </div>`
    }

    case 'feedback':
      return `<div class="card card-feedback">
        <button class="fb-btn" title="Good">👍</button>
        <button class="fb-btn" title="Bad">👎</button>
      </div>`

    case 'error':
      return `<div class="card card-tool error">
        <span class="ct-icon">⚠️</span>
        <div class="ct-body"><div class="ct-title">${esc(item.text)}</div></div>
        <div class="ct-badge error">Error</div>
      </div>`

    default: return ''
  }
}

function patchCard(itemId) {
  const item = convo().items.find(i => i.id === itemId)
  const el   = document.getElementById(`card-${itemId}`)
  if (item && el) el.innerHTML = cardHTML(item)
}

function addCard(item) {
  const c = convo()
  c.items.push(item)
  const thread = $('aiThread')
  thread.appendChild(buildCard(item))
  // Show overlay if hidden
  aiOverlay.style.display = 'flex'
  scheduleBoundsUpdate()
  scrollThread()
}

function scrollThread() {
  const thread = $('aiThread')
  if (thread) thread.scrollTop = thread.scrollHeight
}

// ─── Agent events ─────────────────────────────────────────────────────────────

const toolMap = {}
let curTextId = null

function handleAgentEvent(ev) {
  if (ev.sessionId !== activeTabId) return

  switch (ev.type) {
    case 'tool_call': {
      const item = { id: `tc-${ev.toolId}`, type: 'tool_call', toolName: ev.toolName, toolInput: ev.toolInput, status: 'running' }
      toolMap[ev.toolId] = item.id
      curTextId = null
      addCard(item)
      break
    }
    case 'tool_result': {
      const id = toolMap[ev.toolId]
      const item = convo().items.find(i => i.id === id)
      if (item) {
        item.status = 'done'
        const line = ev.result.split('\n').find(l => l.trim()) || ''
        item.summary = line.slice(0, 100) + (line.length > 100 ? '…' : '')
        patchCard(id); scrollThread()
      }
      break
    }
    case 'text': {
      if (curTextId) {
        const item = convo().items.find(i => i.id === curTextId)
        if (item) { item.text = ev.text; patchCard(curTextId); scrollThread(); break }
      }
      const item = { id: `txt-${Date.now()}`, type: 'text', text: ev.text }
      curTextId = item.id
      addCard(item)
      break
    }
    case 'error':
      addCard({ id: `err-${Date.now()}`, type: 'error', text: ev.text })
      finishRun(); break
    case 'done':
      curTextId = null
      addCard({ id: `fb-${Date.now()}`, type: 'feedback' })
      finishRun(); break
  }
}

function finishRun() {
  isRunning = false
  $('aiSend').disabled = false
  $('aiInput').disabled = false
}

// ─── Send message ─────────────────────────────────────────────────────────────

async function sendMessage(prefill) {
  if (isRunning) return
  const inputEl = $('aiInput')
  const text = (prefill || inputEl.value).trim()
  if (!text) return
  if (!prefill) { inputEl.value = ''; resizeAiInput() }

  const c = convos[activeTabId]
  if (!c) return

  isRunning = true
  $('aiSend').disabled = true

  // Update session tab label
  $('sessionTab').textContent = text.slice(0, 30) + (text.length > 30 ? '…' : '')

  addCard({ id: `u-${Date.now()}`, type: 'user', text })
  const history = c.history.slice()
  c.history.push({ role: 'user', content: text })

  api.agent.run({ message: text, sessionId: activeTabId, history })
}

$('aiSend').addEventListener('click', () => sendMessage())
$('aiInput').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() }
})

function resizeAiInput() {
  const el = $('aiInput')
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 160) + 'px'
  scheduleBoundsUpdate()
}
$('aiInput').addEventListener('input', resizeAiInput)

// ─── Markdown renderer ────────────────────────────────────────────────────────

function renderMd(raw) {
  let t = esc(raw)
  t = t.replace(/```([\s\S]*?)```/g, (_, c) => `<pre><code>${c}</code></pre>`)
  t = t.replace(/`([^`\n]+)`/g, '<code>$1</code>')
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  t = t.replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
  t = t.replace(/^#{1,3} (.+)$/gm, '<strong>$1</strong>')
  t = t.replace(/^[-•] (.+)$/gm, '<li>$1</li>')
  t = t.replace(/(<li>[\s\S]*?<\/li>)/g, '<ul>$1</ul>')
  t = t.replace(/(https?:\/\/[^\s<"]+)/g, '<a href="#" onclick="return false" title="$1">$1</a>')
  t = t.replace(/\n/g, '<br>')
  return t
}

function esc(s) {
  if (typeof s !== 'string') return ''
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

function $(id) { return document.getElementById(id) }
