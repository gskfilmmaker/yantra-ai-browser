'use strict'
const fs     = require('fs')
const path   = require('path')
const os     = require('os')
const crypto = require('crypto')

const DIR  = path.join(os.homedir(), '.yantra')
const FILE = path.join(DIR, 'cognitive_memory.json')

// ── Learning Layer ────────────────────────────────────────────────────────────
// Stores successful workflows, selector strategies, and retry patterns.
// Surfaces relevant prior experience to the LLM planner for better decisions.
//
// Schema per entry:
//   key                 — SHA-256(intent fingerprint).slice(16)
//   intentSample        — first 120 chars of original request
//   templateName        — workflow template used (llm_planned | research_and_report | etc.)
//   nodeTypes           — ordered list of node types (e.g. ['plan','research','report'])
//   agentSelections     — { nodeType → { agent, tool, confidence } }
//   selectorStrategies  — { stepId → { selector, method, site, confidence } }
//   retryPatterns       — [{ failType, recovery, successCount, failCount }]
//   qualityScore        — last observed quality (0-1)
//   usageCount          — total times this entry was used
//   successCount        — times the full workflow completed
//   lastUsed            — ISO timestamp
//   createdAt           — ISO timestamp

// ── Public API ────────────────────────────────────────────────────────────────

function computeKey(request) {
  const fingerprint = request.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim().slice(0, 200)
  return crypto.createHash('sha256').update(fingerprint).digest('hex').slice(0, 16)
}

function lookup(key) {
  const db = _load()
  return db[key] || null
}

// Surface a short learning hint string for the LLM planner
function getLearningHint(key) {
  const entry = lookup(key)
  if (!entry) return ''

  const lines = [
    `Similar past workflow: ${entry.templateName} (${entry.nodeTypes.join(' → ')})`,
    `Success rate: ${entry.usageCount ? Math.round(entry.successCount / entry.usageCount * 100) : 0}%`,
    `Quality: ${Math.round((entry.qualityScore || 0) * 100)}%`,
  ]

  const topAgents = Object.entries(entry.agentSelections || {})
    .map(([type, sel]) => `${type}→${sel.agent}(${Math.round((sel.confidence || 0) * 100)}%)`)
    .slice(0, 4)
  if (topAgents.length) lines.push(`Agent selections: ${topAgents.join(', ')}`)

  const goodRetries = (entry.retryPatterns || [])
    .filter(p => p.successCount > p.failCount)
    .map(p => `${p.failType}→${p.recovery}`)
    .slice(0, 3)
  if (goodRetries.length) lines.push(`Effective recoveries: ${goodRetries.join(', ')}`)

  return lines.join('. ')
}

// Record the outcome of a completed cognitive run
function record(key, entry) {
  const db  = _load()
  const now = new Date().toISOString()
  const existing = db[key] || {
    key,
    intentSample:       entry.request?.slice(0, 120) || '',
    templateName:       entry.templateName || 'unknown',
    nodeTypes:          [],
    agentSelections:    {},
    selectorStrategies: {},
    retryPatterns:      [],
    qualityScore:       0,
    usageCount:         0,
    successCount:       0,
    createdAt:          now,
  }

  existing.usageCount++
  existing.lastUsed    = now
  existing.templateName = entry.templateName || existing.templateName

  // Update node type sequence
  if (Array.isArray(entry.nodeTypes) && entry.nodeTypes.length) {
    existing.nodeTypes = entry.nodeTypes
  }

  // Merge agent selections (running average confidence)
  for (const [nodeType, sel] of Object.entries(entry.agentSelections || {})) {
    const prev = existing.agentSelections[nodeType]
    if (!prev || sel.confidence > prev.confidence) {
      existing.agentSelections[nodeType] = sel
    }
  }

  // Merge selector strategies
  for (const [stepId, strat] of Object.entries(entry.selectorStrategies || {})) {
    existing.selectorStrategies[stepId] = strat
    // Cap at 50 selectors
    const keys = Object.keys(existing.selectorStrategies)
    if (keys.length > 50) delete existing.selectorStrategies[keys[0]]
  }

  // Merge retry patterns
  for (const pattern of (entry.retryPatterns || [])) {
    const existing_pattern = existing.retryPatterns.find(
      p => p.failType === pattern.failType && p.recovery === pattern.recovery
    )
    if (existing_pattern) {
      if (pattern.succeeded) existing_pattern.successCount++
      else existing_pattern.failCount++
    } else {
      existing.retryPatterns.push({
        failType:     pattern.failType,
        recovery:     pattern.recovery,
        successCount: pattern.succeeded ? 1 : 0,
        failCount:    pattern.succeeded ? 0 : 1,
      })
    }
    // Cap at 30 patterns
    if (existing.retryPatterns.length > 30) existing.retryPatterns.shift()
  }

  // Update quality score (exponential moving average)
  if (typeof entry.qualityScore === 'number') {
    existing.qualityScore = existing.usageCount === 1
      ? entry.qualityScore
      : Math.round((existing.qualityScore * 0.7 + entry.qualityScore * 0.3) * 100) / 100
  }

  if (entry.completed) existing.successCount++

  db[key] = existing

  // Cap database at 200 entries (remove oldest)
  const allKeys = Object.keys(db).sort((a, b) =>
    (db[a].lastUsed || '') < (db[b].lastUsed || '') ? -1 : 1
  )
  if (allKeys.length > 200) {
    for (const old of allKeys.slice(0, allKeys.length - 200)) delete db[old]
  }

  _save(db)
}

// Return best known selector strategy for a given site + step type
function getBestSelector(site, stepType) {
  const db = _load()
  let best = null
  for (const entry of Object.values(db)) {
    const strat = entry.selectorStrategies?.[stepType]
    if (strat?.site === site && (!best || strat.confidence > best.confidence)) {
      best = strat
    }
  }
  return best
}

// Return best retry recovery for a given failure type
function getBestRecovery(failType) {
  const db = _load()
  const tally = {}
  for (const entry of Object.values(db)) {
    for (const p of (entry.retryPatterns || [])) {
      if (p.failType !== failType) continue
      if (!tally[p.recovery]) tally[p.recovery] = { success: 0, fail: 0 }
      tally[p.recovery].success += p.successCount
      tally[p.recovery].fail    += p.failCount
    }
  }
  let best = null, bestRate = -1
  for (const [recovery, counts] of Object.entries(tally)) {
    const total = counts.success + counts.fail
    if (!total) continue
    const rate = counts.success / total
    if (rate > bestRate) { bestRate = rate; best = recovery }
  }
  return best ? { recovery: best, successRate: bestRate } : null
}

// ── Persistence ───────────────────────────────────────────────────────────────

function _load() {
  try {
    if (!fs.existsSync(FILE)) return {}
    return JSON.parse(fs.readFileSync(FILE, 'utf8'))
  } catch { return {} }
}

function _save(db) {
  try {
    fs.mkdirSync(DIR, { recursive: true })
    fs.writeFileSync(FILE, JSON.stringify(db, null, 2))
  } catch { /* non-fatal */ }
}

module.exports = { computeKey, lookup, getLearningHint, record, getBestSelector, getBestRecovery }
