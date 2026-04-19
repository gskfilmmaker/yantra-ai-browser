'use strict'

// ─── Session state ────────────────────────────────────────────────────────────

let sessions = []
let activeSessionId = null
let sessionCounter = 0
let isRunning = false

function genId() { return ++sessionCounter }

function createSession(title = 'New session') {
  const id = genId()
  sessions.push({ id, title, items: [], history: [] })
  switchSession(id)
  renderTabs()
  return id
}

function switchSession(id) {
  activeSessionId = id
  renderFeed()
  renderTabs()
  updateBreadcrumb()
}

function closeSession(id) {
  const idx = sessions.findIndex(s => s.id === id)
  if (idx === -1) return
  sessions.splice(idx, 1)
  if (sessions.length === 0) { createSession(); return }
  if (activeSessionId === id) {
    switchSession(sessions[Math.min(idx, sessions.length - 1)].id)
  } else {
    renderTabs()
  }
}

function activeSession() {
  return sessions.find(s => s.id === activeSessionId)
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────

function renderTabs() {
  const list = document.getElementById('tabsList')
  list.innerHTML = ''
  sessions.forEach(s => {
    const el = document.createElement('div')
    el.className = `tab${s.id === activeSessionId ? ' active' : ''}`
    el.innerHTML = `
      <span class="tab-icon">🍓</span>
      <span class="tab-label">${esc(s.title)}</span>
      <button class="tab-close" data-id="${s.id}" title="Close">×</button>
    `
    el.addEventListener('click', (e) => {
      if (!e.target.classList.contains('tab-close')) switchSession(s.id)
    })
    list.appendChild(el)
  })
  list.querySelectorAll('.tab-close').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); closeSession(+btn.dataset.id) })
  })
}

// ─── Feed rendering ───────────────────────────────────────────────────────────

function renderFeed() {
  const feed = document.getElementById('feed')
  const session = activeSession()
  if (!session || session.items.length === 0) {
    feed.innerHTML = `
      <div class="feed-empty" id="feedEmpty">
        <div class="feed-empty-icon">🍓</div>
        <div class="feed-empty-title">What can I help you with?</div>
        <div class="feed-empty-sub">Research topics, analyze pages, automate tasks — just ask.</div>
      </div>`
    return
  }
  feed.innerHTML = ''
  session.items.forEach(item => feed.appendChild(renderItem(item)))
  scrollFeed()
}

function renderItem(item) {
  const wrap = document.createElement('div')
  wrap.className = 'feed-item'
  wrap.id = `item-${item.id}`
  wrap.innerHTML = buildItemHTML(item)
  return wrap
}

function buildItemHTML(item) {
  switch (item.type) {
    case 'user':
      return `<div class="msg-user"><div class="msg-user-bubble">${esc(item.text)}</div></div>`

    case 'text':
      return `<div class="msg-ai"><div class="msg-ai-content">${renderMarkdown(item.text)}</div></div>`

    case 'tool_call': {
      const iconMap = { web_search: '🔍', fetch_webpage: '📄', save_note: '💾' }
      const icon = iconMap[item.toolName] || '⚙️'
      const label = item.toolName === 'web_search'
        ? `Searching for "${item.toolInput.query}"`
        : item.toolName === 'save_note'
        ? `Saving "${item.toolInput.filename}"`
        : `Reading ${item.toolInput.url}`
      const status = item.status || 'running'
      const badgeLabel = status === 'running' ? 'Working…' : status === 'done' ? '✓ Done' : '✗ Error'
      return `
        <div class="tool-card ${status}">
          <span class="tool-icon">${icon}</span>
          <div class="tool-body">
            <div class="tool-title">${esc(label)}</div>
            ${item.summary ? `<div class="tool-subtitle">${esc(item.summary)}</div>` : ''}
          </div>
          <div class="tool-badge ${status}">
            ${status === 'running' ? '<div class="spinner"></div>' : ''}
            ${badgeLabel}
          </div>
        </div>`
    }

    case 'insight':
      return `
        <div class="insight-card">
          <span class="insight-icon">💡</span>
          <span>${esc(item.text)}</span>
        </div>`

    case 'feedback':
      return `<div class="feedback-row">
        <button class="feedback-btn">👍</button>
        <button class="feedback-btn">👎</button>
      </div>`

    case 'error':
      return `<div class="tool-card error">
        <span class="tool-icon">⚠️</span>
        <div class="tool-body"><div class="tool-title">${esc(item.text)}</div></div>
        <div class="tool-badge error">Error</div>
      </div>`

    default:
      return ''
  }
}

function patchItem(itemId) {
  const session = activeSession()
  if (!session) return
  const item = session.items.find(i => i.id === itemId)
  if (!item) return
  const el = document.getElementById(`item-${itemId}`)
  if (!el) return
  el.innerHTML = buildItemHTML(item)
}

function appendItem(item) {
  const session = activeSession()
  if (!session) return

  // Remove empty state
  const empty = document.getElementById('feedEmpty')
  if (empty) empty.remove()

  session.items.push(item)
  const feed = document.getElementById('feed')
  feed.appendChild(renderItem(item))
  scrollFeed()
}

function scrollFeed() {
  const feed = document.getElementById('feed')
  feed.scrollTop = feed.scrollHeight
}

function updateBreadcrumb() {
  const session = activeSession()
  document.getElementById('sessionTitle').textContent = session ? session.title : 'New session'
}

// ─── Agent events ─────────────────────────────────────────────────────────────

// Map toolId → itemId
const toolCardMap = {}
// Current AI text item id
let currentTextItemId = null

window.api.onAgentEvent((event) => {
  if (event.sessionId !== activeSessionId) return

  switch (event.type) {
    case 'tool_call': {
      const item = { id: `tc-${event.toolId}`, type: 'tool_call', toolName: event.toolName, toolInput: event.toolInput, status: 'running' }
      toolCardMap[event.toolId] = item.id
      currentTextItemId = null
      appendItem(item)
      break
    }

    case 'tool_result': {
      const itemId = toolCardMap[event.toolId]
      if (!itemId) break
      const session = activeSession()
      const item = session?.items.find(i => i.id === itemId)
      if (!item) break
      item.status = 'done'
      // Generate a short summary from result
      const firstLine = event.result.split('\n').find(l => l.trim()) || ''
      item.summary = firstLine.slice(0, 80) + (firstLine.length > 80 ? '…' : '')
      patchItem(itemId)
      scrollFeed()
      break
    }

    case 'text': {
      if (currentTextItemId) {
        const session = activeSession()
        const item = session?.items.find(i => i.id === currentTextItemId)
        if (item) {
          item.text = event.text
          patchItem(currentTextItemId)
          scrollFeed()
          break
        }
      }
      const item = { id: `txt-${Date.now()}`, type: 'text', text: event.text }
      currentTextItemId = item.id
      appendItem(item)
      break
    }

    case 'error': {
      appendItem({ id: `err-${Date.now()}`, type: 'error', text: event.text })
      finishRun()
      break
    }

    case 'done': {
      currentTextItemId = null
      appendItem({ id: `fb-${Date.now()}`, type: 'feedback' })
      finishRun()
      break
    }
  }
})

function finishRun() {
  isRunning = false
  document.getElementById('sendBtn').disabled = false
  document.getElementById('mainInput').disabled = false
}

// ─── Send message ─────────────────────────────────────────────────────────────

async function sendMessage() {
  if (isRunning) return
  const input = document.getElementById('mainInput')
  const text = input.value.trim()
  if (!text) return

  input.value = ''
  resizeInput()
  isRunning = true
  document.getElementById('sendBtn').disabled = true

  const session = activeSession()

  // Update session title from first message
  if (session.items.length === 0) {
    session.title = text.slice(0, 45) + (text.length > 45 ? '…' : '')
    renderTabs()
    updateBreadcrumb()
  }

  appendItem({ id: `u-${Date.now()}`, type: 'user', text })

  // Build history for Claude (only user/assistant pairs, not tool cards)
  const history = session.history.slice()

  window.api.runAgent({ message: text, sessionId: session.id, history })

  // Add to history after sending
  session.history.push({ role: 'user', content: text })
}

// ─── Input auto-resize ────────────────────────────────────────────────────────

function resizeInput() {
  const el = document.getElementById('mainInput')
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 180) + 'px'
}

document.getElementById('mainInput').addEventListener('input', resizeInput)
document.getElementById('mainInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() }
})

document.getElementById('sendBtn').addEventListener('click', sendMessage)

// ─── Tabs / sessions ──────────────────────────────────────────────────────────

document.getElementById('tabNewBtn').addEventListener('click', () => createSession())
document.getElementById('sbNewBtn').addEventListener('click', () => createSession())

// ─── Profile popup ────────────────────────────────────────────────────────────

document.getElementById('avatarBtn').addEventListener('click', (e) => {
  e.stopPropagation()
  document.getElementById('profilePopup').classList.toggle('open')
})
document.addEventListener('click', () => {
  document.getElementById('profilePopup').classList.remove('open')
})
document.getElementById('profilePopup').addEventListener('click', (e) => e.stopPropagation())

// ─── Markdown renderer ────────────────────────────────────────────────────────

function renderMarkdown(raw) {
  let t = esc(raw)
  // Code blocks
  t = t.replace(/```([\s\S]*?)```/g, (_, c) => `<pre><code>${c}</code></pre>`)
  // Inline code
  t = t.replace(/`([^`\n]+)`/g, '<code>$1</code>')
  // Bold
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  // Italic
  t = t.replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
  // URLs → links
  t = t.replace(/(https?:\/\/[^\s<>"]+)/g, '<a href="#" onclick="return false">$1</a>')
  // Bullet points
  t = t.replace(/^• (.+)$/gm, '<li>$1</li>')
  t = t.replace(/(<li>[\s\S]*?<\/li>)/g, '<ul>$1</ul>')
  // Line breaks
  t = t.replace(/\n/g, '<br>')
  return t
}

function esc(str) {
  if (typeof str !== 'string') return ''
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

createSession()
