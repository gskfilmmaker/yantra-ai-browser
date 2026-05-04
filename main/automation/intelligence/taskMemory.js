'use strict'
const fs     = require('fs')
const path   = require('path')
const os     = require('os')
const crypto = require('crypto')

const DIR  = path.join(os.homedir(), '.yantra')
const FILE = path.join(DIR, 'task_memory.json')

// ── Persistence helpers ───────────────────────────────────────────────────────

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

// ── Key derivation ────────────────────────────────────────────────────────────
// Key = hash of (domain + step-type fingerprint).
// This groups tasks by SITE + STRUCTURE regardless of exact content,
// so learned selector patterns transfer across similar future runs.

function computeKey(task, currentUrl) {
  const domain      = _extractDomain(currentUrl || '')
  const fingerprint = task.steps.map(s =>
    s.type + ':' + (s.params?.selector || s.params?.text || s.params?.url || '')
  ).join('|')
  const raw = `${domain}::${task.name || ''}::${fingerprint}`
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16)
}

// ── Public API ────────────────────────────────────────────────────────────────

// Look up stored patterns for this task + URL combination.
// Returns null if nothing useful is in memory.
function lookup(key) {
  const db = _load()
  return db[key] || null
}

// Persist the outcome of a completed task.
// entry.key        — memory key from computeKey()
// entry.task       — original task object
// entry.passedIds  — Set of step IDs that passed
// entry.failedIds  — Set of step IDs that failed
// entry.adjustments — array of { type, step, from, to, ... } plan adjustments
// entry.durationMs — total task duration
// entry.finalState — 'completed' | 'failed' | 'aborted'
function record(key, entry) {
  const db  = _load()
  const now = new Date().toISOString()
  const existing = db[key] || {
    key,
    domain:             _extractDomain(entry.url || ''),
    taskName:           entry.task?.name || '',
    stepFingerprint:    entry.task?.steps?.map(s => s.type).join(',') || '',
    usageCount:         0,
    successCount:       0,
    totalDurationMs:    0,
    successfulSelectors:{},
    failurePatterns:    [],
    sitePatterns:       {},
    createdAt:          now,
  }

  existing.usageCount++
  existing.lastUsed  = now
  existing.totalDurationMs += (entry.durationMs || 0)
  existing.avgDurationMs   = Math.round(existing.totalDurationMs / existing.usageCount)

  if (entry.finalState === 'completed') existing.successCount++
  existing.lastResult = entry.finalState

  // ── Learn successful selectors ────────────────────────────────────────────
  for (const adj of (entry.adjustments || [])) {
    if (adj.type === 'selector_updated' && adj.passed) {
      existing.successfulSelectors[adj.stepId] = {
        selector:   adj.to,
        method:     adj.method || 'unknown',
        confidence: adj.confidence || 0.8,
        learnedAt:  now,
      }
    }
  }

  // ── Learn failure patterns ────────────────────────────────────────────────
  for (const adj of (entry.adjustments || [])) {
    if (adj.type === 'replan') {
      existing.failurePatterns = [
        { stepType: adj.stepType, errorPattern: adj.reason, resolution: adj.resolution, ts: now },
        ...existing.failurePatterns,
      ].slice(0, 20) // cap at 20 recent patterns
    }
  }

  // ── Learn site-level signals ──────────────────────────────────────────────
  if (entry.hadCaptcha) {
    existing.sitePatterns.captchaDetected = true
    existing.sitePatterns.captchaLastSeen = now
  }

  db[key] = existing
  _save(db)
}

// Apply known-good selectors from memory to augment the task steps.
// Returns: { steps: augmentedSteps, appliedCount: number }
function applyMemoryPatterns(task, memoryEntry) {
  if (!memoryEntry?.successfulSelectors) return { steps: task.steps, appliedCount: 0 }

  let applied = 0
  const steps = task.steps.map(s => {
    const known = memoryEntry.successfulSelectors[s.id]
    if (!known) return s
    if (['click', 'type'].includes(s.type) && known.selector) {
      applied++
      return { ...s, params: { ...s.params, selector: known.selector }, _memoryAugmented: true }
    }
    return s
  })

  return { steps, appliedCount: applied }
}

// Return a summary for logging
function summarize(key) {
  const entry = lookup(key)
  if (!entry) return null
  return {
    key,
    domain:       entry.domain,
    taskName:     entry.taskName,
    usageCount:   entry.usageCount,
    successRate:  entry.usageCount ? Math.round(entry.successCount / entry.usageCount * 100) : 0,
    avgDurationMs: entry.avgDurationMs,
    knownSelectors: Object.keys(entry.successfulSelectors || {}).length,
    lastUsed:     entry.lastUsed,
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _extractDomain(url) {
  try { return new URL(url).hostname } catch { return 'unknown' }
}

module.exports = { computeKey, lookup, record, applyMemoryPatterns, summarize }
