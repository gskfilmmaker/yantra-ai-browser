'use strict'
const router = require('express').Router()

// GET /api/agents — list user's agents
router.get('/', (req, res) => {
  // TODO: SELECT * FROM agents WHERE user_id = $1 ORDER BY created_at DESC
  res.json({ agents: [], userId: req.user.sub })
})

// POST /api/agents — create agent
router.post('/', (req, res) => {
  const { name, avatar, description, systemPrompt, tools, memoryScope } = req.body
  if (!name) return res.status(400).json({ error: 'name required' })
  // TODO: INSERT INTO agents (...) VALUES (...)
  const agent = { id: `agent_${Date.now()}`, name, avatar, description, systemPrompt, tools, memoryScope, userId: req.user.sub }
  res.status(201).json({ agent })
})

// PATCH /api/agents/:id
router.patch('/:id', (req, res) => {
  const { id } = req.params
  // TODO: UPDATE agents SET ... WHERE id = $1 AND user_id = $2
  res.json({ id, ...req.body })
})

// DELETE /api/agents/:id
router.delete('/:id', (req, res) => {
  const { id } = req.params
  // TODO: DELETE FROM agents WHERE id = $1 AND user_id = $2
  res.json({ deleted: id })
})

module.exports = router
