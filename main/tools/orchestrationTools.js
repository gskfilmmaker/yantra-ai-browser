'use strict'
const registry                         = require('./registry')
const { orchestrate, orchestrateAsync } = require('../orchestration/orchestrationEngine')
const { globalQueue }                  = require('../orchestration/jobQueue')
const { CrossTaskMemory }              = require('../orchestration/crossTaskMemory')

// ── orchestrate ───────────────────────────────────────────────────────────────

registry.register({
  name: 'orchestrate',
  description: `Orchestration Engine v4 — decomposes a request into a multi-agent task graph and executes it.

Automatically:
 • Selects a workflow template (research+report, web automation, data extraction, engineering, security audit, or generic)
 • Builds a directed acyclic task graph with branching / merging support
 • Assigns each node to the appropriate specialist agent (Planner → Researcher → Extractor → Reporter)
 • Executes nodes wave-by-wave (parallel within each wave, topologically ordered across waves)
 • Shares results across tasks via cross-task memory
 • Persists graph summaries for future reference

Use \`async: true\` to run in the background and get a jobId for polling.

Returns a structured object with:
 { taskGraph, agentsUsed, progress (0–100), finalResult, intermediateResults, meta }`,

  inputSchema: {
    type: 'object',
    properties: {
      request: {
        type: 'string',
        description: 'The high-level task or goal to orchestrate (natural language)',
      },
      async: {
        type: 'boolean',
        description: 'If true, run in background and return a jobId immediately (default: false)',
      },
      graphId: {
        type: 'string',
        description: 'Optional custom graph/job ID. Auto-generated if omitted.',
      },
    },
    required: ['request'],
  },

  async execute({ request, async: runAsync = false, graphId } = {}) {
    if (!request || !request.trim()) return 'Error: request must be a non-empty string.'

    if (runAsync) {
      const jobId = orchestrateAsync(request, { jobId: graphId })
      return `Orchestration job started.\n\n**Job ID:** \`${jobId}\`\n\nUse \`getJobStatus\` with this ID to poll progress and results.`
    }

    try {
      const result = await orchestrate(request, { graphId })
      return _formatResult(result)
    } catch (e) {
      return `Orchestration error: ${e.message}`
    }
  },
})

// ── getJobStatus ──────────────────────────────────────────────────────────────

registry.register({
  name: 'getJobStatus',
  description: 'Get the current status, progress, and result of a background orchestration job.',

  inputSchema: {
    type: 'object',
    properties: {
      jobId: {
        type: 'string',
        description: 'The job ID returned by orchestrate (with async: true)',
      },
    },
    required: ['jobId'],
  },

  async execute({ jobId } = {}) {
    if (!jobId) return 'Error: jobId is required.'

    const job = globalQueue.get(jobId)
    if (!job) {
      // Try disk-persisted summary (completed job from a previous session)
      const summary = CrossTaskMemory.loadSummary(jobId)
      if (summary) {
        return `## Job \`${jobId}\`\n**Status:** completed (from prior session)\n\n\`\`\`json\n${JSON.stringify(summary, null, 2)}\n\`\`\``
      }
      return `No job found with ID \`${jobId}\`.`
    }

    const j = job.toJSON()
    const lines = [
      `## Job \`${jobId}\``,
      `**Status:** ${j.state}`,
      `**Progress:** ${j.progress}%`,
      j.startedAt   ? `**Started:** ${new Date(j.startedAt).toISOString()}`   : '',
      j.completedAt ? `**Completed:** ${new Date(j.completedAt).toISOString()}` : '',
      j.error       ? `**Error:** ${j.error}` : '',
    ].filter(Boolean)

    if (j.state === 'completed' && j.result) {
      lines.push('')
      lines.push(_formatResult(j.result))
    }

    if (j.log && j.log.length) {
      lines.push('')
      lines.push('**Log (last 5 entries):**')
      for (const entry of j.log.slice(-5)) {
        lines.push(`- \`${new Date(entry.ts).toISOString()}\` ${entry.msg}`)
      }
    }

    return lines.join('\n')
  },
})

// ── listJobs ──────────────────────────────────────────────────────────────────

registry.register({
  name: 'listJobs',
  description: 'List recent orchestration jobs and their status.',

  inputSchema: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        description: 'Maximum number of jobs to return (default: 10)',
      },
    },
  },

  async execute({ limit = 10 } = {}) {
    const jobs = globalQueue.list({ limit })

    if (!jobs.length) {
      const summaries = CrossTaskMemory.listSummaries(limit)
      if (!summaries.length) return 'No orchestration jobs found.'
      const rows = summaries.map(s =>
        `| \`${s.graphId}\` | completed | ${s.stepsPassed}/${s.stepsTotal} steps | ${s.completedAt} |`
      )
      return `## Recent Orchestration Runs\n\n| Graph ID | State | Steps | Completed At |\n|---|---|---|---|\n${rows.join('\n')}`
    }

    const stats = globalQueue.stats()
    const rows = jobs.map(j =>
      `| \`${j.id}\` | ${j.state} | ${j.progress}% | ${j.startedAt ? new Date(j.startedAt).toISOString() : '—'} |`
    )

    const lines = [
      `## Orchestration Jobs`,
      `**Queue stats:** ${stats.running} running · ${stats.queued} queued · ${stats.completed} completed · ${stats.failed} failed`,
      '',
      '| Job ID | State | Progress | Started |',
      '|---|---|---|---|',
      ...rows,
    ]

    return lines.join('\n')
  },
})

// ── Formatter ─────────────────────────────────────────────────────────────────

function _formatResult(result) {
  if (typeof result === 'string') return result

  const {
    taskGraph,
    agentsUsed     = [],
    progress       = 100,
    finalResult,
    intermediateResults = [],
    meta           = {},
  } = result

  const sections = [
    `## Orchestration Result`,
    `**Graph:** \`${meta.graphId || taskGraph?.id || '—'}\`  |  **Template:** ${meta.templateName || '—'}  |  **Duration:** ${meta.durationMs || 0}ms`,
    `**Progress:** ${progress}%  |  **Steps:** ${meta.stepsPassed || 0}/${meta.stepsTotal || 0} passed${meta.stepsFailed ? ` · ${meta.stepsFailed} failed` : ''}`,
    `**Agents used:** ${agentsUsed.join(', ') || '—'}`,
    '',
    '---',
    '### Final Result',
    typeof finalResult === 'string' ? finalResult : JSON.stringify(finalResult, null, 2),
  ]

  if (intermediateResults.length > 0) {
    sections.push('')
    sections.push('### Intermediate Results')
    for (const ir of intermediateResults) {
      const label = ir.failed ? `❌ ${ir.nodeId}` : `✓ ${ir.nodeId}`
      sections.push(`**${label}** (${ir.type}${ir.agentHint ? ' · ' + ir.agentHint : ''})`)
      if (ir.error) sections.push(`> Error: ${ir.error}`)
      else if (ir.result) sections.push(`> ${String(ir.result).slice(0, 200)}${String(ir.result).length > 200 ? '…' : ''}`)
    }
  }

  if (taskGraph?.nodes?.length) {
    sections.push('')
    sections.push('### Task Graph')
    sections.push('```json')
    sections.push(JSON.stringify(taskGraph, null, 2))
    sections.push('```')
  }

  return sections.join('\n')
}
