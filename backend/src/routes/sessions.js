'use strict'
const router = require('express').Router()

// GET /api/sessions
router.get('/', (req, res) => {
  // TODO: SELECT * FROM sessions WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 50
  res.json({ sessions: [], userId: req.user.sub })
})

// POST /api/sessions — create or upsert session
router.post('/', (req, res) => {
  const { agentId, messages, title } = req.body
  const session = {
    id: `sess_${Date.now()}`,
    agentId, messages, title,
    userId: req.user.sub,
    createdAt: new Date().toISOString(),
  }
  // TODO: INSERT INTO sessions (...) VALUES (...)
  res.status(201).json({ session })
})

// DELETE /api/sessions/:id
router.delete('/:id', (req, res) => {
  // TODO: DELETE FROM sessions WHERE id = $1 AND user_id = $2
  res.json({ deleted: req.params.id })
})

module.exports = router
