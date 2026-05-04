'use strict'
const registry = require('../tools/registry')

// ── Agent Coordinator ─────────────────────────────────────────────────────────
// Maps task-node types (and agent hints) to concrete tool calls via the registry.
// No LLM calls — executes structured tool invocations and returns raw results.

// ── Task-type → tool routing ──────────────────────────────────────────────────

const TYPE_TOOL_MAP = {
  plan:      _planStep,
  research:  _researchStep,
  extract:   _extractStep,
  automate:  _automateStep,
  verify:    _verifyStep,
  implement: _implementStep,
  report:    _reportStep,
  execute:   _executeStep,
  generic:   _executeStep,
}

// ── Public API ────────────────────────────────────────────────────────────────

// Execute a single task node.
// context.memory — CrossTaskMemory instance for reading prior step results
// context.onProgress — optional (pct, msg) callback
// Returns the result string/object, or throws on error.

async function executeNode(node, context = {}) {
  const { memory, onProgress = () => {} } = context
  const handler = TYPE_TOOL_MAP[node.type] || _executeStep

  onProgress(0, `Starting ${node.type} task: ${node.description}`)

  const priorResults = memory ? memory.snapshot() : {}
  const result = await handler(node, priorResults, onProgress)

  onProgress(100, `Completed ${node.type} task`)
  return result
}

// ── Step handlers ─────────────────────────────────────────────────────────────

async function _planStep(node, priorResults, onProgress) {
  const { request } = node.params
  onProgress(30, 'Planning task decomposition')
  // Use web_search to gather orientation data for planning
  const tool = registry.get('web_search')
  if (!tool) return `Plan: ${request}\n\n(web_search unavailable — proceeding with direct execution)`

  try {
    const res = await tool.execute({ query: `best approach to: ${request}`, count: 3 })
    return `## Task Plan\n**Request:** ${request}\n\n**Research findings:**\n${res}\n\n**Approach:** Sequential execution per task graph.`
  } catch (e) {
    return `## Task Plan\n**Request:** ${request}\n\n**Approach:** Direct execution (planning search failed: ${e.message})`
  }
}

async function _researchStep(node, priorResults, onProgress) {
  const { request } = node.params
  onProgress(20, 'Executing research queries')

  const searchTool = registry.get('web_search')
  const fetchTool  = registry.get('fetch_webpage')

  const results = []

  if (searchTool) {
    try {
      onProgress(40, 'Running web search')
      const res = await searchTool.execute({ query: request, count: 5 })
      results.push(`### Web Search Results\n${res}`)
    } catch (e) {
      results.push(`### Web Search\n(failed: ${e.message})`)
    }
  }

  // If prior plan provided URLs, fetch the top one
  const planResult = priorResults.plan || ''
  const urlMatch   = planResult.match(/https?:\/\/[^\s)>"]+/)
  if (urlMatch && fetchTool) {
    try {
      onProgress(70, `Fetching ${urlMatch[0]}`)
      const page = await fetchTool.execute({ url: urlMatch[0] })
      results.push(`### Page Content\n${typeof page === 'string' ? page.slice(0, 2000) : JSON.stringify(page).slice(0, 2000)}`)
    } catch { /* non-fatal */ }
  }

  return results.join('\n\n') || `Research completed for: ${request}`
}

async function _extractStep(node, priorResults, onProgress) {
  const { request } = node.params
  onProgress(30, 'Extracting structured data')

  const prior = Object.values(priorResults).join('\n\n').slice(0, 4000)

  // Try entity extraction from accumulated page content
  const extractTool = registry.get('extractEntities')
  if (extractTool) {
    try {
      onProgress(60, 'Running entity extraction')
      const res = await extractTool.execute({ text: prior || request })
      return `## Extracted Data\n${typeof res === 'string' ? res : JSON.stringify(res, null, 2)}`
    } catch (e) {
      // fall through
    }
  }

  // Fallback: return a structured summary of prior results
  return `## Extracted Data\n**Source:** Research results\n\n${prior || '(no prior data)'}`
}

async function _automateStep(node, priorResults, onProgress) {
  const { request } = node.params
  onProgress(20, 'Preparing browser automation')

  const executeTaskTool = registry.get('executeTask')
  if (!executeTaskTool) {
    return `Automation skipped: executeTask tool unavailable.\nRequest: ${request}`
  }

  // Build a minimal navigate + screenshot step from the request
  const urlMatch = request.match(/https?:\/\/[^\s)>"]+/)
  const steps = urlMatch
    ? [
        { id: 'nav',   type: 'navigate',   params: { url: urlMatch[0] } },
        { id: 'shot',  type: 'screenshot', params: {} },
      ]
    : [
        { id: 'shot',  type: 'screenshot', params: {} },
      ]

  try {
    onProgress(50, 'Executing browser steps')
    const res = await executeTaskTool.execute({ name: `Automate: ${request}`, steps })
    return res
  } catch (e) {
    return `Automation error: ${e.message}`
  }
}

async function _verifyStep(node, priorResults, onProgress) {
  onProgress(50, 'Verifying previous automation results')
  const autoResult = priorResults.automate || priorResults.navigate || ''
  const passed     = /passed|completed|success/i.test(autoResult)
  return `## Verification\nStatus: ${passed ? 'PASSED ✓' : 'REVIEW NEEDED ⚠'}\n\nPrevious automation output:\n${String(autoResult).slice(0, 1000)}`
}

async function _implementStep(node, priorResults, onProgress) {
  const { request } = node.params
  onProgress(50, 'Generating implementation')
  const research = priorResults.research || ''
  return `## Implementation\n**Task:** ${request}\n\n**Based on research:**\n${String(research).slice(0, 2000)}\n\n*(Engineering agent would execute this step with code tooling)*`
}

async function _reportStep(node, priorResults, onProgress) {
  onProgress(20, 'Compiling report')

  const docTool = registry.get('createDocument')
  const parts   = Object.entries(priorResults)
    .map(([k, v]) => `## ${k.charAt(0).toUpperCase() + k.slice(1)}\n${String(v).slice(0, 2000)}`)
    .join('\n\n---\n\n')

  if (docTool) {
    try {
      onProgress(60, 'Generating document')
      const doc = await docTool.execute({ content: parts, format: 'markdown' })
      return doc
    } catch { /* fall through */ }
  }

  return `# Final Report\n\n${parts}`
}

async function _executeStep(node, priorResults, onProgress) {
  const { request } = node.params
  onProgress(50, 'Executing generic step')
  const searchTool = registry.get('web_search')
  if (searchTool) {
    try {
      const res = await searchTool.execute({ query: request, count: 3 })
      return res
    } catch { /* fall through */ }
  }
  return `Executed: ${request}`
}

module.exports = { executeNode }
