'use strict'
/* global api */

// ─── State ────────────────────────────────────────────────────────────────────

const sessions = {}      // sessionId → { title, items[], history[] }
let activeTabId = null
let allTabs = []         // [{id, type, url, title, loading}]
let isRunning = false

// ─── Bootstrap ───────────────────────────────────────────────────────────────

api.on.tabSwitched(({ tabId, tabs }) => {
  allTabs = tabs
  activeTabId = tabId
  ensureSession(tabId, tabs)
  syncCanvas()
  renderTabs()
})

api.on.tabUpdated((tab) => {
  const existing = allTabs.find(t => t.id === tab.id)
  if (existing) Object.assign(existing, tab)
  else allTabs.push(tab)
  if (tab.id === activeTabId) syncNavBar(tab)
  renderTabs()
})

api.on.tabClosed(({ tabId, tabs }) => {
  allTabs = tabs
  renderTabs()
})

api.on.agentEvent(handleAgentEvent)

// ─── Session management ───────────────────────────────────────────────────────

function ensureSession(tabId, tabs) {
  if (!sessions[tabId]) {
    const tab = tabs.find(t => t.id === tabId)
    sessions[tabId] = { title: tab?.title || 'New session', items: [], history: [] }
  }
}

function activeSession() { return sessions[activeTabId] }

// ─── Canvas sync — the single-canvas switch ───────────────────────────────────

function syncCanvas() {
  const tab = allTabs.find(t => t.id === activeTabId)
  const isBrowser = tab?.type === 'browser'

  // Nav bar
  $('navBar').style.display = isBrowser ? 'flex' : 'none'
  // Top bar (session breadcrumb)
  $('topbar').style.display = isBrowser ? 'none' : 'flex'
  // Feed (chat)
  $('feed').style.display = isBrowser ? 'none' : 'flex'
  // Browser quick-action bar
  $('browserAiBar').style.display = isBrowser ? 'flex' : 'none'

  if (!isBrowser) {
    renderFeed()
    updateBreadcrumb()
  } else {
    if (tab?.url) $('urlInput').value = tab.url
    syncNavBar(tab)
  }
}

function syncNavBar(tab) {
  if (!tab) return
  if (tab.url) $('urlInput').value = tab.url
  $('navReload').innerHTML = tab.loading
    ? `<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M1 1l10 10M11 1L1 11" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`
    : `<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M12 2.5A5.5 5.5 0 1 0 13 8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><polyline points="9,1 12,2.5 10.5,5.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>`
}

function updateBreadcrumb() {
  const s = activeSession()
  $('sessionTitle').textContent = s?.title || 'New session'
}

// ─── Tab bar rendering ────────────────────────────────────────────────────────

function renderTabs() {
  const list = $('tabsList')
  list.innerHTML = ''
  allTabs.forEach(tab => {
    const el = document.createElement('div')
    el.className = `tab${tab.id === activeTabId ? ' active' : ''}`

    const icon = tab.type === 'browser' ? '🌐' : '🍓'
    const label = tab.loading ? 'Loading…' : (tab.title || 'New Tab')

    el.innerHTML = `
      <span class="tab-icon">${icon}</span>
      <span class="tab-label">${esc(label)}</span>
      <button class="tab-close" title="Close">×</button>
    `
    el.addEventListener('click', (e) => {
      if (!e.target.classList.contains('tab-close')) api.tab.switch(tab.id)
    })
    el.querySelector('.tab-close').addEventListener('click', (e) => {
      e.stopPropagation(); api.tab.close(tab.id)
    })
    list.appendChild(el)
  })
}

// ─── Feed rendering ───────────────────────────────────────────────────────────

function renderFeed() {
  const feed = $('feed')
  const session = activeSession()
  if (!session || session.items.length === 0) {
    feed.innerHTML = `
      <div class="feed-empty" id="feedEmpty">
        <div class="feed-empty-icon">🍓</div>
        <div class="feed-empty-title">What can I help you with?</div>
        <div class="feed-empty-sub">Research topics · Analyze open browser tabs · Automate tasks</div>
      </div>`
    return
  }
  feed.innerHTML = ''
  session.items.forEach(item => feed.appendChild(buildItem(item)))
  scrollFeed()
}

function buildItem(item) {
  const wrap = document.createElement('div')
  wrap.className = 'feed-item'
  wrap.id = `item-${item.id}`
  wrap.innerHTML = itemHTML(item)
  return wrap
}

function itemHTML(item) {
  switch (item.type) {
    case 'user':
      return `<div class="msg-user"><div class="msg-user-bubble">${esc(item.text)}</div></div>`

    case 'text':
      return `<div class="msg-ai"><div class="msg-ai-content">${md(item.text)}</div></div>`

    case 'tool_call': {
      const icons = { web_search:'🔍', fetch_webpage:'📄', get_current_page:'🖥️', open_url:'🔗', get_all_tabs:'📑', save_note:'💾' }
      const icon = icons[item.toolName] || '⚙️'
      const label = item.toolName === 'web_search'
        ? `Searching: "${item.toolInput.query}"`
        : item.toolName === 'get_current_page' ? 'Reading current page…'
        : item.toolName === 'get_all_tabs'     ? 'Reading all open tabs…'
        : item.toolName === 'save_note'        ? `Saving "${item.toolInput.filename}"`
        : item.toolName === 'open_url'         ? `Opening ${item.toolInput.url}`
        : `Fetching ${item.toolInput.url || ''}`
      const st = item.status || 'running'
      const badge = st === 'running' ? '<div class="spinner"></div> Working…' : st === 'done' ? '✓ Done' : '✗ Error'
      return `
        <div class="tool-card ${st}">
          <span class="tool-icon">${icon}</span>
          <div class="tool-body">
            <div class="tool-title">${esc(label)}</div>
            ${item.summary ? `<div class="tool-subtitle">${esc(item.summary)}</div>` : ''}
          </div>
          <div class="tool-badge ${st}">${badge}</div>
        </div>`
    }

    case 'feedback':
      return `<div class="feedback-row">
        <button class="feedback-btn" title="Good">👍</button>
        <button class="feedback-btn" title="Bad">👎</button>
      </div>`

    case 'error':
      return `<div class="feed-item"><div class="error-card"><span>⚠️</span>${esc(item.text)}</div></div>`

    default: return ''
  }
}

function patchItem(itemId) {
  const session = activeSession()
  const item = session?.items.find(i => i.id === itemId)
  const el = document.getElementById(`item-${itemId}`)
  if (item && el) el.innerHTML = itemHTML(item)
}

function appendItem(item) {
  const session = activeSession()
  if (!session) return
  $('feedEmpty')?.remove()
  session.items.push(item)
  const feed = $('feed')
  feed.appendChild(buildItem(item))
  scrollFeed()
}

function scrollFeed() {
  const feed = $('feed')
  if (feed) feed.scrollTop = feed.scrollHeight
}

// ─── Agent events ─────────────────────────────────────────────────────────────

const toolCardMap = {}   // toolId → itemId
let currentTextId = null

function handleAgentEvent(event) {
  if (event.sessionId !== activeTabId) return

  switch (event.type) {
    case 'tool_call': {
      const item = {
        id: `tc-${event.toolId}`, type: 'tool_call',
        toolName: event.toolName, toolInput: event.toolInput, status: 'running',
      }
      toolCardMap[event.toolId] = item.id
      currentTextId = null
      appendItem(item)
      break
    }
    case 'tool_result': {
      const itemId = toolCardMap[event.toolId]
      const session = activeSession()
      const item = session?.items.find(i => i.id === itemId)
      if (item) {
        item.status = 'done'
        const firstLine = event.result.split('\n').find(l => l.trim()) || ''
        item.summary = firstLine.slice(0, 90) + (firstLine.length > 90 ? '…' : '')
        patchItem(itemId)
        scrollFeed()
      }
      break
    }
    case 'text': {
      if (currentTextId) {
        const session = activeSession()
        const item = session?.items.find(i => i.id === currentTextId)
        if (item) { item.text = event.text; patchItem(currentTextId); scrollFeed(); break }
      }
      const item = { id: `txt-${Date.now()}`, type: 'text', text: event.text }
      currentTextId = item.id
      appendItem(item)
      break
    }
    case 'error':
      appendItem({ id: `err-${Date.now()}`, type: 'error', text: event.text })
      finishRun()
      break
    case 'done':
      currentTextId = null
      appendItem({ id: `fb-${Date.now()}`, type: 'feedback' })
      finishRun()
      break
  }
}

function finishRun() {
  isRunning = false
  $('sendBtn').disabled = false
  $('mainInput').disabled = false
}

// ─── Send message ─────────────────────────────────────────────────────────────

async function sendMessage(prefill) {
  if (isRunning) return
  const input = $('mainInput')
  const text = (prefill || input.value).trim()
  if (!text) return
  if (!prefill) input.value = ''
  resizeInput()

  // If a browser tab is active, switch to or create a companion session tab
  const currentTab = allTabs.find(t => t.id === activeTabId)
  if (currentTab?.type === 'browser') {
    // Find or create a session tab to hold the conversation
    let sessionTab = allTabs.find(t => t.type === 'session')
    if (!sessionTab) {
      await api.tab.create({ type: 'session' })
      return // Will re-trigger after switch
    }
    await api.tab.switch(sessionTab.id)
    // Give renderer a tick to update, then send
    setTimeout(() => sendMessage(text), 50)
    return
  }

  const session = activeSession()
  if (!session) return

  isRunning = true
  $('sendBtn').disabled = true

  if (session.items.length === 0) {
    session.title = text.slice(0, 48) + (text.length > 48 ? '…' : '')
    renderTabs()
    updateBreadcrumb()
  }

  appendItem({ id: `u-${Date.now()}`, type: 'user', text })

  const history = session.history.slice()
  session.history.push({ role: 'user', content: text })

  api.agent.run({ message: text, sessionId: activeTabId, history })
}

// ─── Quick-action bar (browser tabs) ─────────────────────────────────────────

$('baiAnalyze').addEventListener('click',   () => sendMessage('Analyze what is currently on this page and give me a detailed summary.'))
$('baiLinks').addEventListener('click',     () => sendMessage('Extract and list all the important links on the current page.'))
$('baiSummarize').addEventListener('click', () => sendMessage('Summarize this page in bullet points.'))
$('analyzeBtn').addEventListener('click',   () => sendMessage('Analyze this page and give me key insights.'))

// ─── Input controls ───────────────────────────────────────────────────────────

function resizeInput() {
  const el = $('mainInput')
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 180) + 'px'
}

$('mainInput').addEventListener('input', resizeInput)
$('mainInput').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() }
})
$('sendBtn').addEventListener('click', () => sendMessage())

// ─── Browser nav bar ──────────────────────────────────────────────────────────

$('navBack').addEventListener('click',    () => api.browser.goBack())
$('navForward').addEventListener('click', () => api.browser.goForward())
$('navReload').addEventListener('click',  () => api.browser.reload())

$('urlInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') api.browser.navigate(e.target.value.trim())
})
$('urlInput').addEventListener('focus', e => e.target.select())

// ─── New tab buttons ──────────────────────────────────────────────────────────

$('tabNewSession').addEventListener('click',  () => api.tab.create({ type: 'session' }))
$('tabNewBrowser').addEventListener('click',  () => api.tab.create({ type: 'browser', url: 'https://www.google.com' }))
$('sbNewSession').addEventListener('click',   () => api.tab.create({ type: 'session' }))
$('sbNewBrowser').addEventListener('click',   () => api.tab.create({ type: 'browser', url: 'https://www.google.com' }))

// ─── Profile popup ────────────────────────────────────────────────────────────

$('avatarBtn').addEventListener('click', e => { e.stopPropagation(); $('profilePopup').classList.toggle('open') })
document.addEventListener('click', () => $('profilePopup').classList.remove('open'))
$('profilePopup').addEventListener('click', e => e.stopPropagation())

$('ppHistory').addEventListener('click', async () => {
  $('profilePopup').classList.remove('open')
  const history = await api.memory.getHistory(20)
  const text = history.length
    ? history.map(h => `**${h.title || h.type}** (${h.timestamp?.slice(0,10)})\n${(h.result||'').slice(0,200)}`).join('\n\n---\n\n')
    : 'No history yet.'
  const session = activeSession()
  if (session) appendItem({ id: `hist-${Date.now()}`, type: 'text', text: '## Research History\n\n' + text })
})

// ─── Markdown renderer ────────────────────────────────────────────────────────

function md(raw) {
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
