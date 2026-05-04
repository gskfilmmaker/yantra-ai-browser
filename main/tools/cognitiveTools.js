'use strict'
const registry              = require('./registry')
const { cogitate }          = require('../cognition/cognitiveEngine')
const { globalQueue }       = require('../orchestration/jobQueue')
const { CrossTaskMemory }   = require('../orchestration/crossTaskMemory')
const learningLayer         = require('../cognition/learningLayer')

// ── cogitate ──────────────────────────────────────────────────────────────────

registry.register({
  name: 'cogitate',
  description: `Cognitive Engine v5 — the most intelligent task execution mode in Yantra.

Improvements over orchestrate (v4):
 • LLM-planned task graph — Claude decomposes the request into optimal nodes with priorities and dependencies (not regex templates)
 • Dynamic agent selection — Claude picks the best agent + tool per node based on task context
 • Feedback loop — when a node fails, Claude generates recovery nodes and continues execution
 • Learning layer — reuses strategies from prior successful runs (selector patterns, agent choices, retry tactics)
 • Confidence scoring — returns { taskConfidence, riskLevel, qualityScore } for every run

Returns:
{
  taskGraph, agentsUsed, progress, finalResult, intermediateResults,
  taskConfidence (0-1), riskLevel ("low|medium|high"), qualityScore (0-1),
  meta: { llmPlanned, learningHit, replansCount, durationMs, ... }
}

Use cogitate instead of orchestrate for complex, multi-step, or high-stakes tasks.`,

  inputSchema: {
    type: 'object',
    properties: {
      request: {
        type: 'string',
        description: 'The high-level task or goal (natural language)',
      },
      async: {
        type: 'boolean',
        description: 'If true, run in background and return a jobId immediately (default: false)',
      },
      graphId: {
        type: 'string',
        description: 'Optional custom graph ID. Auto-generated if omitted.',
      },
    },
    required: ['request'],
  },

  async execute({ request, async: runAsync = false, graphId } = {}) {
    if (!request?.trim()) return 'Error: request must be a non-empty string.'

    if (runAsync) {
      const jobId = graphId || `cog_${Date.now()}`
      globalQueue.enqueue(jobId, { request }, async (job, onProgress) => {
        onProgress(5, 'Planning with cognitive engine')
        const result = await cogitate(request, { graphId: jobId })
        onProgress(100, 'Cognitive run complete')
        return result
      })
      return `Cognitive job started.\n\n**Job ID:** \`${jobId}\`\n\nUse \`getJobStatus\` to poll progress and results.`
    }

    try {
      const result = await cogitate(request, { graphId })
      return _formatResult(result)
    } catch (e) {
      return `Cognitive engine error: ${e.message}`
    }
  },
})

// ── getCognitiveInsights ──────────────────────────────────────────────────────

registry.register({
  name: 'getCognitiveInsights',
  description: 'Query the cognitive learning layer for insights about past task performance, successful strategies, and retry patterns.',

  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'A natural-language request or topic to look up in the learning layer',
      },
      type: {
        type: 'string',
        enum: ['workflow', 'selector', 'retry', 'all'],
        description: 'Which type of insight to retrieve (default: all)',
      },
    },
    required: ['query'],
  },

  async execute({ query, type = 'all' } = {}) {
    if (!query?.trim()) return 'Error: query is required.'

    const key   = learningLayer.computeKey(query)
    const entry = learningLayer.lookup(key)

    if (!entry) {
      return `No prior experience found for: "${query.slice(0, 80)}"\n\nThe learning layer will record insights after the first successful run.`
    }

    const lines = [
      `## Cognitive Insights: "${entry.intentSample}"`,
      `**Template:** ${entry.templateName}  |  **Runs:** ${entry.usageCount}  |  **Success rate:** ${Math.round(entry.successCount / entry.usageCount * 100)}%`,
      `**Quality score:** ${Math.round((entry.qualityScore || 0) * 100)}%  |  **Last used:** ${entry.lastUsed || '—'}`,
    ]

    if ((type === 'workflow' || type === 'all') && entry.nodeTypes?.length) {
      lines.push('')
      lines.push(`### Workflow Pattern\n${entry.nodeTypes.join(' → ')}`)
    }

    if ((type === 'selector' || type === 'all') && Object.keys(entry.selectorStrategies || {}).length) {
      lines.push('')
      lines.push('### Selector Strategies')
      for (const [id, s] of Object.entries(entry.selectorStrategies).slice(0, 5)) {
        lines.push(`- **${id}**: \`${s.selector}\` via ${s.method} (confidence ${Math.round((s.confidence || 0) * 100)}%)`)
      }
    }

    if ((type === 'retry' || type === 'all') && entry.retryPatterns?.length) {
      lines.push('')
      lines.push('### Retry Patterns')
      for (const p of entry.retryPatterns.slice(0, 5)) {
        const rate = p.successCount + p.failCount > 0
          ? Math.round(p.successCount / (p.successCount + p.failCount) * 100)
          : 0
        lines.push(`- **${p.failType}** → ${p.recovery} (${rate}% success, ${p.successCount + p.failCount} observations)`)
      }
    }

    if ((type === 'workflow' || type === 'all') && Object.keys(entry.agentSelections || {}).length) {
      lines.push('')
      lines.push('### Agent Selections')
      for (const [nodeType, sel] of Object.entries(entry.agentSelections)) {
        lines.push(`- **${nodeType}**: ${sel.agent} via ${sel.tool} (confidence ${Math.round((sel.confidence || 0) * 100)}%)`)
      }
    }

    return lines.join('\n')
  },
})

// ── Formatter ─────────────────────────────────────────────────────────────────

function _formatResult(result) {
  if (typeof result === 'string') return result

  const {
    taskGraph,
    agentsUsed           = [],
    progress             = 100,
    finalResult,
    intermediateResults  = [],
    taskConfidence       = 0,
    riskLevel            = 'medium',
    qualityScore         = 0,
    meta                 = {},
  } = result

  const confBar  = _bar(taskConfidence)
  const qualBar  = _bar(qualityScore)
  const riskIcon = { low: '🟢', medium: '🟡', high: '🔴' }[riskLevel] || '⚪'

  const sections = [
    `## Cognitive Engine Result`,
    `**Graph:** \`${meta.graphId || taskGraph?.id || '—'}\`  |  **Template:** ${meta.templateName || '—'}  |  ${meta.llmPlanned ? '🧠 LLM-planned' : '📋 template'}${meta.learningHit ? '  |  📚 learning hit' : ''}`,
    `**Duration:** ${meta.durationMs || 0}ms  |  **Steps:** ${meta.stepsPassed || 0}/${meta.stepsTotal || 0}  |  **Replans:** ${meta.replansCount || 0}`,
    '',
    `### Confidence Scores`,
    `| Metric | Score | Bar |`,
    `|---|---|---|`,
    `| Task Confidence | ${(taskConfidence * 100).toFixed(0)}% | ${confBar} |`,
    `| Quality Score   | ${(qualityScore   * 100).toFixed(0)}% | ${qualBar} |`,
    `| Risk Level      | ${riskLevel}      | ${riskIcon} |`,
    '',
    `**Agents used:** ${agentsUsed.join(', ') || '—'}`,
    '',
    '---',
    '### Final Result',
    typeof finalResult === 'string' ? finalResult : JSON.stringify(finalResult, null, 2),
  ]

  if (intermediateResults.length) {
    sections.push('', '### Intermediate Results')
    for (const ir of intermediateResults) {
      const icon  = ir.failed ? '❌' : '✓'
      const agent = ir.agent ? ` · ${ir.agent}` : ''
      const conf  = ir.confidence != null ? ` (${Math.round(ir.confidence * 100)}% confidence)` : ''
      sections.push(`**${icon} ${ir.nodeId}** (${ir.type}${agent}${conf})`)
      if (ir.error)  sections.push(`> Error: ${ir.error}`)
      else if (ir.result) sections.push(`> ${String(ir.result).slice(0, 200)}${String(ir.result).length > 200 ? '…' : ''}`)
    }
  }

  return sections.join('\n')
}

function _bar(val) {
  const filled = Math.round((val || 0) * 10)
  return '█'.repeat(filled) + '░'.repeat(10 - filled)
}
