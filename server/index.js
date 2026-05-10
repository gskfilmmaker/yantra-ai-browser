'use strict'
/**
 * Yantra headless agent server — Express/SSE backend.
 *
 * Routes:
 *   POST /api/agent/run               — start agent run, returns { sessionId }
 *   GET  /api/agent/stream/:sessionId — SSE stream of agent events
 *   POST /api/agent/cancel/:sessionId — cancel a running session
 *   POST /api/agent/interrupt/:sessionId — inject mid-task correction
 *   GET  /api/sessions                — list recent sessions
 *   GET  /api/sessions/incomplete     — list incomplete sessions
 *   GET  /api/browser/state           — current browser URL + title for a session
 *   GET  /api/health                  — health check
 */

const express  = require('express')
const cors     = require('cors')
const path     = require('path')
const crypto   = require('crypto')
const db       = require('./db')
const { runAgentLoop } = require('./agent')
const registry = require('./tools/registry')

// Register all tools (side-effect: populates the registry)
require('./tools/browserTools')
require('./tools/searchTools')
require('./tools/memoryTools')

const { getBrowserState, closeBrowser } = require('./tools/browserTools')

const app = express()
app.use(cors())
app.use(express.json({ limit: '4mb' }))
app.use(express.static(path.join(__dirname, 'public')))

// ── In-memory session state ────────────────────────────────────────────────────
// sessionId → { sseClients: Set<res>, messages: [], goal: string, cancelled: bool, interrupt: string|null }
const sessions   = new Map()
const SYSTEM_PROMPT = `You are Yantra, an intelligent web agent running on a headless cloud server.
You have access to a real Chromium browser (via Playwright) and can navigate, interact with, and extract information from any webpage.

Your capabilities:
- Navigate to URLs and interact with web pages (navigate_to, get_current_page, click_element, type_in_field, scroll_page, capture_screenshot, wait_for_element, get_page_structure)
- Search the web using DuckDuckGo — no API key required (web_search)
- Fetch and read webpage content (fetch_webpage)
- Save notes and findings to persistent SQLite memory (save_note, get_recent_notes, search_memory)

Guidelines:
- Use get_page_structure before clicking to find correct selectors
- Use web_search for finding information; use navigate_to for specific URLs
- Take a screenshot after major actions to verify the result
- Save important findings with save_note
- For sensitive or irreversible actions, describe what you are about to do first
- Be methodical: observe → plan → act → verify`

// ── SSE helpers ────────────────────────────────────────────────────────────────

function initSSE(res) {
  res.setHeader('Content-Type',  'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection',    'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()
  // Keep-alive heartbeat every 15 s to prevent proxy / load-balancer timeouts
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': heartbeat\n\n')
  }, 15000)
  res.on('close', () => clearInterval(heartbeat))
}

function emit(sessionId, type, data) {
  const s = sessions.get(sessionId)
  if (!s) return
  const payload = JSON.stringify({ type, ...data })
  for (const res of s.sseClients) {
    try { res.write(`data: ${payload}\n\n`) } catch { s.sseClients.delete(res) }
  }
}

// ── Routes ─────────────────────────────────────────────────────────────────────

// Health check
app.get('/api/health', (_req, res) => {
  res.json({
    ok:       true,
    version:  '1.0.0',
    sessions: sessions.size,
    tools:    registry.list().map(t => t.name),
    uptime:   process.uptime(),
    time:     new Date().toISOString(),
  })
})

// Start an agent run
app.post('/api/agent/run', async (req, res) => {
  const { message, history = [], systemPrompt } = req.body
  if (!message) return res.status(400).json({ error: 'message is required' })

  const sessionId = crypto.randomUUID()
  const session   = { sseClients: new Set(), messages: Array.isArray(history) ? history : [], goal: message, cancelled: false, interrupt: null }
  sessions.set(sessionId, session)

  // Persist initial record
  db.saveSession(sessionId, message, session.messages, null)

  const tools = registry.schemasForAgent(null)

  // Run agent asynchronously — SSE client connects separately via /stream
  setImmediate(async () => {
    try {
      const finalMessages = await runAgentLoop({
        sessionId,
        message,
        history:      session.messages.slice(),
        systemPrompt: systemPrompt || SYSTEM_PROMPT,
        tools,
        emitEvent:    (type, data) => emit(sessionId, type, data),
        isCancelled:  () => session.cancelled,
        getInterrupt: () => {
          const v = session.interrupt
          session.interrupt = null
          return v
        },
        onCheckpoint: (msgs) => {
          session.messages = msgs
          db.saveSession(sessionId, session.goal, msgs, null)
        },
      })
      session.messages = finalMessages
      db.saveSession(sessionId, session.goal, finalMessages, Date.now())
    } catch (e) {
      console.error(`[session ${sessionId}] Error:`, e.message)
      emit(sessionId, 'error', { message: e.message || String(e) })
    }
    emit(sessionId, 'done', { sessionId })
    // Clean up in-memory state after a delay (allow SSE clients to receive done)
    setTimeout(() => sessions.delete(sessionId), 30000)
  })

  res.json({ sessionId })
})

// SSE stream for a session
app.get('/api/agent/stream/:sessionId', (req, res) => {
  const { sessionId } = req.params
  // Create a placeholder session entry if agent run hasn't started yet
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, { sseClients: new Set(), messages: [], goal: '', cancelled: false, interrupt: null })
  }
  initSSE(res)
  sessions.get(sessionId).sseClients.add(res)
  req.on('close', () => sessions.get(sessionId)?.sseClients.delete(res))

  // If this session is already completed, tell the client
  const dbRecord = db.getSession(sessionId)
  if (dbRecord && dbRecord.completed_at) {
    res.write(`data: ${JSON.stringify({ type: 'done', sessionId, replay: true })}\n\n`)
  }
})

// Cancel a running session
app.post('/api/agent/cancel/:sessionId', (req, res) => {
  const { sessionId } = req.params
  const session = sessions.get(sessionId)
  if (!session) return res.status(404).json({ error: 'Session not found or already completed' })
  session.cancelled = true
  res.json({ ok: true, sessionId })
})

// Inject a mid-task correction
app.post('/api/agent/interrupt/:sessionId', (req, res) => {
  const { sessionId } = req.params
  const { message }   = req.body
  if (!message) return res.status(400).json({ error: 'message is required' })
  const session = sessions.get(sessionId)
  if (!session) return res.status(404).json({ error: 'Session not found or already completed' })
  session.interrupt = message
  res.json({ ok: true, sessionId })
})

// List recent sessions
app.get('/api/sessions', (req, res) => {
  const n = Math.min(parseInt(req.query.limit) || 20, 100)
  res.json(db.listRecent(n))
})

// List incomplete sessions
app.get('/api/sessions/incomplete', (_req, res) => {
  res.json(db.getIncomplete())
})

// Get session detail
app.get('/api/sessions/:sessionId', (req, res) => {
  const record = db.getSession(req.params.sessionId)
  if (!record) return res.status(404).json({ error: 'Session not found' })
  res.json(record)
})

// Browser state for polling — returns URL + title for the given sessionId
app.get('/api/browser/state', async (req, res) => {
  const sessionId = req.query.sessionId
  if (!sessionId) return res.json({ url: '', title: '' })
  try {
    const state = await getBrowserState(sessionId)
    res.json({ url: state.url || '', title: state.title || '' })
  } catch {
    res.json({ url: '', title: '' })
  }
})

// ── Start ──────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3737
app.listen(PORT, () => {
  console.log(`Yantra server → http://localhost:${PORT}`)
  console.log(`  Anthropic: ${process.env.ANTHROPIC_API_KEY ? 'configured' : 'NOT SET'}`)
  console.log(`  OpenAI:    ${process.env.OPENAI_API_KEY    ? 'configured' : 'not set (optional)'}`)
  console.log(`  DB path:   ${path.join(__dirname, 'data', 'yantra.db')}`)
})

// Graceful shutdown
async function shutdown() {
  console.log('\n[server] Shutting down...')
  await closeBrowser()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT',  shutdown)
