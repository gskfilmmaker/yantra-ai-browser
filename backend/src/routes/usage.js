'use strict'
const router = require('express').Router()

// GET /api/usage — current period usage summary
router.get('/', (req, res) => {
  // TODO: SELECT SUM(tokens_used) FROM usage_events WHERE user_id = $1 AND period = current_month()
  res.json({
    userId: req.user.sub,
    period: new Date().toISOString().slice(0, 7),
    tokensUsed: 0,
    tokensLimit: 100_000,
    requestCount: 0,
  })
})

// POST /api/usage/record — internal endpoint to log a usage event (called by Electron main process)
router.post('/record', (req, res) => {
  const { agentId, sessionId, tokensUsed, model } = req.body
  // TODO: INSERT INTO usage_events (user_id, agent_id, session_id, tokens_used, model, ts)
  res.status(201).json({ recorded: true })
})

module.exports = router
