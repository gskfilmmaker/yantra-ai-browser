'use strict'

const _tools = new Map()

function register(tool) {
  if (!tool.name)    throw new Error('Tool requires a name')
  if (!tool.execute) throw new Error(`Tool "${tool.name}" requires an execute function`)
  _tools.set(tool.name, tool)
}

function get(name)  { return _tools.get(name) || null }
function list()     { return [..._tools.values()] }

// Returns Anthropic-format schemas for the agent.
// agentToolList = null means all registered tools.
function schemasForAgent(agentToolList) {
  const names = agentToolList || [..._tools.keys()]
  return names
    .map(n => _tools.get(n))
    .filter(Boolean)
    .map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema }))
}

async function execute(name, input, ctx) {
  const tool = _tools.get(name)
  if (!tool) return `Unknown tool: ${name}`
  try {
    const result = await tool.execute(input || {}, ctx || {})
    // Return string, or stringify objects/arrays
    if (typeof result === 'string') return result
    return JSON.stringify(result)
  } catch (e) {
    return `Tool error (${name}): ${e.message}`
  }
}

module.exports = { register, get, list, schemasForAgent, execute }
