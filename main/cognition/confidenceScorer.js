'use strict'

// ── Confidence Scorer ─────────────────────────────────────────────────────────
// Computes { taskConfidence, riskLevel, qualityScore } for a completed cognitive run.
//
// taskConfidence: how likely the task fully achieved the user's intent (0-1)
// riskLevel:      'low' | 'medium' | 'high' — destructiveness / reversibility
// qualityScore:   completeness + accuracy proxy (0-1)

// ── Public API ────────────────────────────────────────────────────────────────

function score(run) {
  const taskConfidence = _taskConfidence(run)
  const riskLevel      = _riskLevel(run)
  const qualityScore   = _qualityScore(run)
  return { taskConfidence, riskLevel, qualityScore }
}

// ── Component scorers ─────────────────────────────────────────────────────────

function _taskConfidence(run) {
  const { graph, agentSelections = new Map(), replansCount = 0, learningHit = false } = run

  if (!graph) return 0.5

  const nodes    = [...graph.nodes.values()]
  const total    = nodes.length
  const passed   = nodes.filter(n => n.state === 'completed').length
  const failed   = nodes.filter(n => n.state === 'failed').length
  const skipped  = nodes.filter(n => n.state === 'skipped').length

  if (total === 0) return 0.5

  // Base: ratio of nodes that fully passed
  let conf = passed / total

  // Penalise replanning rounds
  conf -= replansCount * 0.07

  // Penalise skipped (skipped = recovered but not ideal)
  conf -= (skipped / total) * 0.10

  // Hard penalty for any failed required nodes
  if (failed > 0) conf -= 0.15

  // Bonus: prior learning hit means we had relevant experience
  if (learningHit) conf += 0.05

  // Agent selection confidence average
  const selConfs = [...agentSelections.values()].map(s => s.confidence || 0.7)
  if (selConfs.length) {
    const avgSelConf = selConfs.reduce((a, b) => a + b, 0) / selConfs.length
    conf = conf * 0.75 + avgSelConf * 0.25
  }

  return Math.round(Math.min(0.99, Math.max(0.01, conf)) * 100) / 100
}

function _riskLevel(run) {
  const { graph, request = '' } = run

  let riskScore = 0

  // LLM-planned risk (trust the planner's own assessment)
  if (run.plannerRiskLevel === 'high')   riskScore += 3
  if (run.plannerRiskLevel === 'medium') riskScore += 1

  // Request content signals
  const high_risk_terms = /delete|purchase|buy|pay|submit|send email|post|publish|transfer|overwrite|remove|reset password/i
  const med_risk_terms  = /fill|click|type|form|login|sign in|upload|download/i
  if (high_risk_terms.test(request)) riskScore += 3
  if (med_risk_terms.test(request))  riskScore += 1

  // Graph-based signals
  if (graph) {
    const nodes = [...graph.nodes.values()]
    const hasAutomate  = nodes.some(n => n.type === 'automate')
    const hasClickType = nodes.some(n => /click|type|fill|submit/i.test(n.description))
    if (hasAutomate)  riskScore += 2
    if (hasClickType) riskScore += 1
  }

  if (riskScore >= 5) return 'high'
  if (riskScore >= 2) return 'medium'
  return 'low'
}

function _qualityScore(run) {
  const { graph, finalResult = '', durationMs = 0, replansCount = 0 } = run

  if (!graph) return 0.5

  const nodes   = [...graph.nodes.values()]
  const total   = nodes.length
  const passed  = nodes.filter(n => n.state === 'completed').length

  // Completion ratio
  let quality = total > 0 ? passed / total : 0.5

  // Result richness: longer final result = more content produced
  const resultLen = typeof finalResult === 'string' ? finalResult.length : JSON.stringify(finalResult || '').length
  if (resultLen > 2000) quality += 0.10
  else if (resultLen > 500) quality += 0.05

  // Speed bonus (under 30s is fast for a multi-step task)
  if (durationMs > 0 && durationMs < 30000) quality += 0.05

  // Replan penalty
  quality -= replansCount * 0.05

  // Ensure terminal node produced meaningful output
  const terminalNode = _getTerminalNode(graph)
  if (terminalNode?.state !== 'completed') quality -= 0.15

  return Math.round(Math.min(0.99, Math.max(0.01, quality)) * 100) / 100
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _getTerminalNode(graph) {
  // Terminal = node with no outgoing dependents
  for (const [id, deps] of graph.reverse) {
    if (deps.size === 0) return graph.nodes.get(id)
  }
  return null
}

module.exports = { score }
