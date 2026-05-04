'use strict'
const { TaskGraph }    = require('../orchestration/taskGraph')
const { selectForNode } = require('./agentSelector')

// ── Feedback Loop ─────────────────────────────────────────────────────────────
// When a node fails, asks the LLM to generate a recovery strategy and inserts
// recovery nodes into the running task graph so execution can continue.
//
// Recovery types:
//   retry_with_wait    — insert a wait node then retry original
//   reroute            — replace failed node with an alternative approach
//   decompose          — split the failed node into smaller sub-nodes
//   abort              — mark unrecoverable; propagate failure upstream
//   human_checkpoint   — insert a confirm node before retrying

const SYSTEM = `You are a recovery planner for Yantra, an AI browser automation platform.

A task node has failed. Given the context, generate a recovery plan.

Respond ONLY with valid JSON:
{
  "strategy": "retry_with_wait | reroute | decompose | abort | human_checkpoint",
  "reasoning": "one sentence",
  "recoveryNodes": [
    {
      "id": "unique_recovery_id",
      "type": "plan|research|automate|extract|verify|report|wait|generic",
      "description": "What this recovery node does",
      "agentHint": "Agent name",
      "dependsOn": [],
      "params": {}
    }
  ]
}`

// ── Public API ────────────────────────────────────────────────────────────────

// Evaluate a failure and mutate the graph with recovery nodes.
// Returns { strategy, recoveryNodeIds, aborted }
async function handleFailure(graph, failedNodeId, context = {}) {
  const failedNode = graph.nodes.get(failedNodeId)
  if (!failedNode) return { strategy: 'abort', recoveryNodeIds: [], aborted: true }

  // Hard abort conditions
  if (/captcha|needs_human/i.test(failedNode.error || '')) {
    return _abort(graph, failedNodeId, 'captcha detected')
  }
  if (/no browser tab|no active tab/i.test(failedNode.error || '')) {
    return _abort(graph, failedNodeId, 'no active browser tab')
  }

  // Attempt LLM recovery plan
  const plan = await _callLLM(failedNode, context)
  if (!plan || plan.strategy === 'abort') {
    return _abort(graph, failedNodeId, plan?.reasoning || 'unrecoverable failure')
  }

  return await _applyRecovery(graph, failedNode, plan)
}

// ── Recovery application ──────────────────────────────────────────────────────

async function _applyRecovery(graph, failedNode, plan) {
  const recoveryNodeIds = []

  switch (plan.strategy) {

    case 'retry_with_wait': {
      // Insert a wait node, then re-queue the failed node as a new id
      const waitId   = `wait_recovery_${failedNode.id}`
      const retryId  = `retry_${failedNode.id}`
      graph.addNode({ id: waitId,  type: 'wait',   description: 'Recovery wait', agentHint: null, params: { duration: 2000 } })
      graph.addNode({ id: retryId, type: failedNode.type, description: failedNode.description + ' (retry)', agentHint: failedNode.agentHint, params: failedNode.params })
      // waitId depends on nothing; retryId depends on waitId
      graph.addEdge(waitId, retryId)
      // All nodes that depended on failedNode now depend on retryId
      _rerouteDownstream(graph, failedNode.id, retryId)
      recoveryNodeIds.push(waitId, retryId)
      break
    }

    case 'reroute': {
      // LLM provides alternative nodes
      for (const rn of (plan.recoveryNodes || [])) {
        const nodeId = `reroute_${failedNode.id}_${rn.id}`
        const sel    = await selectForNode({ ...rn, id: nodeId })
        graph.addNode({
          id:          nodeId,
          type:        rn.type,
          description: rn.description,
          agentHint:   sel.agent,
          params:      { ...rn.params, request: failedNode.params?.request || '' },
          _agentSelection: sel,
        })
        for (const dep of (rn.dependsOn || [])) {
          const resolvedDep = `reroute_${failedNode.id}_${dep}`
          if (graph.nodes.has(resolvedDep)) graph.addEdge(resolvedDep, nodeId)
        }
        recoveryNodeIds.push(nodeId)
      }
      if (recoveryNodeIds.length > 0) {
        _rerouteDownstream(graph, failedNode.id, recoveryNodeIds[recoveryNodeIds.length - 1])
      }
      break
    }

    case 'decompose': {
      // Replace failed node with multiple smaller nodes in sequence
      const subNodes = plan.recoveryNodes || []
      let prevId     = null
      for (const sn of subNodes) {
        const nodeId = `decomp_${failedNode.id}_${sn.id}`
        const sel    = await selectForNode({ ...sn, id: nodeId })
        graph.addNode({
          id:          nodeId,
          type:        sn.type,
          description: sn.description,
          agentHint:   sel.agent,
          params:      { ...sn.params, request: failedNode.params?.request || '' },
          _agentSelection: sel,
        })
        if (prevId) graph.addEdge(prevId, nodeId)
        prevId = nodeId
        recoveryNodeIds.push(nodeId)
      }
      if (prevId) _rerouteDownstream(graph, failedNode.id, prevId)
      break
    }

    case 'human_checkpoint': {
      const checkId  = `confirm_${failedNode.id}`
      const retryId  = `retry_${failedNode.id}`
      graph.addNode({ id: checkId,  type: 'verify', description: 'Human checkpoint before retry', agentHint: 'Browser Operator', params: { request: 'Please confirm before retrying: ' + failedNode.description } })
      graph.addNode({ id: retryId,  type: failedNode.type, description: failedNode.description + ' (after checkpoint)', agentHint: failedNode.agentHint, params: failedNode.params })
      graph.addEdge(checkId, retryId)
      _rerouteDownstream(graph, failedNode.id, retryId)
      recoveryNodeIds.push(checkId, retryId)
      break
    }

    default:
      return _abort(graph, failedNode.id, 'unknown strategy')
  }

  // Mark failed node as skipped so it won't block the wave
  graph.setState(failedNode.id, 'skipped')

  return {
    strategy:         plan.strategy,
    reasoning:        plan.reasoning,
    recoveryNodeIds,
    aborted:          false,
  }
}

// ── Graph mutation helpers ─────────────────────────────────────────────────────

function _rerouteDownstream(graph, oldId, newId) {
  const dependents = [...(graph.reverse.get(oldId) || [])]
  for (const depId of dependents) {
    const depDeps = graph.edges.get(depId)
    if (depDeps) {
      depDeps.delete(oldId)
      depDeps.add(newId)
    }
    const rev = graph.reverse.get(newId)
    if (rev) rev.add(depId)
  }
  const oldRev = graph.reverse.get(oldId)
  if (oldRev) oldRev.clear()
}

function _abort(graph, nodeId, reason) {
  graph.setState(nodeId, 'failed', { error: reason })
  return { strategy: 'abort', reasoning: reason, recoveryNodeIds: [], aborted: true }
}

// ── LLM call ──────────────────────────────────────────────────────────────────

async function _callLLM(failedNode, context) {
  let Anthropic
  try { Anthropic = require('@anthropic-ai/sdk') } catch { return null }
  if (!process.env.ANTHROPIC_API_KEY) return null

  const priorResults = context.memory ? JSON.stringify(context.memory.snapshot()).slice(0, 400) : 'none'

  try {
    const client = new Anthropic()
    const resp   = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 512,
      system:     SYSTEM,
      messages:   [{
        role:    'user',
        content: `Failed node:
Type: ${failedNode.type}
Description: ${failedNode.description}
Error: ${failedNode.error || 'unknown'}
Prior results available: ${priorResults}`,
      }],
    })
    const text = (resp.content[0]?.text || '').trim()
    return JSON.parse(text)
  } catch {
    return null
  }
}

module.exports = { handleFailure }
