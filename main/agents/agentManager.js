'use strict'
const { load, save } = require('./agentStore')

let _data = null

function _d() {
  if (!_data) _data = load()
  return _data
}

function _persist() { save(_data) }

function listAgents()      { return _d().agents }
function getAgent(id)      { return _d().agents.find(a => a.id === id) || null }
function getActiveAgent()  {
  const d = _d()
  return d.agents.find(a => a.id === d.activeId) || d.agents[0] || null
}

function setActiveAgent(id) {
  if (!getAgent(id)) throw new Error(`Agent "${id}" not found`)
  _d().activeId = id
  _persist()
  return getAgent(id)
}

function createAgent(config) {
  if (!config.name) throw new Error('Agent name is required')
  const agent = {
    id: `agent-${Date.now()}`,
    avatar: '🤖',
    tools: ['web_search', 'fetch_webpage', 'get_current_page', 'saveFinding', 'save_note'],
    memoryScope: 'session',
    autoContext: true,
    defaultActions: [],
    ...config,
  }
  _d().agents.push(agent)
  _persist()
  return agent
}

function updateAgent(id, partial) {
  const idx = _d().agents.findIndex(a => a.id === id)
  if (idx === -1) throw new Error(`Agent "${id}" not found`)
  _d().agents[idx] = { ..._d().agents[idx], ...partial }
  _persist()
  return _d().agents[idx]
}

function deleteAgent(id) {
  const d = _d()
  const remaining = d.agents.filter(a => a.id !== id)
  if (!remaining.length) throw new Error('Cannot delete the last agent')
  d.agents = remaining
  if (d.activeId === id) d.activeId = remaining[0].id
  _persist()
}

module.exports = {
  listAgents, getAgent, getActiveAgent,
  setActiveAgent, createAgent, updateAgent, deleteAgent,
}
