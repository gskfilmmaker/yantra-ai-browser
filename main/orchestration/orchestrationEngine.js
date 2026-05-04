'use strict'
const { decompose }        = require('./taskDecomposer')
const { executeNode }      = require('./agentCoordinator')
const { CrossTaskMemory }  = require('./crossTaskMemory')
const { globalQueue }      = require('./jobQueue')

// ── Orchestration Engine v4 ───────────────────────────────────────────────────
// Entry points:
//   orchestrate(request, opts)       — synchronous, awaitable, returns structured result
//   orchestrateAsync(request, opts)  — enqueues background job, returns jobId immediately

// ── Synchronous entry point ───────────────────────────────────────────────────

async function orchestrate(request, opts = {}) {
  const graphId  = opts.graphId  || `graph_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
  const startMs  = Date.now()

  // ── 1. Decompose request into task graph ──────────────────────────────────
  const { graph, templateName } = decompose(request, graphId)
  const memory = new CrossTaskMemory(graphId)

  const agentsUsed         = []
  const intermediateResults = []
  const progress           = { pct: 0 }

  const totalNodes = graph.size
  let completedNodes = 0

  // ── 2. Execute nodes in topological order (wave-by-wave for branching) ────
  // Each wave = the set of nodes whose deps are all completed.

  while (!graph.isFinished()) {
    const ready = graph.readyNodes()
    if (!ready.length) break   // should not happen without cycles (already validated by topSort)

    // Run the current wave in parallel
    await Promise.all(ready.map(async nodeId => {
      const node = graph.nodes.get(nodeId)
      graph.setState(nodeId, 'running')

      if (node.agentHint && !agentsUsed.includes(node.agentHint)) {
        agentsUsed.push(node.agentHint)
      }

      try {
        const result = await executeNode(node, {
          memory,
          onProgress: (pct, msg) => {
            // Local node progress (informational, not wired to caller here)
          },
        })

        memory.set(nodeId, result)
        graph.setState(nodeId, 'completed', { result })
        completedNodes++
        progress.pct = Math.round((completedNodes / totalNodes) * 100)

        intermediateResults.push({
          nodeId,
          type:        node.type,
          agentHint:   node.agentHint,
          description: node.description,
          result:      typeof result === 'string' ? result.slice(0, 500) : result,
          completedAt: Date.now(),
        })
      } catch (err) {
        graph.setState(nodeId, 'failed', { error: err.message })
        completedNodes++
        progress.pct = Math.round((completedNodes / totalNodes) * 100)
        intermediateResults.push({
          nodeId,
          type:      node.type,
          agentHint: node.agentHint,
          error:     err.message,
          failed:    true,
        })
      }
    }))
  }

  // ── 3. Collect final result from the last completed node ──────────────────
  // The "report" or terminal node in the graph is the final result.
  const order       = graph.topologicalOrder()
  const lastNodeId  = order[order.length - 1]
  const finalResult = memory.get(lastNodeId) || '(no result produced)'

  const durationMs = Date.now() - startMs

  // ── 4. Persist graph summary to disk ──────────────────────────────────────
  memory.persist({
    request,
    template:    templateName,
    finalResult: typeof finalResult === 'string' ? finalResult.slice(0, 1000) : finalResult,
    stepsTotal:  totalNodes,
    stepsPassed: completedNodes,
    durationMs,
  })

  // ── 5. Build structured output ────────────────────────────────────────────
  return {
    taskGraph:           graph.toJSON(),
    agentsUsed,
    progress:            100,
    finalResult,
    intermediateResults,
    meta: {
      graphId,
      templateName,
      durationMs,
      stepsTotal:  totalNodes,
      stepsPassed: [...graph.nodes.values()].filter(n => n.state === 'completed').length,
      stepsFailed: [...graph.nodes.values()].filter(n => n.state === 'failed').length,
    },
  }
}

// ── Async / background entry point ────────────────────────────────────────────

function orchestrateAsync(request, opts = {}) {
  const jobId = opts.jobId || `job_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`

  globalQueue.enqueue(jobId, { request, opts }, async (job, onProgress) => {
    onProgress(5, 'Decomposing request')
    const result = await orchestrate(request, { ...opts, graphId: jobId })
    onProgress(100, 'Orchestration complete')
    return result
  })

  return jobId
}

module.exports = { orchestrate, orchestrateAsync }
