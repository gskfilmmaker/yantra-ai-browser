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

// ── Per-session conversation history (server-side) ───────────────────────────
const sessionHistory = new Map()

const SESSIONS_FILE = path.join(os.homedir(), '.strawberry', 'sessions.json')

function loadSessions() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'))
      for (const [id, msgs] of Object.entries(data)) sessionHistory.set(id, msgs)
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

      // 6. Run the streaming agent loop
      const priorHistory = sessionHistory.get(sessionId) || []
      const finalMessages = await llmClient.runAgentLoop({
        event,
        sessionId,
        message:      fullMessage,
        history:      priorHistory,
        systemPrompt: ctx.systemPrompt,
        tools,
      })

      // 6. Persist conversation
      sessionHistory.set(sessionId, finalMessages)
      saveSessions()

      // 7. Auto-save research result to memory
      const lastAsst = [...finalMessages].reverse().find(m => m.role === 'assistant')
      const lastText = Array.isArray(lastAsst?.content)
        ? (lastAsst.content.find(b => b.type === 'text')?.text || '')
        : ''
      if (lastText) {
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
}

module.exports = { register }
