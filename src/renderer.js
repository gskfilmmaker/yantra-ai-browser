'use strict'
/* global api, strawberry */

// ─── State ────────────────────────────────────────────────────────────────────

let tabs        = []
let activeTabId = null
let isRunning   = false
let activeAgent = null

const convos = {}

// ─── Agent bootstrap ──────────────────────────────────────────────────────────

async function initAgents() {
  try {
    activeAgent = await strawberry.agents.getActive()
    updateAgentUI()
  } catch (e) { /* agents not yet available */ }
}

function updateAgentUI() {
  if (!activeAgent) return
  const avatar = $('agentSelAvatar')
  if (avatar) avatar.textContent = activeAgent.avatar || '🤖'
  const ctxAgent = $('ctxAgent')
  if (ctxAgent) ctxAgent.textContent = activeAgent.name
  // Update new-tab page
  const ntAvatar = $('ntAgentAvatar')
  const ntName   = $('ntAgentName')
  if (ntAvatar) ntAvatar.textContent = activeAgent.avatar || '🤖'
  if (ntName)   ntName.textContent   = activeAgent.name   || 'Strawberry'
}

initAgents()

// ─── IPC event wiring ─────────────────────────────────────────────────────────

api.on.tabSwitched(({ tabId, tabs: t }) => {
  tabs = t; activeTabId = tabId
  if (!convos[tabId]) convos[tabId] = { items: [] }
  renderTabs()
  syncURL()
  syncNavButtons(t.find(tab => tab.id === tabId))
  syncContextBar(t.find(tab => tab.id === tabId))
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
    syncNavButtons(tab)
    syncContextBar(tab)
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
  const input = $('urlInput')
  if (t.title && t.url && !t.url.startsWith('about:')) {
    input.value = `strawberry / ${t.title}`
    input.dataset.realUrl = t.url
  } else {
    input.value = ''
    input.dataset.realUrl = ''
  }
}

function syncNavButtons(tab) {
  $('navBack').disabled    = !tab?.canGoBack
  $('navForward').disabled = !tab?.canGoForward
}

function syncContextBar(tab) {
  const bar = $('contextBar')
  if (!bar) return
  if (!tab?.url || tab.url === 'about:blank' || tab.url === '') {
    bar.hidden = true; return
  }
  bar.hidden = false
  const favicon = $('ctxFavicon')
  const page    = $('ctxPage')
  if (favicon) favicon.textContent = tab.favicon ? '' : '🌐'
  if (favicon && tab.favicon) {
    favicon.innerHTML = `<img src="${tab.favicon}" width="14" height="14" style="vertical-align:middle" onerror="this.outerHTML='🌐'">`
  }
  if (page) page.textContent = tab.title || tab.url
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

$('navBack').addEventListener('click',    () => api.browser.goBack())
$('navForward').addEventListener('click', () => api.browser.goForward())
$('navReload').addEventListener('click',  () => api.browser.reload())

$('urlInput').addEventListener('focus', e => {
  if (e.target.dataset.realUrl) e.target.value = e.target.dataset.realUrl
  e.target.select()
})
$('urlInput').addEventListener('blur',    () => syncURL())
$('urlInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') { navigate(e.target.value); e.target.blur() }
  if (e.key === 'Escape') { e.target.blur() }
})

// ─── New-tab page (AI-first) ──────────────────────────────────────────────────

function handleNewTabInput(text) {
  text = text.trim()
  if (!text) return
  const isURL = text.startsWith('http') || text.startsWith('www.') ||
    /^[\w-]+\.[a-z]{2,}(\/|$)/i.test(text)
  if (isURL) {
    navigate(text)
  } else {
    hideNewTabPage()
    aiOverlay.style.display = 'flex'
    scheduleBoundsUpdate()
    sendMessage(text)
  }
}

$('ntSearch').addEventListener('keydown', e => {
  if (e.key === 'Enter') { handleNewTabInput($('ntSearch').value); $('ntSearch').value = '' }
})
$('ntGo').addEventListener('click', () => {
  handleNewTabInput($('ntSearch').value); $('ntSearch').value = ''
})

// Quick-action chips
document.querySelectorAll('.nt-chip').forEach(btn => {
  btn.addEventListener('click', () => {
    const msg = btn.dataset.msg
    if (msg) {
      hideNewTabPage()
      aiOverlay.style.display = 'flex'
      scheduleBoundsUpdate()
      sendMessage(msg)
    }
  })
})

function hideNewTabPage() { $('newTabPage').classList.add('hidden') }
function showNewTabPage() {
  $('newTabPage').classList.remove('hidden')
  $('ntSearch').focus()
}

// ─── Agent picker ─────────────────────────────────────────────────────────────

const agentSel    = $('agentSel')
const agentPicker = $('agentPicker')

agentSel?.addEventListener('click', async (e) => {
  e.stopPropagation()
  if (!agentPicker.hidden) { agentPicker.hidden = true; return }

  const agents = await strawberry.agents.list()
  agentPicker.innerHTML = agents.map(a => `
    <div class="agent-option${a.id === activeAgent?.id ? ' active' : ''}" data-id="${esc(a.id)}">
      <span class="agent-option-avatar">${esc(a.avatar || '🤖')}</span>
      <div>
        <div class="agent-option-name">${esc(a.name)}</div>
        <div class="agent-option-desc">${esc(a.description || '')}</div>
      </div>
    </div>
  `).join('') + `
    <div class="agent-picker-sep"></div>
    <button class="agent-picker-new" id="agentPickerNew">+ Create new agent</button>
  `

  agentPicker.querySelectorAll('.agent-option').forEach(el => {
    el.addEventListener('click', async () => {
      await strawberry.agents.setActive(el.dataset.id)
      activeAgent = await strawberry.agents.getActive()
      updateAgentUI()
      agentPicker.hidden = true
      addCard({ id: `agent-${Date.now()}`, type: 'text',
        text: `Switched to **${activeAgent.name}** ${activeAgent.avatar || ''}` })
    })
  })

  $('agentPickerNew')?.addEventListener('click', () => {
    agentPicker.hidden = true
    openAgentModal()
  })

  agentPicker.hidden = false
})

document.addEventListener('click', () => { if (agentPicker) agentPicker.hidden = true })

// ─── Agent creation modal ─────────────────────────────────────────────────────

const agentModal = $('agentModal')

function openAgentModal() {
  $('agentAvatar').value      = '🤖'
  $('agentName').value        = ''
  $('agentDesc').value        = ''
  $('agentPrompt').value      = ''
  $('agentMemory').value      = 'global'
  $('agentAutoContext').checked = true
  agentModal.hidden = false
}

function closeAgentModal() { agentModal.hidden = true }

$('agentModalClose').addEventListener('click',  closeAgentModal)
$('agentModalCancel').addEventListener('click', closeAgentModal)
agentModal.addEventListener('click', e => { if (e.target === agentModal) closeAgentModal() })

$('agentModalSave').addEventListener('click', async () => {
  const name = $('agentName').value.trim()
  if (!name) { $('agentName').focus(); return }

  const cfg = {
    name,
    avatar:       $('agentAvatar').value.trim() || '🤖',
    description:  $('agentDesc').value.trim(),
    systemPrompt: $('agentPrompt').value.trim() || `You are ${name}, a helpful AI assistant.`,
    tools: ['web_search', 'fetch_webpage', 'get_current_page', 'extractTable', 'extractEntities',
            'generateReport', 'save_note', 'saveFinding', 'searchMemory'],
    memoryScope:  $('agentMemory').value,
    autoContext:  $('agentAutoContext').checked,
  }

  const created = await strawberry.agents.create(cfg)
  closeAgentModal()
  await strawberry.agents.setActive(created.id)
  activeAgent = await strawberry.agents.getActive()
  updateAgentUI()
  addCard({ id: `created-${Date.now()}`, type: 'text',
    text: `Created and activated **${created.name}** ${created.avatar}` })
})

$('sbAvatar').addEventListener('click', openAgentModal)

// ─── Routine events ───────────────────────────────────────────────────────────

strawberry.on.routineEvent(ev => {
  if (ev.type === 'start') {
    addCard({ id: `rt-${ev.routineId}-start`, type: 'tool_call', toolName: 'runRoutine',
      toolInput: { name: ev.routineName }, status: 'running' })
  } else if (ev.type === 'done') {
    const item = convo().items.find(i => i.id === `rt-${ev.routineId}-start`)
    if (item) { item.status = 'done'; item.summary = ev.result?.slice(0, 80); patchCard(item.id) }
    addCard({ id: `rt-${ev.routineId}-result`, type: 'text',
      text: `**Routine: ${ev.routineName}**\n\n${ev.result}` })
  } else if (ev.type === 'error') {
    addCard({ id: `rt-${ev.routineId}-err`, type: 'error',
      text: `Routine "${ev.routineName}": ${ev.error}` })
  }
})

// ─── URL bar focus ────────────────────────────────────────────────────────────

api.on.focusUrlBar(() => {
  const input = $('urlInput')
  if (input.dataset.realUrl) input.value = input.dataset.realUrl
  input.focus(); input.select()
})

// ─── Find in page ─────────────────────────────────────────────────────────────

const findBar   = $('findBar')
const findInput = $('findInput')
const findCount = $('findCount')

function openFindBar()  {
  findBar.hidden = false; findInput.focus(); findInput.select(); scheduleBoundsUpdate()
}
function closeFindBar() {
  findBar.hidden = true; findInput.value = ''; findCount.textContent = ''
  api.browser.stopFindInPage(); scheduleBoundsUpdate()
}

api.on.startFind(openFindBar)
api.on.findResult(({ activeMatchOrdinal, matches }) => {
  findCount.textContent = matches ? `${activeMatchOrdinal}/${matches}` : 'No results'
})

findInput.addEventListener('input', () => {
  if (findInput.value.trim()) api.browser.findInPage(findInput.value)
  else { findCount.textContent = ''; api.browser.stopFindInPage() }
})
findInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') api.browser.findInPage(findInput.value, { forward: !e.shiftKey, findNext: true })
  if (e.key === 'Escape') closeFindBar()
})
$('findPrev').addEventListener('click',  () => api.browser.findInPage(findInput.value, { forward: false, findNext: true }))
$('findNext').addEventListener('click',  () => api.browser.findInPage(findInput.value, { forward: true,  findNext: true }))
$('findClose').addEventListener('click', closeFindBar)

// ─── Top nav buttons ──────────────────────────────────────────────────────────

$('btnChat').addEventListener('click', () => {
  const overlay = $('aiOverlay')
  overlay.style.display = overlay.style.display === 'none' ? 'flex' : 'none'
  scheduleBoundsUpdate()
})

$('btnUpdateNow').addEventListener('click', () => {
  const tab = tabs.find(t => t.id === activeTabId)
  const msg = tab?.url && !tab.url.startsWith('about:')
    ? 'Summarize the current page and highlight the most important information.'
    : 'What can you help me with? Give me a quick overview of your capabilities.'
  aiOverlay.style.display = 'flex'
  scheduleBoundsUpdate()
  sendMessage(msg)
})

$('sbHistory').addEventListener('click', async () => {
  const hist = await api.memory.getHistory(10)
  const text = hist.length
    ? hist.map(h => `**${h.title||h.type}** — ${h.timestamp?.slice(0,10)}\n${(h.result||'').slice(0,200)}`).join('\n\n---\n\n')
    : 'No history yet.'
  addCard({ id: `hist-${Date.now()}`, type: 'text', text: '## Recent Research\n\n' + text })
})

// ─── BrowserView bounds ───────────────────────────────────────────────────────

let boundsTimer = null
function scheduleBoundsUpdate() {
  clearTimeout(boundsTimer)
  boundsTimer = setTimeout(updateBrowserViewBounds, 30)
}

function updateBrowserViewBounds() {
  const sidebar  = $('sidebar')
  const navRow   = $('navRow')
  const overlay  = $('aiOverlay')
  const tabStrip = $('tabStrip')

  const sidebarW = sidebar.offsetWidth
  const topY     = tabStrip.offsetHeight + navRow.offsetHeight
  const winH     = window.innerHeight
  const overlayH = overlay.offsetHeight

  api.browser.setBounds({
    x:      Math.round(sidebarW),
    y:      Math.round(topY),
    width:  Math.round(window.innerWidth - sidebarW),
    height: Math.round(winH - topY - overlayH),
  })
}

window.addEventListener('resize', scheduleBoundsUpdate)

// ─── AI overlay drag resize ───────────────────────────────────────────────────

let dragStart = null
const dragHandle = $('aiDragHandle')
const aiOverlay  = $('aiOverlay')

dragHandle.addEventListener('mousedown', e => {
  dragStart = { y: e.clientY, h: aiOverlay.offsetHeight }
  document.addEventListener('mousemove', onDragMove)
  document.addEventListener('mouseup',   onDragUp)
})

function onDragMove(e) {
  if (!dragStart) return
  const delta = dragStart.y - e.clientY
  const newH  = Math.max(68, Math.min(500, dragStart.h + delta))
  aiOverlay.style.minHeight = newH + 'px'
  scheduleBoundsUpdate()
}
function onDragUp() {
  dragStart = null
  document.removeEventListener('mousemove', onDragMove)
  document.removeEventListener('mouseup',   onDragUp)
}

// ─── AI Thread ────────────────────────────────────────────────────────────────

function convo() { return convos[activeTabId] || { items: [] } }

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

    case 'plan': {
      const steps = (item.steps || []).map((s, i) =>
        `<li class="plan-step"><span class="plan-step-num">${i + 1}</span><span>${esc(s)}</span></li>`
      ).join('')
      return `<div class="card card-plan">
        <div class="plan-header">
          <span class="plan-icon">🎯</span>
          <span class="plan-title">${esc(item.title || 'Multi-step plan')}</span>
          <span class="plan-badge">Plan</span>
        </div>
        <ol class="plan-steps">${steps}</ol>
      </div>`
    }

    case 'tool_call': {
      const icons = {
        web_search: '🔍', fetch_webpage: '📄', get_current_page: '🖥️',
        open_url: '🔗', get_all_tabs: '📑', save_note: '💾',
        extractTable: '📊', exportCSV: '📁', extractEntities: '🏷️',
        generateReport: '📝', exportPDF: '🖨️', getSelectedText: '✂️',
        getPageStructure: '🗺️', clickElement: '👆', typeInField: '⌨️',
        pressKey: '⌨️', scrollPage: '📜', waitForElement: '⏳',
        captureScreenshot: '📸',
      }
      const icon  = icons[item.toolName] || '⚙️'
      const title = item.toolName === 'web_search'        ? `Searching: "${item.toolInput?.query}"`
                  : item.toolName === 'get_current_page'  ? 'Reading current page…'
                  : item.toolName === 'get_all_tabs'      ? 'Reading all open tabs…'
                  : item.toolName === 'save_note'         ? `Saving "${item.toolInput?.filename}"`
                  : item.toolName === 'open_url'          ? `Opening ${item.toolInput?.url}`
                  : item.toolName === 'extractTable'      ? 'Extracting tables from page…'
                  : item.toolName === 'extractEntities'   ? 'Extracting entities from page…'
                  : item.toolName === 'generateReport'    ? `Generating: "${item.toolInput?.title}"`
                  : item.toolName === 'exportCSV'         ? `Exporting CSV: "${item.toolInput?.filename}"`
                  : item.toolName === 'exportPDF'         ? 'Exporting page as PDF…'
                  : item.toolName === 'getPageStructure'  ? 'Mapping interactive elements…'
                  : item.toolName === 'clickElement'      ? `Clicking: "${item.toolInput?.text || item.toolInput?.selector}"`
                  : item.toolName === 'typeInField'       ? `Typing into field…`
                  : item.toolName === 'pressKey'          ? `Pressing ${item.toolInput?.key}`
                  : item.toolName === 'scrollPage'        ? `Scrolling ${item.toolInput?.direction}…`
                  : item.toolName === 'waitForElement'    ? `Waiting for "${item.toolInput?.selector}"…`
                  : item.toolName === 'captureScreenshot' ? 'Taking screenshot…'
                  : `Fetching ${item.toolInput?.url || ''}`
      const st    = item.status || 'running'
      const badge = st === 'running' ? '<span class="spinner"></span> Working…'
                  : st === 'done'    ? '✓ Done' : '✗ Error'
      const screenshotHtml = item.screenshot
        ? `<img class="card-screenshot" src="${item.screenshot}" alt="Screenshot">`
        : ''
      return `<div class="card-tool ${st}">
        <span class="ct-icon">${icon}</span>
        <div class="ct-body">
          <div class="ct-title">${esc(title)}</div>
          ${item.summary && !item.screenshot ? `<div class="ct-sub">${esc(item.summary)}</div>` : ''}
        </div>
        <div class="ct-badge ${st}">${badge}</div>
      </div>${screenshotHtml}`
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
    case 'plan':
      addCard({ id: `plan-${Date.now()}`, type: 'plan', title: ev.title, steps: ev.steps })
      break

    case 'tool_call': {
      const item = { id: `tc-${ev.toolId}`, type: 'tool_call',
        toolName: ev.toolName, toolInput: ev.toolInput, status: 'running' }
      toolMap[ev.toolId] = item.id
      curTextId = null
      addCard(item)
      break
    }

    case 'tool_result': {
      const id   = toolMap[ev.toolId]
      const item = convo().items.find(i => i.id === id)
      if (item) {
        item.status = 'done'
        if (ev.result && ev.result.startsWith('data:image/')) {
          item.screenshot = ev.result
          item.summary    = 'Screenshot captured'
        } else {
          const line = (ev.result || '').split('\n').find(l => l.trim()) || ''
          item.summary = line.slice(0, 100) + (line.length > 100 ? '…' : '')
        }
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
  $('aiSend').disabled  = false
  $('aiInput').disabled = false
}

// ─── Send message ─────────────────────────────────────────────────────────────

async function sendMessage(prefill) {
  if (isRunning) return
  const inputEl = $('aiInput')
  const text = (prefill || inputEl.value).trim()
  if (!text) return
  if (!prefill) { inputEl.value = ''; resizeAiInput() }

  if (!convos[activeTabId]) convos[activeTabId] = { items: [] }

  isRunning = true
  $('aiSend').disabled  = true
  $('aiInput').disabled = true

  $('sessionTab').textContent = text.slice(0, 30) + (text.length > 30 ? '…' : '')
  addCard({ id: `u-${Date.now()}`, type: 'user', text })

  api.agent.run({ message: text, sessionId: activeTabId })
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
