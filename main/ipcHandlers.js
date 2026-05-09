'use strict'
const { ipcMain } = require('electron')
const fs   = require('fs')
const path = require('path')
const os   = require('os')

const tabManager     = require('./tabManager')
const memoryStore    = require('./memoryStore')
const agentManager   = require('./agents/agentManager')
const contextEngine  = require('./ai/contextEngine')
const llmClient      = require('./ai/llmClient')
const planner        = require('./ai/planner')
const registry       = require('./tools/registry')
const routineManager = require('./routines/routineManager')
const appSettings    = require('./settings')

// ── Eager-load all tool modules so they register themselves ──────────────────
require('./tools/browserTools')
require('./tools/contentTools')
require('./tools/memoryTools')
require('./tools/routineTools')
require('./tools/extractionTools')
require('./tools/documentTools')
require('./tools/automationTools')
require('./tools/orchestratorTools')
require('./tools/orchestrationTools')
require('./tools/cognitiveTools')
require('./tools/vaultTools')
require('./tools/autonomyTools')
require('./tools/personaTools')

// ── Per-session conversation history (server-side) ───────────────────────────
const sessionHistory = new Map()

const SESSIONS_FILE = path.join(os.homedir(), '.yantra', 'sessions.json')

function _isValidHistory(msgs) {
  if (!Array.isArray(msgs)) return false
  // Reject sessions that contain OpenAI-format role:system messages
  if (msgs.some(m => m.role === 'system')) return false
  // Reject sessions where assistant only said trivial things like "Switched to agent"
  const asstMsgs = msgs.filter(m => m.role === 'assistant')
  if (asstMsgs.length && asstMsgs.every(m => {
    const text = typeof m.content === 'string' ? m.content
      : Array.isArray(m.content) ? (m.content.find(b => b.type === 'text')?.text || '') : ''
    return /^switched to (agent|persona)/i.test(text.trim()) || text.trim().length < 10
  })) return false
  return true
}

function loadSessions() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'))
      for (const [id, msgs] of Object.entries(data)) {
        if (_isValidHistory(msgs)) sessionHistory.set(id, msgs)
      }
    }
  } catch { /* ignore */ }
}

function saveSessions() {
  try {
    const data = {}
    for (const [id, msgs] of sessionHistory) data[id] = msgs.slice(-60)
    fs.mkdirSync(path.dirname(SESSIONS_FILE), { recursive: true })
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data), 'utf8')
  } catch { /* ignore */ }
}

loadSessions()

// ── Register all IPC handlers ────────────────────────────────────────────────

function register() {

  // ── Tab management ──────────────────────────────────────────────────────────
  ipcMain.handle('tab:create',  (_, opts) => tabManager.createTab(opts || {}))
  ipcMain.handle('tab:switch',  (_, id)   => tabManager.switchTo(id))
  ipcMain.handle('tab:close',   (_, id)   => tabManager.closeTab(id))
  ipcMain.handle('tab:getAll',  ()        => tabManager.getAllTabInfo())

  // ── Browser navigation ──────────────────────────────────────────────────────
  ipcMain.handle('browser:navigate',      (_, url)        => tabManager.navigate(url))
  ipcMain.handle('browser:goBack',        ()              => tabManager.goBack())
  ipcMain.handle('browser:goForward',     ()              => tabManager.goForward())
  ipcMain.handle('browser:reload',        ()              => tabManager.reload())
  ipcMain.handle('browser:getContent',    (_, id)         => tabManager.getPageContent(id))
  ipcMain.handle('browser:getAllContent', ()              => tabManager.getAllTabsContent())
  ipcMain.handle('browser:setBounds',     (_, bounds)     => tabManager.setBrowserBounds(bounds))
  ipcMain.handle('browser:hide',          ()              => tabManager.hideBrowserView())
  ipcMain.handle('browser:show',          ()              => tabManager.showBrowserView())
  ipcMain.handle('browser:findInPage',    (_, text, opts) => tabManager.findInPage(text, opts))
  ipcMain.handle('browser:stopFindInPage',()              => tabManager.stopFindInPage())

  // ── Memory ──────────────────────────────────────────────────────────────────
  ipcMain.handle('memory:save',       (_, e)  => memoryStore.save(e))
  ipcMain.handle('memory:getHistory', (_, n)  => memoryStore.getHistory(n))
  ipcMain.handle('memory:getAll',     ()      => memoryStore.getAll())
  ipcMain.handle('memory:delete',     (_, id) => memoryStore.deleteEntry(id))
  ipcMain.handle('memory:search',     (_, q)  => memoryStore.search(q))

  // ── Agent CRUD ──────────────────────────────────────────────────────────────
  ipcMain.handle('agent:list',      ()        => agentManager.listAgents())
  ipcMain.handle('agent:getActive', ()        => agentManager.getActiveAgent())
  ipcMain.handle('agent:setActive', (_, id)   => agentManager.setActiveAgent(id))
  ipcMain.handle('agent:create',    (_, cfg)  => agentManager.createAgent(cfg))
  ipcMain.handle('agent:update',    (_, id, p)=> agentManager.updateAgent(id, p))
  ipcMain.handle('agent:delete',    (_, id)   => agentManager.deleteAgent(id))

  // ── Routine CRUD ────────────────────────────────────────────────────────────
  ipcMain.handle('routine:list',   ()         => routineManager.listRoutines())
  ipcMain.handle('routine:create', (_, cfg)   => routineManager.createRoutine(cfg))
  ipcMain.handle('routine:update', (_, id, p) => routineManager.updateRoutine(id, p))
  ipcMain.handle('routine:delete', (_, id)    => routineManager.deleteRoutine(id))
  ipcMain.handle('routine:run',    (_, id)    => routineManager.runRoutine(id))

  // ── Settings ─────────────────────────────────────────────────────────────────
  ipcMain.handle('settings:get', ()        => appSettings.getAll())
  ipcMain.handle('settings:set', (_, k, v) => {
    appSettings.set(k, v)
    if (k === 'apiKey'            && v) process.env.ANTHROPIC_API_KEY  = v
    if (k === 'openaiApiKey'      && v) process.env.OPENAI_API_KEY     = v
    if (k === 'preferredProvider'     ) process.env.PREFERRED_PROVIDER  = v || 'anthropic'
  })

  // ── Data management ──────────────────────────────────────────────────────────
  ipcMain.handle('memory:clear', () => {
    const file = path.join(os.homedir(), '.strawberry', 'memory.json')
    try { fs.writeFileSync(file, '[]') } catch { /* ignore */ }
  })
  ipcMain.handle('sessions:clear', () => {
    sessionHistory.clear()
    saveSessions()
  })

  // ── Agent run ───────────────────────────────────────────────────────────────
  ipcMain.handle('agent:run', async (event, { message, sessionId }) => {
    if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
      event.sender.send('agent-event', { sessionId, type: 'error', text: 'Add an API key in Settings (⚙).' })
      event.sender.send('agent-event', { sessionId, type: 'done' })
      return
    }

    try {
      // 1. Get active agent
      const agent = agentManager.getActiveAgent()

      // 2. Run planner + build context concurrently
      const [plan, ctx] = await Promise.all([
        planner.classify(message).catch(() => ({ type: 'simple' })),
        contextEngine.buildContext({ agent, userPrompt: message, sessionId }),
      ])

      // 3. If multi-step plan, emit it to the renderer as a plan card
      if (plan.type === 'multi_step' && plan.steps?.length) {
        event.sender.send('agent-event', {
          sessionId, type: 'plan',
          title: plan.title, steps: plan.steps,
        })
      }

      // 4. Combine context prefix with user message (+ plan guidance if multi-step)
      let fullMessage = ctx.contextPrefix
        ? `${ctx.contextPrefix}\n\n---\n\nUSER REQUEST:\n${message}`
        : message

      if (plan.type === 'multi_step' && plan.steps?.length) {
        fullMessage += `\n\n---\n\nPLAN TO FOLLOW:\n${plan.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\nExecute these steps systematically.`
      }

      // 5. Get tool schemas filtered to this agent's permissions
      const tools = registry.schemasForAgent(agent.tools)

      // 6. Inject active persona system prompt if one is set
      let systemPrompt = ctx.systemPrompt
      try {
        const activePersonaId = appSettings.get('activePersonaId')
        if (activePersonaId) {
          const personaEngine = require('./agents/personaEngine')
          const personaPrompt = personaEngine.buildSystemPrompt(activePersonaId)
          if (personaPrompt) systemPrompt = `${systemPrompt}\n\n---\n\n${personaPrompt}`
        }
      } catch { /* non-fatal */ }

      // 7. Run the streaming agent loop — 5 min timeout for complex automations
      const priorHistory = sessionHistory.get(sessionId) || []
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Request timed out after 5 minutes')), 300_000))
      const finalMessages = await Promise.race([timeout, llmClient.runAgentLoop({
        event,
        sessionId,
        message:      fullMessage,
        history:      priorHistory,
        systemPrompt,
        tools,
      })])

      // 8. Persist conversation
      sessionHistory.set(sessionId, finalMessages)
      saveSessions()

      // 9. Auto-save research result to memory (skip trivial/corrupted responses)
      const lastAsst = [...finalMessages].reverse().find(m => m.role === 'assistant')
      const lastText = Array.isArray(lastAsst?.content)
        ? (lastAsst.content.find(b => b.type === 'text')?.text || '')
        : (typeof lastAsst?.content === 'string' ? lastAsst.content : '')
      const isTrivial = lastText.trim().length < 80 ||
        /^switched to (agent|persona)/i.test(lastText.trim())
      if (lastText && !isTrivial) {
        const tab = tabManager.getActiveTab()
        memoryStore.save({
          type:    'research',
          title:   message.slice(0, 80),
          result:  lastText.slice(0, 600),
          url:     tab?.url   || '',
          title2:  tab?.title || '',
          agentId: agent.id,
        })
      }

    } catch (e) {
      event.sender.send('agent-event', { sessionId, type: 'error', text: `Error: ${e.message}` })
    }

    event.sender.send('agent-event', { sessionId, type: 'done' })
  })

  // ── Vault ──────────────────────────────────────────────────────────────────
  const vault = require('./vault/credentialVault')
  ipcMain.handle('vault:list',   ()          => vault.list())
  ipcMain.handle('vault:get',    (_, site)   => vault.get(site))
  ipcMain.handle('vault:save',   (_, data)   => vault.save(data.site, data.username, data.password, data.notes))
  ipcMain.handle('vault:remove', (_, id)     => vault.remove(id))

  // ── Personas ───────────────────────────────────────────────────────────────
  const personaEngine = require('./agents/personaEngine')
  ipcMain.handle('persona:list',      ()           => personaEngine.list())
  ipcMain.handle('persona:getActive', ()           => {
    const id = appSettings.get('activePersonaId')
    return id ? personaEngine.get(id) : personaEngine.get('genius-gsk')
  })
  ipcMain.handle('persona:switch',    (_, nameOrId) => {
    const p = personaEngine.get(nameOrId)
    if (p) appSettings.set('activePersonaId', p.id)
    return p
  })
  ipcMain.handle('persona:teach',     (_, { nameOrId, insight }) => {
    const p = personaEngine.get(nameOrId)
    if (p) personaEngine.learn(p.id, insight)
    return !!p
  })
  ipcMain.handle('persona:insights',  (_, nameOrId) => personaEngine.getInsights(nameOrId))
  ipcMain.handle('persona:create',    (_, cfg)      => {
    const id = personaEngine.create(cfg)
    return personaEngine.get(id)
  })

  // ── Autonomy ───────────────────────────────────────────────────────────────
  ipcMain.handle('autonomy:listSchedules',  ()   => {
    try { const { scheduler } = require('./autonomy/autonomyEngine'); return scheduler.list() } catch { return [] }
  })
  ipcMain.handle('autonomy:listMonitors',   ()   => {
    try { const { conditionMonitor } = require('./autonomy/autonomyEngine'); return conditionMonitor.list() } catch { return [] }
  })
  ipcMain.handle('autonomy:cancelSchedule', (_, id) => {
    try { const { scheduler } = require('./autonomy/autonomyEngine'); return scheduler.cancel(id) } catch { return false }
  })
  ipcMain.handle('autonomy:cancelMonitor',  (_, id) => {
    try { const { conditionMonitor } = require('./autonomy/autonomyEngine'); return conditionMonitor.cancel(id) } catch { return false }
  })
}

module.exports = { register }
