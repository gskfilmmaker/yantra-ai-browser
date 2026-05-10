'use strict'
const express  = require('express')
const cors     = require('cors')
const path     = require('path')
const { chromium } = require('playwright')
const db       = require('./db')
const { runAgentLoop } = require('./agent')
const registry = require('./tools/registry')

require('./tools/browserTools')
require('./tools/searchTools')
require('./tools/memoryTools')

const app = express()
app.use(cors())
app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

let browser = null
const sessions  = new Map()
const cancelled = new Set()
const interrupts = new Map()

async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  }
  return browser
}

function emit(sessionId, type, data) {
  const s = sessions.get(sessionId)
  if (!s) return
  const payload = JSON.stringify({ type, ...data })
  for (const res of s.sseClients) {
    try { res.write(`data: ${payload}\n\n`) } catch { s.sseClients.delete(res) }
  }
}

app.post('/api/agent/run', async (req, res) => {
  const { message, sessionId: sid } = req.body
  if (!message) return res.status(400).json({ error: 'message required' })
  const sessionId = sid || `sess-${Date.now()}`
  if (!sessions.has(sessionId)) sessions.set(sessionId, { sseClients: new Set(), messages: [], goal: message, page: null })
  const session = sessions.get(sessionId)
  session.goal = message
  db.saveSession(sessionId, message, session.messages, null)
  cancelled.delete(sessionId); interrupts.delete(sessionId)

  const tools = registry.list().map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema }))
  const systemPrompt = `You are Yantra, an advanced AI browser automation agent. Use your tools methodically: observe → plan → act → verify. Always screenshot after actions to confirm they worked.`

  ;(async () => {
    try {
      const bw = await getBrowser()
      if (!session.page || session.page.isClosed()) session.page = await bw.newPage()
      registry.setContext({ page: session.page, sessionId })
      const finalMessages = await runAgentLoop({
        sessionId, message, history: session.messages.slice(), systemPrompt, tools,
        emitEvent:    (type, data) => emit(sessionId, type, data),
        isCancelled:  () => cancelled.has(sessionId),
        getInterrupt: () => { const m = interrupts.get(sessionId); if (m) interrupts.delete(sessionId); return m || null },
        onCheckpoint: (msgs) => { session.messages = msgs; db.saveSession(sessionId, session.goal, msgs, null) },
      })
      session.messages = finalMessages
      db.saveSession(sessionId, session.goal, finalMessages, Date.now())
    } catch (e) { emit(sessionId, 'error', { text: e.message }) }
    finally     { emit(sessionId, 'done', {}) }
  })()

  res.json({ sessionId })
})

app.get('/api/agent/stream/:sessionId', (req, res) => {
  const { sessionId } = req.params
  if (!sessions.has(sessionId)) sessions.set(sessionId, { sseClients: new Set(), messages: [], goal: '', page: null })
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()
  sessions.get(sessionId).sseClients.add(res)
  req.on('close', () => sessions.get(sessionId)?.sseClients.delete(res))
})

app.post('/api/agent/cancel/:sessionId',    (req, res) => { cancelled.add(req.params.sessionId); res.json({ ok: true }) })
app.post('/api/agent/interrupt/:sessionId', (req, res) => { interrupts.set(req.params.sessionId, req.body.message || ''); res.json({ ok: true }) })
app.get('/api/sessions',            (_req, res) => res.json(db.listRecent(20)))
app.get('/api/sessions/incomplete', (_req, res) => res.json(db.getIncomplete()))
app.get('/api/browser/state', async (req, res) => {
  const s = sessions.get(req.query.sessionId)
  if (!s?.page || s.page.isClosed()) return res.json({ url: '', title: '' })
  try { res.json({ url: s.page.url(), title: await s.page.title() }) } catch { res.json({ url: '', title: '' }) }
})
app.get('/api/health', (_req, res) => res.json({ ok: true, sessions: sessions.size }))

const PORT = process.env.PORT || 3737
app.listen(PORT, () => console.log(`Yantra server → http://localhost:${PORT}`))
