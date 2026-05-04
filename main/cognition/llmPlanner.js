'use strict'
const { TaskGraph }  = require('../orchestration/taskGraph')
const { decompose }  = require('../orchestration/taskDecomposer')

// ── LLM-based Task Planner ────────────────────────────────────────────────────
// Replaces regex template matching with an LLM call that generates a structured
// task graph from natural language.  Falls back to taskDecomposer on any error.

const SYSTEM = `You are a task-graph planner for an AI browser automation platform called Yantra.

Given a user request, return a JSON task graph with these fields:

{
  "title": "Short task title",
  "nodes": [
    {
      "id": "unique_snake_case_id",
      "type": "plan|research|automate|extract|verify|implement|report|generic",
      "description": "What this node does",
      "agentHint": "Agent name best suited",
      "priority": 1-10,
      "dependsOn": ["id_of_dependency"],
      "params": { "request": "..." }
    }
  ],
  "riskLevel": "low|medium|high",
  "estimatedSteps": 3
}

RULES:
- Use only these node types: plan, research, automate, extract, verify, implement, report, generic
- Agent hints must be one of: Master Orchestrator, Deep Research, Browser Operator, Data Extraction, Document & Report, Engineering, Code & DevOps, AWS Backend, SaaS Growth, Security & Compliance, Summarizer
- dependsOn must reference node ids defined earlier in the list
- Priority 10 = most critical; 1 = optional/nice-to-have
- For simple tasks: 2-3 nodes. Complex: 4-6 nodes. Never more than 8 nodes.
- Detect destructive actions (form fills, clicks, purchases) → riskLevel "high"
- Always end with a report or verify node as the terminal node
- Return ONLY valid JSON — no markdown fences, no explanation`

// ── Public API ────────────────────────────────────────────────────────────────

async function plan(request, opts = {}) {
  const graphId = opts.graphId || `graph_${Date.now()}`

  // Try LLM planning first
  const llmResult = await _callLLM(request, opts.learningHint || '')
  if (llmResult) {
    try {
      return _buildGraph(graphId, request, llmResult)
    } catch (e) {
      // JSON parsed but graph build failed — fall through to decomposer
    }
  }

  // Fallback: regex-based decomposer
  const { graph, templateName } = decompose(request, graphId)
  return { graph, templateName, llmPlanned: false }
}

// ── LLM call ──────────────────────────────────────────────────────────────────

async function _callLLM(request, learningHint) {
  let Anthropic
  try { Anthropic = require('@anthropic-ai/sdk') } catch { return null }
  if (!process.env.ANTHROPIC_API_KEY) return null

  const userContent = learningHint
    ? `User request: "${request.slice(0, 600)}"\n\nContext from similar past tasks:\n${learningHint.slice(0, 400)}`
    : `User request: "${request.slice(0, 600)}"`

  try {
    const client = new Anthropic()
    const resp   = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system:     SYSTEM,
      messages:   [{ role: 'user', content: userContent }],
    })
    const text = (resp.content[0]?.text || '').trim()
    return JSON.parse(text)
  } catch {
    return null
  }
}

// ── Graph builder ─────────────────────────────────────────────────────────────

function _buildGraph(graphId, request, plan) {
  const graph = new TaskGraph(graphId)
  const nodes = Array.isArray(plan.nodes) ? plan.nodes : []

  if (nodes.length === 0) throw new Error('LLM returned no nodes')

  // Add nodes
  for (const n of nodes) {
    graph.addNode({
      id:          n.id,
      type:        n.type        || 'generic',
      description: n.description || '',
      agentHint:   n.agentHint   || null,
      priority:    n.priority    || 5,
      params:      { ...(n.params || {}), request },
    })
  }

  // Add edges (dependency links)
  for (const n of nodes) {
    for (const dep of (n.dependsOn || [])) {
      try { graph.addEdge(dep, n.id) } catch { /* skip invalid refs */ }
    }
  }

  return {
    graph,
    templateName: 'llm_planned',
    llmPlanned:   true,
    title:        plan.title || request.slice(0, 60),
    riskLevel:    plan.riskLevel    || 'medium',
    estimatedSteps: plan.estimatedSteps || nodes.length,
  }
}

module.exports = { plan }
