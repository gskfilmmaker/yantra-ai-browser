'use strict'
/* global api, yantra */

// ─── State ────────────────────────────────────────────────────────────────────

let tabs        = []
let activeTabId = null
let isRunning   = false
let activeAgent = null
let activePersona = null

const convos = {}
let _pendingTextRender = false  // batched DOM update flag
let _workingCardId    = null   // single collapsed "thinking" indicator

// ─── Utility ──────────────────────────────────────────────────────────────────

function $(id) { return document.getElementById(id) }
function esc(s) {
  if (typeof s !== 'string') return ''
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}
function timeAgo(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const s = Math.floor((Date.now() - d) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s/60)}m ago`
  if (s < 86400) return `${Math.floor(s/3600)}h ago`
  return d.toLocaleDateString()
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function init() {
  await Promise.all([initAgents(), initPersona()])
  checkOnboarding()
}

async function initAgents() {
  try {
    activeAgent = await yantra.agents.getActive()
    updateAgentUI()
  } catch { /* agents not yet available */ }
}

async function initPersona() {
  try {
    activePersona = await yantra.personas.getActive()
    updatePersonaUI()
  } catch { /* personas not yet available */ }
}

function updateAgentUI() {
  if (!activeAgent) return
  const avatar = $('agentSelAvatar')
  if (avatar) avatar.textContent = activeAgent.avatar || '🤖'
  const ctxAgent = $('ctxAgent')
  if (ctxAgent) ctxAgent.textContent = activeAgent.name
  const ntAvatar = $('ntAgentAvatar')
  const ntName   = $('ntAgentName')
  if (ntAvatar) ntAvatar.textContent = activeAgent.avatar || '🤖'
  if (ntName)   ntName.textContent   = activeAgent.name   || 'Yantra'
}

function updatePersonaUI() {
  if (!activePersona) return
  const avatar = $('personaAvatar')
  const name   = $('personaName')
  if (avatar) avatar.textContent = activePersona.avatar || '🤖'
  if (name)   name.textContent   = activePersona.name   || 'Persona'
}

init()

// ─── Onboarding ───────────────────────────────────────────────────────────────

async function checkOnboarding() {
  try {
    const s = await yantra.settings.get()
    if (!s.apiKey && !s.openaiApiKey) {
      $('onboardingOverlay').hidden = false
    }
  } catch { /* ignore */ }
}

$('onboardingSave').addEventListener('click', async () => {
  const key     = $('onboardingKey').value.trim()
  const openai  = $('onboardingOpenaiKey').value.trim()
  if (key)    await yantra.settings.set('apiKey',       key)
  if (openai) await yantra.settings.set('openaiApiKey', openai)
  $('onboardingOverlay').hidden = true
  addActivityItem('🎉', 'API key saved. Yantra is ready!')
})
$('onboardingSkip').addEventListener('click', () => {
  $('onboardingOverlay').hidden = true
})

// ─── IPC event wiring ─────────────────────────────────────────────────────────

api.on.tabSwitched(({ tabId, tabs: t }) => {
  tabs = t; activeTabId = tabId
  if (!convos[tabId]) convos[tabId] = { items: [] }
  _workingCardId = null; curTextId = null
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

yantra.on.routineEvent(ev => {
  if (ev.type === 'start') {
    addCard({ id: `rt-${ev.routineId}-start`, type: 'tool_call', toolName: 'runRoutine',
      toolInput: { name: ev.routineName }, status: 'running' })
    addActivityItem('⚡', `Routine started: ${ev.routineName}`)
  } else if (ev.type === 'done') {
    const item = convo().items.find(i => i.id === `rt-${ev.routineId}-start`)
    if (item) { item.status = 'done'; item.summary = ev.result?.slice(0, 80); patchCard(item.id) }
    addCard({ id: `rt-${ev.routineId}-result`, type: 'text',
      text: `**Routine: ${ev.routineName}**\n\n${ev.result}` })
    addActivityItem('✅', `Routine done: ${ev.routineName}`)
  } else if (ev.type === 'error') {
    addCard({ id: `rt-${ev.routineId}-err`, type: 'error',
      text: `Routine "${ev.routineName}": ${ev.error}` })
    addActivityItem('⚠️', `Routine error: ${ev.routineName}`)
  }
})

yantra.on.autonomyEvent(ev => {
  const icons = { schedule_fire: '🕐', schedule_done: '✅', schedule_error: '⚠️', monitor_triggered: '👁', monitor_task_done: '✅', monitor_task_error: '⚠️' }
  const icon = icons[ev.type] || '⚡'
  const text = ev.name
    ? `${ev.name}: ${ev.type.replace(/_/g, ' ')}`
    : ev.type.replace(/_/g, ' ')
  addActivityItem(icon, text)
})

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
    input.value = `yantra / ${t.title}`
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
  if (!tab?.url || tab.url === 'about:blank' || tab.url === '') { bar.hidden = true; return }
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
  closePanel()
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

// ─── Panel System ─────────────────────────────────────────────────────────────

const PANEL_IDS = ['panelHome', 'panelAgents', 'panelVault', 'panelAutomation', 'panelMemory', 'panelSettings']
let activePanel = null

function openPanel(name) {
  // Hide all panels
  PANEL_IDS.forEach(id => { const el = $(id); if (el) el.hidden = true })

  const panelMap = {
    home:       'panelHome',
    agents:     'panelAgents',
    vault:      'panelVault',
    automation: 'panelAutomation',
    memory:     'panelMemory',
    settings:   'panelSettings',
  }
  const panelId = panelMap[name]
  if (!panelId) return

  const panel = $(panelId)
  if (!panel) return

  api.browser.hide()
  panel.hidden = false
  activePanel = name
  updateSidebarActive(name)

  // Load panel data
  if (name === 'home')       renderHomePanel()
  if (name === 'agents')     renderAgentsPanel()
  if (name === 'vault')      renderVaultPanel()
  if (name === 'automation') renderAutomationPanel()
  if (name === 'memory')     renderMemoryPanel()
  if (name === 'settings')   loadSettingsPanel()

  scheduleBoundsUpdate()
}

function closePanel() {
  PANEL_IDS.forEach(id => { const el = $(id); if (el) el.hidden = true })
  activePanel = null
  api.browser.show()
  updateSidebarActive('browser')
  scheduleBoundsUpdate()
}

function updateSidebarActive(view) {
  document.querySelectorAll('.sb-btn[data-view]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === view)
  })
}

// Sidebar navigation
document.querySelectorAll('.sb-btn[data-view]').forEach(btn => {
  btn.addEventListener('click', () => {
    const view = btn.dataset.view
    if (view === 'browser') {
      closePanel()
    } else {
      openPanel(view)
    }
  })
})

// Panel close buttons (✕ buttons with data-close-panel)
document.querySelectorAll('[data-close-panel]').forEach(btn => {
  btn.addEventListener('click', closePanel)
})

// ─── Panel: Home / Command Center ─────────────────────────────────────────────

async function renderHomePanel() {
  const grid = $('homeGrid')
  if (!grid) return

  // Gather stats
  const [memories, routines, schedules, monitors] = await Promise.allSettled([
    yantra.memory.getAll(),
    yantra.routines.list(),
    yantra.autonomy.listSchedules(),
    yantra.autonomy.listMonitors(),
  ])

  const memCount   = memories.value?.length   || 0
  const rtCount    = routines.value?.length    || 0
  const schedCount = schedules.value?.length   || 0
  const monCount   = monitors.value?.length    || 0

  grid.innerHTML = `
    <div class="home-card">
      <div class="home-card-title">Memory</div>
      <div class="home-stat">${memCount}</div>
      <div class="home-stat-sub">saved items</div>
    </div>
    <div class="home-card">
      <div class="home-card-title">Automation</div>
      <div class="home-stat">${schedCount + rtCount}</div>
      <div class="home-stat-sub">${schedCount} schedules · ${rtCount} routines</div>
    </div>
    <div class="home-card">
      <div class="home-card-title">Monitoring</div>
      <div class="home-stat">${monCount}</div>
      <div class="home-stat-sub">page monitors active</div>
    </div>
    <div class="home-card" style="grid-column: 1 / -1">
      <div class="home-card-title">Quick Actions</div>
      <div class="home-actions">
        <button class="home-action" onclick="openPanel('agents')">
          <span class="home-action-icon">🤖</span>Agents
        </button>
        <button class="home-action" onclick="openPanel('vault')">
          <span class="home-action-icon">🔒</span>Vault
        </button>
        <button class="home-action" onclick="openPanel('automation')">
          <span class="home-action-icon">⚡</span>Automation
        </button>
        <button class="home-action" onclick="openPanel('memory')">
          <span class="home-action-icon">📚</span>Memory
        </button>
        <button class="home-action" onclick="openCmdPalette()">
          <span class="home-action-icon">⌘</span>Commands
        </button>
        <button class="home-action" onclick="closePanel(); sendMessage('What can you help me with today? Show me your capabilities.')">
          <span class="home-action-icon">✦</span>Ask Yantra
        </button>
      </div>
    </div>
  `
}

// ─── Panel: Agents & Personas ─────────────────────────────────────────────────

async function renderAgentsPanel() {
  const [personas, agents] = await Promise.allSettled([
    yantra.personas.list(),
    yantra.agents.list(),
  ])

  // Personas
  const personaGrid = $('personaGrid')
  if (personaGrid && personas.value) {
    personaGrid.innerHTML = personas.value.map(p => {
      const isActive = activePersona?.id === p.id
      return `
        <div class="persona-card${isActive ? ' active-persona' : ''}" data-persona-id="${esc(p.id)}">
          <div class="persona-card-avatar">${esc(p.avatar || '🤖')}</div>
          <div class="persona-card-body">
            <div class="persona-card-name">${esc(p.name)}</div>
            <div class="persona-card-style">${esc(p.thinkingStyle || 'balanced')} thinking · ${esc(p.communicationStyle || 'detailed')}</div>
            <div class="persona-card-desc">${esc((p.description || '').slice(0, 100))}${p.description?.length > 100 ? '…' : ''}</div>
            <div class="persona-card-stats">
              <span><span>${p.usageCount || 0}</span> tasks</span>
              <span><span>${p.memoryCount || 0}</span> memories</span>
            </div>
          </div>
          ${isActive ? '<div class="persona-active-badge">Active</div>' : ''}
        </div>
      `
    }).join('')

    personaGrid.querySelectorAll('.persona-card').forEach(card => {
      card.addEventListener('click', async () => {
        const id = card.dataset.personaId
        activePersona = await yantra.personas.switch(id)
        updatePersonaUI()
        renderAgentsPanel()
        addCard({ id: `ps-${Date.now()}`, type: 'text',
          text: `🧠 Switched to persona **${activePersona?.name}**` })
        addActivityItem('🧠', `Switched to persona: ${activePersona?.name}`)
      })
    })
  }

  // Agents
  const agentGrid = $('agentGrid')
  if (agentGrid && agents.value) {
    agentGrid.innerHTML = agents.value.map(a => {
      const isActive = activeAgent?.id === a.id
      return `
        <div class="agent-card${isActive ? ' active-agent' : ''}" data-agent-id="${esc(a.id)}">
          <div class="agent-card-avatar">${esc(a.avatar || '🤖')}</div>
          <div class="agent-card-meta">
            <div class="agent-card-name">${esc(a.name)}</div>
            <div class="agent-card-desc">${esc(a.description || '')}</div>
          </div>
          ${isActive ? '<div class="persona-active-badge" style="background:var(--blue)">Active</div>' : ''}
        </div>
      `
    }).join('')

    agentGrid.querySelectorAll('.agent-card').forEach(card => {
      card.addEventListener('click', async () => {
        await yantra.agents.setActive(card.dataset.agentId)
        activeAgent = await yantra.agents.getActive()
        updateAgentUI()
        renderAgentsPanel()
        addCard({ id: `ag-${Date.now()}`, type: 'text',
          text: `Switched to agent **${activeAgent.name}** ${activeAgent.avatar || ''}` })
      })
    })
  }
}

$('btnCreateAgent').addEventListener('click', () => {
  closePanel()
  openAgentModal()
})

// ─── Panel: Vault ─────────────────────────────────────────────────────────────

let _vaultData = []

async function renderVaultPanel() {
  _vaultData = await yantra.vault.list().catch(() => [])
  renderVaultList(_vaultData)
}

function renderVaultList(items) {
  const list  = $('vaultList')
  const empty = $('vaultEmpty')
  if (!items.length) {
    list.innerHTML = ''
    empty.hidden = false
    return
  }
  empty.hidden = true
  list.innerHTML = items.map(v => `
    <div class="vault-item" data-vault-id="${esc(v.id)}">
      <div class="vault-icon">🔐</div>
      <div class="vault-meta">
        <div class="vault-domain">${esc(v.domain || v.site || '—')}</div>
        <div class="vault-user">${esc(v.username)}</div>
        <div class="vault-pass">••••••••</div>
      </div>
      <button class="vault-del" data-vault-id="${esc(v.id)}" title="Delete">×</button>
    </div>
  `).join('')

  list.querySelectorAll('.vault-del').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation()
      if (!confirm('Delete this credential?')) return
      await yantra.vault.remove(btn.dataset.vaultId)
      _vaultData = _vaultData.filter(v => v.id !== btn.dataset.vaultId)
      renderVaultList(_vaultData)
    })
  })
}

$('vaultSearch').addEventListener('input', e => {
  const q = e.target.value.toLowerCase()
  renderVaultList(q ? _vaultData.filter(v => JSON.stringify(v).toLowerCase().includes(q)) : _vaultData)
})

// ─── Panel: Automation ────────────────────────────────────────────────────────

let _autoTab = 'schedules'

async function renderAutomationPanel() {
  await renderAutoTab(_autoTab)
}

async function renderAutoTab(tab) {
  _autoTab = tab
  $('autoSchedules').hidden  = tab !== 'schedules'
  $('autoMonitors').hidden   = tab !== 'monitors'
  $('autoRoutinesWrap').hidden = tab !== 'routines'

  document.querySelectorAll('.auto-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.autoTab === tab)
  })

  if (tab === 'schedules') {
    const items = await yantra.autonomy.listSchedules().catch(() => [])
    const el = $('autoSchedules')
    if (!items.length) {
      el.innerHTML = `<div class="panel-empty"><div class="panel-empty-icon">🕐</div><div class="panel-empty-title">No schedules</div><div class="panel-empty-sub">Use the chat to create a schedule: "Schedule a daily summary"</div></div>`
      return
    }
    el.innerHTML = items.map(s => `
      <div class="auto-item" data-sched-id="${esc(s.id)}">
        <div class="auto-item-icon">🕐</div>
        <div class="auto-item-body">
          <div class="auto-item-name">${esc(s.name)}</div>
          <div class="auto-item-meta">Every ${esc(s.interval)} · ${s.runCount || 0} runs · Last: ${s.lastRun ? timeAgo(s.lastRun) : 'never'}</div>
        </div>
        <span class="auto-status ${s.enabled ? 'active' : 'paused'}">${s.enabled ? 'Active' : 'Paused'}</span>
        <button class="auto-del" data-sched-id="${esc(s.id)}" title="Cancel">×</button>
      </div>
    `).join('')
    el.querySelectorAll('.auto-del').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Cancel this schedule?')) return
        await yantra.autonomy.cancelSchedule(btn.dataset.schedId)
        renderAutoTab('schedules')
      })
    })
  }

  if (tab === 'monitors') {
    const items = await yantra.autonomy.listMonitors().catch(() => [])
    const el = $('autoMonitors')
    if (!items.length) {
      el.innerHTML = `<div class="panel-empty"><div class="panel-empty-icon">👁</div><div class="panel-empty-title">No monitors</div><div class="panel-empty-sub">Use the chat: "Monitor example.com for changes"</div></div>`
      return
    }
    el.innerHTML = items.map(m => `
      <div class="auto-item" data-mon-id="${esc(m.id)}">
        <div class="auto-item-icon">👁</div>
        <div class="auto-item-body">
          <div class="auto-item-name">${esc(m.name)}</div>
          <div class="auto-item-meta">${esc((m.url || '').slice(0, 50))} · ${esc(m.condition?.type || '')} · ${m.triggerCount || 0} triggers</div>
        </div>
        <span class="auto-status active">Active</span>
        <button class="auto-del" data-mon-id="${esc(m.id)}" title="Remove">×</button>
      </div>
    `).join('')
    el.querySelectorAll('.auto-del').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Remove this monitor?')) return
        await yantra.autonomy.cancelMonitor(btn.dataset.monId)
        renderAutoTab('monitors')
      })
    })
  }

  if (tab === 'routines') {
    await refreshRoutinesInAutoPanel()
  }
}

async function refreshRoutinesInAutoPanel() {
  const routines = await yantra.routines.list()
  const list = $('autoRoutinesList')
  if (!routines.length) {
    list.innerHTML = `<div class="panel-empty"><div class="panel-empty-icon">⚡</div><div class="panel-empty-title">No routines yet</div><div class="panel-empty-sub">Create automations that run on page load or manually.</div><button class="panel-btn panel-btn-primary" style="margin-top:10px" id="autoNewRoutineBtn">+ New Routine</button></div>`
    const btn = $('autoNewRoutineBtn')
    if (btn) btn.addEventListener('click', () => openRoutineModal())
    return
  }
  list.innerHTML = routines.map(r => {
    const triggerLabel = r.trigger?.type === 'page_load'   ? `🔗 Page load`
                       : r.trigger?.type === 'tab_changed' ? `🔀 Tab changed`
                       : '▶ Manual'
    return `
      <div class="auto-item rp-item" data-rt-id="${esc(r.id)}">
        <div class="auto-item-icon">⚡</div>
        <div class="auto-item-body">
          <div class="auto-item-name">${esc(r.name)}</div>
          <div class="auto-item-meta">${triggerLabel} · ${r.actions?.length || 0} action(s)</div>
        </div>
        <button class="auto-del rp-run-btn" data-run-id="${esc(r.id)}" title="Run">▶</button>
        <button class="auto-del" data-rt-del="${esc(r.id)}" title="Delete" style="opacity:1">×</button>
      </div>
    `
  }).join('')

  list.querySelectorAll('.rp-run-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.textContent = '…'; btn.disabled = true
      await yantra.routines.run(btn.dataset.runId)
      btn.textContent = '▶'; btn.disabled = false
    })
  })
  list.querySelectorAll('[data-rt-del]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete routine?')) return
      await yantra.routines.remove(btn.dataset.rtDel)
      refreshRoutinesInAutoPanel()
    })
  })
}

document.querySelectorAll('.auto-tab').forEach(tab => {
  tab.addEventListener('click', () => renderAutoTab(tab.dataset.autoTab))
})

// ─── Panel: Memory ────────────────────────────────────────────────────────────

let _allMemory = []

async function renderMemoryPanel() {
  _allMemory = await yantra.memory.getAll().catch(() => [])
  renderMemoryList(_allMemory)
}

function renderMemoryList(items) {
  const list  = $('memList')
  const empty = $('memEmpty')
  if (!items.length) {
    list.innerHTML = ''
    empty.hidden = false
    return
  }
  empty.hidden = true
  const typeIcon = { research: '🔍', routine_run: '⚡', note: '📝', finding: '📌' }
  list.innerHTML = items.map(m => {
    const icon    = typeIcon[m.type] || '💾'
    const date    = (m.timestamp || '').slice(0, 10)
    const title   = esc(m.title || m.type || 'Memory')
    const snippet = esc((m.result || '').slice(0, 120))
    const urlHost = m.url ? (() => { try { return new URL(m.url).hostname } catch { return m.url } })() : ''
    return `
      <div class="mem-item" data-id="${esc(String(m.id))}">
        <div class="mem-item-header">
          <span class="mem-icon">${icon}</span>
          <div class="mem-item-info">
            <div class="mem-item-title">${title}</div>
            <div class="mem-item-meta">${date}${urlHost ? ` · <a class="mem-url" href="#" data-url="${esc(m.url)}">${esc(urlHost)}</a>` : ''}</div>
          </div>
          <button class="mem-del" data-mem-id="${esc(String(m.id))}" title="Delete">×</button>
        </div>
        ${snippet ? `<div class="mem-item-snippet">${snippet}${m.result?.length > 120 ? '…' : ''}</div>` : ''}
      </div>
    `
  }).join('')

  list.querySelectorAll('.mem-del').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation()
      await yantra.memory.delete(btn.dataset.memId)
      _allMemory = _allMemory.filter(m => String(m.id) !== btn.dataset.memId)
      renderMemoryList(filterMemory($('memSearch').value))
    })
  })
  list.querySelectorAll('.mem-url').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation()
      navigate(a.dataset.url)
    })
  })
  list.querySelectorAll('.mem-item').forEach(el => {
    el.addEventListener('click', () => {
      const m = _allMemory.find(x => String(x.id) === el.dataset.id)
      if (m) {
        closePanel()
        addCard({ id: `mem-view-${Date.now()}`, type: 'text',
          text: `## ${m.title || m.type}\n\n${m.result || ''}` })
      }
    })
  })
}

function filterMemory(q) {
  if (!q.trim()) return _allMemory
  const lq = q.toLowerCase()
  return _allMemory.filter(m => JSON.stringify(m).toLowerCase().includes(lq))
}

$('memSearch').addEventListener('input', e => renderMemoryList(filterMemory(e.target.value)))

// ─── Panel: Settings ──────────────────────────────────────────────────────────

async function loadSettingsPanel() {
  const s = await yantra.settings.get().catch(() => ({}))
  $('settingsApiKey').value    = s.apiKey            || ''
  $('settingsOpenaiKey').value = s.openaiApiKey      || ''
  $('settingsProvider').value  = s.preferredProvider || 'anthropic'
}

$('settingsSaveBtn').addEventListener('click', async () => {
  const anthropicKey = $('settingsApiKey').value.trim()
  const openaiKey    = $('settingsOpenaiKey').value.trim()
  const provider     = $('settingsProvider').value
  if (anthropicKey) await yantra.settings.set('apiKey',           anthropicKey)
  if (openaiKey)    await yantra.settings.set('openaiApiKey',     openaiKey)
  await yantra.settings.set('preferredProvider', provider)
  addActivityItem('✅', 'Settings saved')
  addCard({ id: `settings-saved-${Date.now()}`, type: 'text', text: '✓ Settings saved.' })
})

function makeKeyToggle(inputId, btnId) {
  $(btnId).addEventListener('click', () => {
    const inp  = $(inputId)
    const show = inp.type === 'password'
    inp.type   = show ? 'text' : 'password'
    $(btnId).textContent = show ? 'Hide' : 'Show'
  })
}
makeKeyToggle('settingsApiKey',    'apiKeyToggle')
makeKeyToggle('settingsOpenaiKey', 'openaiKeyToggle')

$('settingsClearMemory').addEventListener('click', async () => {
  if (!confirm('Clear all saved memory? This cannot be undone.')) return
  await yantra.memory.clear()
  addCard({ id: `cleared-mem-${Date.now()}`, type: 'text', text: 'Memory cleared.' })
})

$('settingsClearHistory').addEventListener('click', async () => {
  if (!confirm('Clear all chat history? This cannot be undone.')) return
  await yantra.sessions.clear()
  addCard({ id: `cleared-hist-${Date.now()}`, type: 'text', text: 'Chat history cleared.' })
})

// ─── Legacy settings modal (kept for keyboard shortcut compat) ────────────────
// Settings now live in the panel, but old modals are kept in DOM for compat
async function openSettingsModal() { openPanel('settings') }
function closeSettingsModal() { closePanel() }

// ─── Persona Switcher ────────────────────────────────────────────────────────

$('personaCard').addEventListener('click', openPersonaPicker)
$('personaPickerClose').addEventListener('click', () => { $('personaPickerModal').hidden = true })
$('personaPickerModal').addEventListener('click', e => {
  if (e.target === $('personaPickerModal')) $('personaPickerModal').hidden = true
})

async function openPersonaPicker() {
  const personas = await yantra.personas.list().catch(() => [])
  const list = $('personaPickerList')
  list.innerHTML = personas.map(p => {
    const isActive = activePersona?.id === p.id
    return `
      <div class="pp-item${isActive ? ' active' : ''}" data-pid="${esc(p.id)}">
        <div class="pp-avatar">${esc(p.avatar || '🤖')}</div>
        <div class="pp-meta">
          <div class="pp-name">${esc(p.name)}</div>
          <div class="pp-desc">${esc((p.description || '').slice(0, 60))}${p.description?.length > 60 ? '…' : ''}</div>
        </div>
        ${isActive ? '<span class="pp-check">✓</span>' : ''}
      </div>
    `
  }).join('')

  list.querySelectorAll('.pp-item').forEach(item => {
    item.addEventListener('click', async () => {
      activePersona = await yantra.personas.switch(item.dataset.pid)
      updatePersonaUI()
      $('personaPickerModal').hidden = true
      addCard({ id: `ps-${Date.now()}`, type: 'text',
        text: `🧠 Switched to persona **${activePersona?.name}**` })
      addActivityItem('🧠', `Switched to persona: ${activePersona?.name}`)
    })
  })

  $('personaPickerModal').hidden = false
}

// ─── Activity Feed ────────────────────────────────────────────────────────────

let _activityCount = 0

function addActivityItem(icon, text) {
  const list  = $('afList')
  const badge = $('activityBadge')

  // Remove empty state
  const empty = list.querySelector('.af-empty')
  if (empty) empty.remove()

  // Prepend item
  const item = document.createElement('div')
  item.className = 'af-item'
  item.innerHTML = `
    <div class="af-item-icon">${icon}</div>
    <div class="af-item-body">
      <div class="af-item-text">${esc(text)}</div>
      <div class="af-item-time">just now</div>
    </div>
  `
  list.prepend(item)

  // Keep max 50 items
  while (list.children.length > 50) list.removeChild(list.lastChild)

  // Badge on sidebar
  if ($('activityFeed').hidden) {
    _activityCount++
    badge.hidden = false
    badge.textContent = _activityCount > 9 ? '9+' : String(_activityCount)
  }
}

$('sbActivityToggle').addEventListener('click', () => {
  const feed = $('activityFeed')
  feed.hidden = !feed.hidden
  if (!feed.hidden) {
    _activityCount = 0
    const badge = $('activityBadge')
    badge.hidden = true
    badge.textContent = '0'
  }
})

$('afClose').addEventListener('click', () => { $('activityFeed').hidden = true })

// ─── Command Palette (Cmd+K) ──────────────────────────────────────────────────

const CMD_ITEMS = [
  { icon: '🌐', label: 'Go to Browser',     hint: 'Switch to browser view',       action: () => closePanel(), shortcut: '' },
  { icon: '⌂',  label: 'Home',              hint: 'Open command center',           action: () => openPanel('home') },
  { icon: '🤖', label: 'Agents & Personas', hint: 'Manage agents and personas',    action: () => openPanel('agents') },
  { icon: '🔒', label: 'Vault',             hint: 'View encrypted credentials',    action: () => openPanel('vault') },
  { icon: '⚡', label: 'Automation',        hint: 'Schedules, monitors, routines', action: () => openPanel('automation') },
  { icon: '📚', label: 'Memory',            hint: 'Search saved memory',           action: () => openPanel('memory') },
  { icon: '⚙',  label: 'Settings',         hint: 'Configure Yantra',              action: () => openPanel('settings') },
  { icon: '🧠', label: 'Switch Persona',    hint: 'Choose active persona',         action: () => openPersonaPicker() },
  { icon: '📄', label: 'Summarize Page',    hint: 'Ask AI to summarize current page',
    action: () => { closePanel(); sendMessage('Summarize the current page and highlight the most important information.') } },
  { icon: '🔍', label: 'Deep Research',     hint: 'Run a multi-step research task',
    action: () => { closePanel(); sendMessage('Run deep research on this topic and save findings to memory.') } },
  { icon: '+',  label: 'New Tab',           hint: 'Open a new browser tab',       action: () => api.tab.create({ type: 'browser', url: '' }) },
  { icon: '🔔', label: 'Activity Feed',     hint: 'Toggle activity log',          action: () => $('sbActivityToggle').click() },
]

let _cmdSelected = 0
let _cmdFiltered = CMD_ITEMS

function openCmdPalette() {
  $('cmdPaletteOverlay').hidden = false
  $('cmdInput').value = ''
  $('cmdInput').focus()
  _cmdSelected = 0
  renderCmdResults(CMD_ITEMS)
}

function closeCmdPalette() {
  $('cmdPaletteOverlay').hidden = true
}

function renderCmdResults(items) {
  _cmdFiltered = items
  $('cmdResults').innerHTML = items.map((item, i) => `
    <div class="cmd-item${i === _cmdSelected ? ' selected' : ''}" data-cmd-idx="${i}">
      <span class="cmd-icon">${item.icon}</span>
      <span class="cmd-label">${esc(item.label)}</span>
      <span class="cmd-hint">${esc(item.hint)}</span>
      ${item.shortcut ? `<span class="cmd-shortcut">${esc(item.shortcut)}</span>` : ''}
    </div>
  `).join('')

  $('cmdResults').querySelectorAll('.cmd-item').forEach(el => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.cmdIdx)
      if (_cmdFiltered[idx]) { closeCmdPalette(); _cmdFiltered[idx].action() }
    })
  })
}

$('cmdInput').addEventListener('input', e => {
  const q = e.target.value.toLowerCase()
  _cmdSelected = 0
  renderCmdResults(q ? CMD_ITEMS.filter(c => c.label.toLowerCase().includes(q) || c.hint.toLowerCase().includes(q)) : CMD_ITEMS)
})

$('cmdInput').addEventListener('keydown', e => {
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    _cmdSelected = Math.min(_cmdSelected + 1, _cmdFiltered.length - 1)
    renderCmdResults(_cmdFiltered)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    _cmdSelected = Math.max(_cmdSelected - 1, 0)
    renderCmdResults(_cmdFiltered)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    if (_cmdFiltered[_cmdSelected]) { closeCmdPalette(); _cmdFiltered[_cmdSelected].action() }
  } else if (e.key === 'Escape') {
    closeCmdPalette()
  }
})

$('cmdPaletteOverlay').addEventListener('click', e => {
  if (e.target === $('cmdPaletteOverlay')) closeCmdPalette()
})

// Global keyboard shortcut
document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault()
    if ($('cmdPaletteOverlay').hidden) openCmdPalette()
    else closeCmdPalette()
  }
})

// ─── New-tab page ─────────────────────────────────────────────────────────────

function handleNewTabInput(text) {
  text = text.trim()
  if (!text) return
  const isURL = text.startsWith('http') || text.startsWith('www.') || /^[\w-]+\.[a-z]{2,}(\/|$)/i.test(text)
  if (isURL) {
    navigate(text)
  } else {
    hideNewTabPage()
    $('aiOverlay').style.display = 'flex'
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

document.querySelectorAll('.nt-chip').forEach(btn => {
  btn.addEventListener('click', () => {
    const msg = btn.dataset.msg
    if (msg) {
      hideNewTabPage()
      $('aiOverlay').style.display = 'flex'
      scheduleBoundsUpdate()
      sendMessage(msg)
    }
  })
})

function hideNewTabPage() { $('newTabPage').classList.add('hidden') }
function showNewTabPage()  { $('newTabPage').classList.remove('hidden'); $('ntSearch').focus() }

// ─── Agent picker ─────────────────────────────────────────────────────────────

const agentSel    = $('agentSel')
const agentPicker = $('agentPicker')

agentSel?.addEventListener('click', async (e) => {
  e.stopPropagation()
  if (!agentPicker.hidden) { agentPicker.hidden = true; return }

  const agents = await yantra.agents.list()
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
      await yantra.agents.setActive(el.dataset.id)
      activeAgent = await yantra.agents.getActive()
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

// ─── Routines (legacy panel, still accessible) ────────────────────────────────

const ROUTINE_TOOLS = [
  { name: 'get_current_page',  label: 'Read current page',  params: [] },
  { name: 'web_search',        label: 'Web search',         params: [{ key: 'query', label: 'Query', type: 'text' }] },
  { name: 'fetch_webpage',     label: 'Fetch webpage',      params: [{ key: 'url',   label: 'URL',   type: 'text' }] },
  { name: 'extractTable',      label: 'Extract tables',     params: [] },
  { name: 'extractEntities',   label: 'Extract entities',   params: [] },
  { name: 'captureScreenshot', label: 'Screenshot',         params: [] },
  { name: 'getPageStructure',  label: 'Map page elements',  params: [] },
  { name: 'save_note',         label: 'Save note',          params: [{ key: 'filename', label: 'Filename', type: 'text' }] },
  { name: 'saveFinding',       label: 'Save finding',       params: [{ key: 'title',    label: 'Title',    type: 'text' }] },
  { name: 'generateReport',    label: 'Generate report',    params: [{ key: 'title',    label: 'Title',    type: 'text' }, { key: 'content', label: 'Content template', type: 'textarea' }] },
  { name: 'exportCSV',         label: 'Export CSV',         params: [{ key: 'filename', label: 'Filename', type: 'text' }] },
  { name: 'exportPDF',         label: 'Export PDF',         params: [{ key: 'filename', label: 'Filename', type: 'text' }] },
]

let _editingRoutineId = null

async function openRoutinesPanel() {
  api.browser.hide()
  $('rpOverlay').hidden = false
  await refreshRoutinesList()
}

function closeRoutinesPanel() { $('rpOverlay').hidden = true; api.browser.show() }

async function refreshRoutinesList() {
  const routines = await yantra.routines.list()
  const list  = $('rpList')
  const empty = $('rpEmpty')

  if (!routines.length) { list.innerHTML = ''; empty.hidden = false; return }
  empty.hidden = true
  list.innerHTML = routines.map(r => {
    const triggerLabel = r.trigger?.type === 'page_load'   ? `🔗 Page load${r.trigger.urlPattern ? ` · ${r.trigger.urlPattern}` : ''}`
                       : r.trigger?.type === 'tab_changed' ? `🔀 Tab changed` : '▶ Manual'
    return `
      <div class="rp-item" data-id="${esc(r.id)}">
        <div class="rp-item-main">
          <label class="rp-toggle" title="${r.enabled ? 'Enabled' : 'Disabled'}">
            <input type="checkbox" class="rp-toggle-cb" data-id="${esc(r.id)}" ${r.enabled ? 'checked' : ''}>
            <span class="rp-toggle-track"></span>
          </label>
          <div class="rp-item-info">
            <div class="rp-item-name">${esc(r.name)}</div>
            <div class="rp-item-meta">${triggerLabel} · ${r.actions?.length || 0} action${r.actions?.length !== 1 ? 's' : ''}</div>
          </div>
          <div class="rp-item-actions">
            <button class="rp-run-btn"  data-id="${esc(r.id)}" title="Run now">▶</button>
            <button class="rp-edit-btn" data-id="${esc(r.id)}" title="Edit">✎</button>
            <button class="rp-del-btn"  data-id="${esc(r.id)}" title="Delete">×</button>
          </div>
        </div>
      </div>
    `
  }).join('')

  list.querySelectorAll('.rp-toggle-cb').forEach(cb => {
    cb.addEventListener('change', async () => await yantra.routines.update(cb.dataset.id, { enabled: cb.checked }))
  })
  list.querySelectorAll('.rp-run-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.textContent = '…'; btn.disabled = true
      await yantra.routines.run(btn.dataset.id)
      btn.textContent = '▶'; btn.disabled = false
    })
  })
  list.querySelectorAll('.rp-edit-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const routines = await yantra.routines.list()
      const routine  = routines.find(r => r.id === btn.dataset.id)
      if (routine) openRoutineModal(routine)
    })
  })
  list.querySelectorAll('.rp-del-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete routine?')) return
      await yantra.routines.remove(btn.dataset.id)
      await refreshRoutinesList()
    })
  })
}

function openRoutineModal(routine) {
  _editingRoutineId = routine?.id || null
  $('routineModalTitle').textContent = routine ? 'Edit Routine' : 'New Routine'
  $('rtName').value       = routine?.name || ''
  $('rtTrigger').value    = routine?.trigger?.type || 'manual'
  $('rtUrlPattern').value = routine?.trigger?.urlPattern || ''
  $('rtActionsList').innerHTML = ''
  updateUrlPatternVisibility()
  const actions = routine?.actions || []
  if (actions.length) actions.forEach(a => addActionRow(a.tool, a.params))
  else addActionRow()
  $('routineModal').hidden = false
}

function closeRoutineModal() { $('routineModal').hidden = true }

function updateUrlPatternVisibility() {
  const t = $('rtTrigger').value
  $('rtUrlPatternWrap').style.display = t !== 'manual' ? '' : 'none'
}

$('rtTrigger').addEventListener('change', updateUrlPatternVisibility)

function buildToolOptions(selected) {
  return ROUTINE_TOOLS.map(t => `<option value="${esc(t.name)}"${t.name === selected ? ' selected' : ''}>${esc(t.label)}</option>`).join('')
}

function buildParamFields(toolName, existingParams = {}) {
  const def = ROUTINE_TOOLS.find(t => t.name === toolName)
  if (!def || !def.params.length) return '<div class="rt-no-params">No parameters needed</div>'
  return def.params.map(p => `
    <div class="rt-param-row">
      <label class="rt-param-label">${esc(p.label)}</label>
      ${p.type === 'textarea'
        ? `<textarea class="field-input rt-param-val" data-key="${esc(p.key)}" rows="2">${esc(existingParams[p.key] || '')}</textarea>`
        : `<input class="field-input rt-param-val" data-key="${esc(p.key)}" type="text" value="${esc(existingParams[p.key] || '')}">`
      }
    </div>
  `).join('')
}

function addActionRow(toolName, existingParams = {}) {
  const defaultTool = toolName || ROUTINE_TOOLS[0].name
  const row = document.createElement('div')
  row.className = 'rt-action-row'
  row.innerHTML = `
    <div class="rt-action-top">
      <select class="field-select rt-tool-select">${buildToolOptions(defaultTool)}</select>
      <button class="rt-action-del-btn" title="Remove">×</button>
    </div>
    <div class="rt-action-params">${buildParamFields(defaultTool, existingParams)}</div>
  `
  row.querySelector('.rt-tool-select').addEventListener('change', e => {
    row.querySelector('.rt-action-params').innerHTML = buildParamFields(e.target.value, {})
  })
  row.querySelector('.rt-action-del-btn').addEventListener('click', () => row.remove())
  $('rtActionsList').appendChild(row)
}

function collectActions() {
  return Array.from($('rtActionsList').querySelectorAll('.rt-action-row')).map(row => {
    const tool   = row.querySelector('.rt-tool-select').value
    const params = {}
    row.querySelectorAll('.rt-param-val').forEach(inp => {
      if (inp.value.trim()) params[inp.dataset.key] = inp.value.trim()
    })
    return { tool, params }
  })
}

$('rtAddAction').addEventListener('click', () => addActionRow())
$('routineModalClose').addEventListener('click',  closeRoutineModal)
$('routineModalCancel').addEventListener('click', closeRoutineModal)
$('routineModal').addEventListener('click', e => { if (e.target === $('routineModal')) closeRoutineModal() })

$('routineModalSave').addEventListener('click', async () => {
  const name = $('rtName').value.trim()
  if (!name) { $('rtName').focus(); return }
  const cfg = {
    name,
    trigger: {
      type: $('rtTrigger').value,
      ...($('rtTrigger').value !== 'manual' && $('rtUrlPattern').value.trim()
        ? { urlPattern: $('rtUrlPattern').value.trim() } : {}),
    },
    actions: collectActions(),
  }
  if (_editingRoutineId) await yantra.routines.update(_editingRoutineId, cfg)
  else await yantra.routines.create(cfg)
  closeRoutineModal()
  await refreshRoutinesList()
  addCard({ id: `rt-saved-${Date.now()}`, type: 'text',
    text: `${_editingRoutineId ? 'Updated' : 'Created'} routine **${name}**` })
})

$('rpNewBtn').addEventListener('click',   () => openRoutineModal())
$('rpEmptyNew').addEventListener('click', () => openRoutineModal())
$('rpCloseBtn').addEventListener('click', closeRoutinesPanel)
$('rpOverlay').addEventListener('click',  e => { if (e.target === $('rpOverlay')) closeRoutinesPanel() })

// ─── Agent creation modal ─────────────────────────────────────────────────────

const agentModal = $('agentModal')

function openAgentModal() {
  api.browser.hide()
  $('agentAvatar').value      = '🤖'
  $('agentName').value        = ''
  $('agentDesc').value        = ''
  $('agentPrompt').value      = ''
  $('agentMemory').value      = 'global'
  $('agentAutoContext').checked = true
  agentModal.hidden = false
}

function closeAgentModal() { agentModal.hidden = true; api.browser.show() }

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
  const created = await yantra.agents.create(cfg)
  closeAgentModal()
  await yantra.agents.setActive(created.id)
  activeAgent = await yantra.agents.getActive()
  updateAgentUI()
  addCard({ id: `created-${Date.now()}`, type: 'text',
    text: `Created and activated **${created.name}** ${created.avatar}` })
})

// ─── URL bar focus shortcut ───────────────────────────────────────────────────

api.on.focusUrlBar(() => {
  const input = $('urlInput')
  if (input.dataset.realUrl) input.value = input.dataset.realUrl
  input.focus(); input.select()
})

// ─── Find in page ─────────────────────────────────────────────────────────────

const findBar   = $('findBar')
const findInput = $('findInput')
const findCount = $('findCount')

function openFindBar()  { findBar.hidden = false; findInput.focus(); findInput.select(); scheduleBoundsUpdate() }
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
  closePanel()
  $('aiOverlay').style.display = 'flex'
  scheduleBoundsUpdate()
  sendMessage(msg)
})

// ─── BrowserView bounds ───────────────────────────────────────────────────────

let boundsTimer = null
function scheduleBoundsUpdate() {
  clearTimeout(boundsTimer)
  boundsTimer = setTimeout(updateBrowserViewBounds, 80)  // was 30ms, now 80ms
}

function updateBrowserViewBounds() {
  const sidebar  = $('sidebar')
  const navRow   = $('navRow')
  const overlay  = $('aiOverlay')
  const tabStrip = $('tabStrip')
  const ctxBar   = $('contextBar')

  const sidebarW = sidebar.offsetWidth
  const topY     = tabStrip.offsetHeight + navRow.offsetHeight + (ctxBar.hidden ? 0 : ctxBar.offsetHeight)
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

    case 'plan':
      // Plans are shown only in the activity feed, not the main chat
      return ''

    case 'thinking': {
      const doneSteps = (item.steps || []).map(s =>
        `<div class="working-step">✓ ${esc(s)}</div>`
      ).join('')
      return `<div class="card-working">
        ${doneSteps ? `<div class="working-history">${doneSteps}</div>` : ''}
        <div class="working-current">
          <div class="thinking-dots"><span></span><span></span><span></span></div>
          <span class="working-label">${esc(item.label || 'Working…')}</span>
        </div>
      </div>`
    }

    case 'screenshot':
      return `<div class="card" style="padding:8px"><img class="card-screenshot" src="${esc(item.src)}" alt="Screenshot"></div>`

    case 'tool_call':
      // Legacy — not shown in chat; activity feed handles this
      return ''

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
  $('aiOverlay').style.display = 'flex'
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

function _removeWorkingCard() {
  if (!_workingCardId) return
  const c = convo()
  c.items = c.items.filter(i => i.id !== _workingCardId)
  const el = document.getElementById(`card-${_workingCardId}`)
  if (el) el.remove()
  _workingCardId = null
}

function handleAgentEvent(ev) {
  if (ev.sessionId !== activeTabId) return

  switch (ev.type) {
    case 'plan':
      // Silently log to activity feed; don't clutter the chat
      addActivityItem('🎯', `Plan: ${ev.title || 'Multi-step'}`)
      break

    case 'tool_call': {
      curTextId = null
      const _label = ev.toolName === 'web_search'        ? `Searching: "${(ev.toolInput?.query || '').slice(0, 50)}"`
                   : ev.toolName === 'fetch_webpage'     ? `Reading: ${(ev.toolInput?.url || '').replace(/^https?:\/\/(www\.)?/, '').slice(0, 50)}`
                   : ev.toolName === 'get_current_page'  ? 'Reading current page…'
                   : ev.toolName === 'clickElement'      ? `Clicking: "${(ev.toolInput?.text || ev.toolInput?.selector || '').slice(0, 40)}"`
                   : ev.toolName === 'typeInField'       ? `Typing into field…`
                   : ev.toolName === 'scrollPage'        ? 'Scrolling page…'
                   : ev.toolName === 'captureScreenshot' ? 'Taking screenshot…'
                   : ev.toolName === 'cogitate'          ? 'Thinking deeply…'
                   : ev.toolName === 'extractTable'      ? 'Extracting table data…'
                   : ev.toolName === 'extractEntities'   ? 'Extracting information…'
                   : ev.toolName === 'save_note'         ? 'Saving note…'
                   : ev.toolName === 'saveFinding'       ? 'Saving finding…'
                   : ev.toolName === 'generateReport'    ? 'Generating report…'
                   : ev.toolName === 'scheduleTask'      ? `Scheduling: ${ev.toolInput?.name || ''}`
                   : ev.toolName === 'watchPage'         ? `Setting up monitor…`
                   : `${ev.toolName}…`
      if (!_workingCardId) {
        const item = { id: `thinking-${Date.now()}`, type: 'thinking', label: _label, steps: [] }
        _workingCardId = item.id
        addCard(item)
      } else {
        const item = convo().items.find(i => i.id === _workingCardId)
        if (item) {
          if (item.label) item.steps = [...(item.steps || []), item.label].slice(-4)
          item.label = _label
          patchCard(_workingCardId)
          scrollThread()
        }
      }
      toolMap[ev.toolId] = _workingCardId
      addActivityItem(
        ev.toolName === 'web_search' ? '🔍' : ev.toolName === 'captureScreenshot' ? '📸' : '⚙️',
        _label
      )
      break
    }

    case 'tool_result': {
      // Screenshots shown inline; everything else stays silent
      if (ev.result && ev.result.startsWith('data:image/')) {
        _removeWorkingCard()
        addCard({ id: `ss-${Date.now()}`, type: 'screenshot', src: ev.result })
      }
      break
    }

    case 'text': {
      // First text chunk: remove thinking indicator
      _removeWorkingCard()
      if (curTextId) {
        const item = convo().items.find(i => i.id === curTextId)
        if (item) {
          item.text = ev.text
          if (!_pendingTextRender) {
            _pendingTextRender = true
            requestAnimationFrame(() => {
              patchCard(curTextId)
              scrollThread()
              _pendingTextRender = false
            })
          }
          break
        }
      }
      const item = { id: `txt-${Date.now()}`, type: 'text', text: ev.text }
      curTextId = item.id
      addCard(item)
      break
    }

    case 'error':
      _removeWorkingCard()
      addCard({ id: `err-${Date.now()}`, type: 'error', text: ev.text })
      addActivityItem('⚠️', `Error: ${ev.text.slice(0, 60)}`)
      finishRun(); break

    case 'done':
      _removeWorkingCard()
      curTextId = null
      addCard({ id: `fb-${Date.now()}`, type: 'feedback' })
      finishRun(); break
  }
}

function finishRun() {
  isRunning = false
  _workingCardId = null
  $('aiSend').disabled  = false
  $('aiInput').disabled = false
  $('aiInput').focus()
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
  addActivityItem('💬', `Agent: ${text.slice(0, 50)}`)
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
  t = t.replace(/\*\*/g, '')                                   // strip orphaned ** (truncated text)
  t = t.replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
  t = t.replace(/^#{1,6} (.+)$/gm, '<strong>$1</strong>')
  t = t.replace(/^[-•*] (.+)$/gm, '<li>$1</li>')
  t = t.replace(/(<li>[\s\S]*?<\/li>)/g, '<ul>$1</ul>')
  t = t.replace(/(https?:\/\/[^\s<"]+)/g, '<a href="#" onclick="return false" title="$1">$1</a>')
  t = t.replace(/\n\n/g, '<br><br>')
  t = t.replace(/\n/g, '<br>')
  return t
}
