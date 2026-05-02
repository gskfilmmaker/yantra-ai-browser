'use strict'
const { plan: llmPlan }        = require('./llmPlanner')
const { selectForGraph }        = require('./agentSelector')
const { handleFailure }         = require('./feedbackLoop')
const { score }                 = require('./confidenceScorer')
const learningLayer             = require('./learningLayer')
const { CrossTaskMemory }       = require('../orchestration/crossTaskMemory')
const { executeNode }           = require('../orchestration/agentCoordinator')

// ── Cognitive Engine v5 ───────────────────────────────────────────────────────
// Main entry point for intelligent, self-improving task execution.
//
// Pipeline:
//  1. Check learning layer for prior experience
//  2. LLM-plan the task graph (with learning hint as context)
//  3. LLM-select best agent+tool per node
//  4. Execute wave-by-wave; on failure → feedback loop → recovery nodes
//  5. Compute { taskConfidence, riskLevel, qualityScore }
//  6. Persist experience to learning layer
//  7. Return structured output

const MAX_FEEDBACK_ROUNDS = 3  // max times we'll attempt graph recovery

async function cogitate(request, opts = {}) {
  const startMs  = Date.now()
  const graphId  = opts.graphId || `cog_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`

  // ── 1. Learning layer lookup ──────────────────────────────────────────────
  const learnKey    = learningLayer.computeKey(request)
  const learningHit = !!learningLayer.lookup(learnKey)
  const hint        = learningLayer.getLearningHint(learnKey)

  // ── 2. LLM task graph planning ────────────────────────────────────────────
  let planResult
  try {
    planResult = await llmPlan(request, { graphId, learningHint: hint })
  } catch (e) {
    planResult = { graph: null, templateName: 'failed', llmPlanned: false, riskLevel: 'medium' }
  }

  if (!planResult.graph) {
    return _errorResult(graphId, 'Planning failed: could not build task graph', startMs)
  }

  const { graph, templateName, llmPlanned, riskLevel: plannerRiskLevel } = planResult

  // ── 3. Dynamic agent selection ────────────────────────────────────────────
  const agentSelections = await selectForGraph(graph)

  // Annotate nodes with selected agent/tool
  for (const [nodeId, sel] of agentSelections) {
    const node = graph.nodes.get(nodeId)
    if (node) {
      node.agentHint       = sel.agent
      node._agentSelection = sel
    }
  }

  // ── 4. Execution with feedback loop ───────────────────────────────────────
  const memory              = new CrossTaskMemory(graphId)
  const intermediateResults = []
  const agentsUsed          = []
  let replansCount          = 0
  let feedbackRound         = 0

  while (!graph.isFinished() && feedbackRound <= MAX_FEEDBACK_ROUNDS) {
    const ready = graph.readyNodes()
    if (!ready.length) break

    // Run ready nodes in parallel
    await Promise.all(ready.map(async nodeId => {
      const node = graph.nodes.get(nodeId)
      graph.setState(nodeId, 'running')

      const sel = agentSelections.get(nodeId) || {}
      if (sel.agent && !agentsUsed.includes(sel.agent)) agentsUsed.push(sel.agent)

      try {
        const result = await executeNode(node, { memory, onProgress: () => {} })
        memory.set(nodeId, result)
        // Store strategy alongside result
        memory.setStrategy(nodeId, {
          agent:      sel.agent,
          tool:       sel.tool,
          confidence: sel.confidence,
          nodeType:   node.type,
        })
        graph.setState(nodeId, 'completed', { result })
        intermediateResults.push(_irEntry(node, sel, result, false))
      } catch (err) {
        graph.setState(nodeId, 'failed', { error: err.message })
        intermediateResults.push(_irEntry(node, sel, null, true, err.message))

        // ── Feedback loop ────────────────────────────────────────────────
        if (feedbackRound < MAX_FEEDBACK_ROUNDS) {
          feedbackRound++
          replansCount++
          const recovery = await handleFailure(graph, nodeId, { memory })
          if (recovery.aborted) return  // propagate failure; graph will finish

          // Record retry patterns
          const retryEntry = {
            failType:  _classifyFailure(err.message),
            recovery:  recovery.strategy,
            succeeded: true,  // optimistic; updated after recovery runs
          }
          memory.addRetryPattern(retryEntry)

          // Select agents for newly inserted recovery nodes
          for (const recId of recovery.recoveryNodeIds) {
            const recNode = graph.nodes.get(recId)
            if (recNode) {
              const recSel = await _selectForNode(recNode)
              agentSelections.set(recId, recSel)
              recNode.agentHint       = recSel.agent
              recNode._agentSelection = recSel
              if (recSel.agent && !agentsUsed.includes(recSel.agent)) agentsUsed.push(recSel.agent)
            }
          }
        }
      }
    }))
  }

  // ── 5. Collect final result ───────────────────────────────────────────────
  const order      = graph.topologicalOrder()
  const lastNodeId = order[order.length - 1]
  const finalResult = memory.get(lastNodeId) || '(no result produced)'
  const durationMs  = Date.now() - startMs

  // ── 6. Confidence scoring ─────────────────────────────────────────────────
  const { taskConfidence, riskLevel, qualityScore } = score({
    graph,
    agentSelections,
    replansCount,
    learningHit,
    plannerRiskLevel,
    request,
    finalResult,
    durationMs,
  })

  // ── 7. Persist to learning layer ──────────────────────────────────────────
  const nodeTypes = order.map(id => graph.nodes.get(id)?.type).filter(Boolean)
  const agentSelectionsObj = {}
  for (const [id, sel] of agentSelections) {
    const node = graph.nodes.get(id)
    if (node) agentSelectionsObj[node.type] = sel
  }

  learningLayer.record(learnKey, {
    request,
    templateName,
    nodeTypes,
    agentSelections:    agentSelectionsObj,
    selectorStrategies: memory.getStrategies(),
    retryPatterns:      memory.getRetryPatterns(),
    qualityScore,
    completed:          graph.isFinished() && [...graph.nodes.values()].some(n => n.state === 'completed'),
    durationMs,
  })

  memory.persist({
    request,
    template:    templateName,
    finalResult: typeof finalResult === 'string' ? finalResult.slice(0, 1000) : finalResult,
    stepsTotal:  graph.size,
    stepsPassed: [...graph.nodes.values()].filter(n => n.state === 'completed').length,
    durationMs,
  })

  // ── 8. Return structured output ───────────────────────────────────────────
  return {
    taskGraph:           graph.toJSON(),
    agentsUsed,
    progress:            100,
    finalResult,
    intermediateResults,
    // v5 cognitive output
    taskConfidence,
    riskLevel,
    qualityScore,
    meta: {
      graphId,
      templateName,
      llmPlanned,
      learningHit,
      replansCount,
      durationMs,
      stepsTotal:  graph.size,
      stepsPassed: [...graph.nodes.values()].filter(n => n.state === 'completed').length,
      stepsFailed: [...graph.nodes.values()].filter(n => n.state === 'failed').length,
    },
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _irEntry(node, sel, result, failed, error) {
  return {
    nodeId:      node.id,
    type:        node.type,
    agent:       sel.agent  || node.agentHint,
    tool:        sel.tool,
    confidence:  sel.confidence,
    description: node.description,
    result:      typeof result === 'string' ? result.slice(0, 500) : result,
    failed,
    error:       error || null,
    completedAt: Date.now(),
  }
}

function _classifyFailure(errorMsg = '') {
  if (/element not found|could not find|bad selector/i.test(errorMsg)) return 'element_not_found'
  if (/timeout/i.test(errorMsg))            return 'timeout'
  if (/captcha/i.test(errorMsg))            return 'captcha'
  if (/navigation|url did not/i.test(errorMsg)) return 'navigation_failed'
  if (/network|fetch|http/i.test(errorMsg)) return 'network_error'
  return 'unknown'
}

async function _selectForNode(node) {
  const { selectForNode } = require('./agentSelector')
  return await selectForNode(node)
}

function _errorResult(graphId, reason, startMs) {
  return {
    taskGraph:           { id: graphId, nodes: [] },
    agentsUsed:          [],
    progress:            0,
    finalResult:         `Error: ${reason}`,
    intermediateResults: [],
    taskConfidence:      0,
    riskLevel:           'high',
    qualityScore:        0,
    meta: { graphId, error: reason, durationMs: Date.now() - startMs },
  }
}

module.exports = { cogitate }
