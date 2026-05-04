'use strict'
const { TaskGraph } = require('./taskGraph')

// ── Pattern-based request decomposer ─────────────────────────────────────────
// Maps a natural-language request to a TaskGraph by matching against known
// workflow templates. No LLM call here — pure structural decomposition.

// ── Templates ─────────────────────────────────────────────────────────────────
// Each template: { test(req), build(graphId, req) → TaskGraph }

const TEMPLATES = [

  // ── Research + Report ─────────────────────────────────────────────────────
  {
    name: 'research_and_report',
    test: req => /research|investigate|find out|look up|summarize|report on/i.test(req),
    build(graphId, req) {
      const g = new TaskGraph(graphId)
      g.addNode({ id: 'plan',     type: 'plan',     agentHint: 'Master Orchestrator',  description: 'Create research plan',     params: { request: req } })
      g.addNode({ id: 'research', type: 'research', agentHint: 'Deep Research',         description: 'Execute research queries',  params: { request: req } })
      g.addNode({ id: 'extract',  type: 'extract',  agentHint: 'Data Extraction',       description: 'Extract structured data',   params: { request: req } })
      g.addNode({ id: 'report',   type: 'report',   agentHint: 'Document & Report',     description: 'Compile final report',      params: { request: req } })
      g.addEdge('plan', 'research')
      g.addEdge('research', 'extract')
      g.addEdge('extract', 'report')
      return g
    },
  },

  // ── Web Automation ────────────────────────────────────────────────────────
  {
    name: 'web_automation',
    test: req => /navigate|click|fill|submit|scrape|automate|browse|open url/i.test(req),
    build(graphId, req) {
      const g = new TaskGraph(graphId)
      g.addNode({ id: 'plan',     type: 'plan',     agentHint: 'Master Orchestrator', description: 'Plan automation steps',  params: { request: req } })
      g.addNode({ id: 'automate', type: 'automate', agentHint: 'Browser Operator',    description: 'Execute browser task',   params: { request: req } })
      g.addNode({ id: 'verify',   type: 'verify',   agentHint: 'Browser Operator',    description: 'Verify automation result', params: { request: req } })
      g.addEdge('plan', 'automate')
      g.addEdge('automate', 'verify')
      return g
    },
  },

  // ── Data Extraction ───────────────────────────────────────────────────────
  {
    name: 'data_extraction',
    test: req => /extract|scrape|parse|table|entities|structured data/i.test(req),
    build(graphId, req) {
      const g = new TaskGraph(graphId)
      g.addNode({ id: 'navigate', type: 'automate', agentHint: 'Browser Operator',  description: 'Navigate to source',     params: { request: req } })
      g.addNode({ id: 'extract',  type: 'extract',  agentHint: 'Data Extraction',   description: 'Extract target data',    params: { request: req } })
      g.addNode({ id: 'format',   type: 'report',   agentHint: 'Document & Report', description: 'Format extracted data',  params: { request: req } })
      g.addEdge('navigate', 'extract')
      g.addEdge('extract', 'format')
      return g
    },
  },

  // ── Code / Engineering ────────────────────────────────────────────────────
  {
    name: 'engineering',
    test: req => /code|implement|build|debug|fix|refactor|test|deploy|api/i.test(req),
    build(graphId, req) {
      const g = new TaskGraph(graphId)
      g.addNode({ id: 'plan',     type: 'plan',      agentHint: 'Master Orchestrator', description: 'Plan engineering task',  params: { request: req } })
      g.addNode({ id: 'research', type: 'research',  agentHint: 'Deep Research',        description: 'Research references',    params: { request: req } })
      g.addNode({ id: 'implement',type: 'implement', agentHint: 'Engineering',          description: 'Implement solution',     params: { request: req } })
      g.addNode({ id: 'report',   type: 'report',    agentHint: 'Document & Report',    description: 'Document solution',      params: { request: req } })
      g.addEdge('plan', 'research')
      g.addEdge('plan', 'implement')
      g.addEdge('research', 'implement')
      g.addEdge('implement', 'report')
      return g
    },
  },

  // ── Security Audit ────────────────────────────────────────────────────────
  {
    name: 'security_audit',
    test: req => /security|audit|vulnerability|compliance|pentest|scan/i.test(req),
    build(graphId, req) {
      const g = new TaskGraph(graphId)
      g.addNode({ id: 'plan',    type: 'plan',    agentHint: 'Master Orchestrator',      description: 'Audit plan',             params: { request: req } })
      g.addNode({ id: 'scan',    type: 'research',agentHint: 'Security & Compliance',    description: 'Scan for issues',        params: { request: req } })
      g.addNode({ id: 'extract', type: 'extract', agentHint: 'Data Extraction',          description: 'Collate findings',       params: { request: req } })
      g.addNode({ id: 'report',  type: 'report',  agentHint: 'Document & Report',        description: 'Produce audit report',   params: { request: req } })
      g.addEdge('plan', 'scan')
      g.addEdge('scan', 'extract')
      g.addEdge('extract', 'report')
      return g
    },
  },

  // ── Generic fallback ──────────────────────────────────────────────────────
  {
    name: 'generic',
    test: () => true,
    build(graphId, req) {
      const g = new TaskGraph(graphId)
      g.addNode({ id: 'plan',    type: 'plan',    agentHint: 'Master Orchestrator', description: 'Plan task',         params: { request: req } })
      g.addNode({ id: 'execute', type: 'execute', agentHint: 'Master Orchestrator', description: 'Execute task',      params: { request: req } })
      g.addNode({ id: 'report',  type: 'report',  agentHint: 'Summarizer',          description: 'Summarize results', params: { request: req } })
      g.addEdge('plan', 'execute')
      g.addEdge('execute', 'report')
      return g
    },
  },
]

// ── Public API ────────────────────────────────────────────────────────────────

function decompose(request, graphId) {
  for (const tpl of TEMPLATES) {
    if (tpl.test(request)) {
      const g = tpl.build(graphId || `graph_${Date.now()}`, request)
      return { graph: g, templateName: tpl.name }
    }
  }
  // unreachable (generic always matches)
  throw new Error('No template matched request')
}

module.exports = { decompose }
