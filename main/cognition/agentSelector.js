'use strict'

// ── Dynamic Agent Selector ────────────────────────────────────────────────────
// For each task-graph node, picks the best { agent, tool, confidence } using
// an LLM call.  Results are cached per (nodeType + description) to avoid
// repeated LLM round-trips within the same graph run.

const AGENTS = [
  'Master Orchestrator', 'Deep Research', 'Browser Operator',
  'Data Extraction', 'Document & Report', 'Engineering',
  'Code & DevOps', 'AWS Backend', 'SaaS Growth',
  'Security & Compliance', 'Summarizer',
]

const TOOLS = [
  'web_search', 'fetch_webpage', 'get_current_page', 'open_url',
  'getPageStructure', 'clickElement', 'typeInField', 'scrollPage',
  'waitForElement', 'captureScreenshot', 'extractTable', 'extractEntities',
  'exportCSV', 'generateReport', 'exportPDF', 'saveFinding',
  'executeTask', 'orchestrate',
]

// Node-type heuristics (used as LLM-free starting point / fallback)
const TYPE_DEFAULTS = {
  plan:      { agent: 'Master Orchestrator', tool: 'web_search',       confidence: 0.70 },
  research:  { agent: 'Deep Research',       tool: 'web_search',       confidence: 0.85 },
  automate:  { agent: 'Browser Operator',    tool: 'executeTask',      confidence: 0.80 },
  extract:   { agent: 'Data Extraction',     tool: 'extractEntities',  confidence: 0.80 },
  verify:    { agent: 'Browser Operator',    tool: 'captureScreenshot',confidence: 0.75 },
  implement: { agent: 'Engineering',         tool: 'web_search',       confidence: 0.70 },
  report:    { agent: 'Document & Report',   tool: 'generateReport',   confidence: 0.85 },
  generic:   { agent: 'Master Orchestrator', tool: 'web_search',       confidence: 0.60 },
}

const SYSTEM = `You are an agent-selector for Yantra, an AI browser automation platform.

Given a task node description, select the best agent and primary tool.

Available agents: ${AGENTS.join(', ')}
Available tools: ${TOOLS.join(', ')}

Respond ONLY with valid JSON — no markdown, no explanation:
{
  "agent": "Agent Name",
  "tool": "tool_name",
  "confidence": 0.0-1.0,
  "reasoning": "one sentence"
}`

// ── Cache ─────────────────────────────────────────────────────────────────────
const _cache = new Map()

// ── Public API ────────────────────────────────────────────────────────────────

// Select best agent/tool for a single node.
// Returns { agent, tool, confidence, reasoning }
async function selectForNode(node) {
  const cacheKey = `${node.type}::${node.description.slice(0, 80)}`
  if (_cache.has(cacheKey)) return _cache.get(cacheKey)

  // Try LLM selection
  const result = await _callLLM(node) || _heuristicSelect(node)

  _cache.set(cacheKey, result)
  return result
}

// Annotate all nodes in a TaskGraph with agent/tool/confidence.
// Returns a Map: nodeId → { agent, tool, confidence, reasoning }
async function selectForGraph(graph) {
  const selections = new Map()
  await Promise.all([...graph.nodes.values()].map(async node => {
    selections.set(node.id, await selectForNode(node))
  }))
  return selections
}

// ── LLM call ──────────────────────────────────────────────────────────────────

async function _callLLM(node) {
  let Anthropic
  try { Anthropic = require('@anthropic-ai/sdk') } catch { return null }
  if (!process.env.ANTHROPIC_API_KEY) return null

  try {
    const client = new Anthropic()
    const resp   = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 256,
      system:     SYSTEM,
      messages:   [{
        role:    'user',
        content: `Task node:\nType: ${node.type}\nDescription: ${node.description}\nAgent hint: ${node.agentHint || 'none'}`,
      }],
    })
    const text = (resp.content[0]?.text || '').trim()
    const parsed = JSON.parse(text)

    // Validate fields
    if (!AGENTS.includes(parsed.agent)) parsed.agent = _heuristicSelect(node).agent
    if (!TOOLS.includes(parsed.tool))   parsed.tool  = _heuristicSelect(node).tool
    parsed.confidence = Math.min(1, Math.max(0, parsed.confidence || 0.7))

    return parsed
  } catch {
    return null
  }
}

// ── Heuristic fallback ────────────────────────────────────────────────────────

function _heuristicSelect(node) {
  // If agentHint is a known agent, use it with medium confidence
  if (node.agentHint && AGENTS.includes(node.agentHint)) {
    const defaults = TYPE_DEFAULTS[node.type] || TYPE_DEFAULTS.generic
    return { agent: node.agentHint, tool: defaults.tool, confidence: 0.65, reasoning: 'agent hint' }
  }
  return TYPE_DEFAULTS[node.type] || TYPE_DEFAULTS.generic
}

module.exports = { selectForNode, selectForGraph }
