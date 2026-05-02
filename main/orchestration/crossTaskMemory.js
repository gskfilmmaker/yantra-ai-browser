'use strict'
const fs     = require('fs')
const path   = require('path')
const os     = require('os')

const DIR  = path.join(os.homedir(), '.yantra')
const FILE = path.join(DIR, 'orchestration_memory.json')

// ── Cross-task memory ─────────────────────────────────────────────────────────
// Stores results shared between tasks within a single graph run (in-memory)
// AND persists completed graph summaries to disk for future reference.

class CrossTaskMemory {
  constructor(graphId) {
    this.graphId      = graphId
    this._store       = new Map()   // nodeId → result
    this._strategies  = new Map()   // nodeId → { agent, tool, confidence, nodeType }
    this._retryPatterns = []        // [{ failType, recovery, succeeded }]
  }

  // ── In-run result sharing ─────────────────────────────────────────────────

  set(nodeId, result) {
    this._store.set(nodeId, result)
  }

  get(nodeId) {
    return this._store.get(nodeId) ?? null
  }

  // Returns all accumulated results as a plain object
  snapshot() {
    const out = {}
    for (const [k, v] of this._store) out[k] = v
    return out
  }

  // ── Strategy storage (v5 cognitive layer) ─────────────────────────────────

  setStrategy(nodeId, strategy) {
    this._strategies.set(nodeId, strategy)
  }

  getStrategy(nodeId) {
    return this._strategies.get(nodeId) ?? null
  }

  getStrategies() {
    const out = {}
    for (const [k, v] of this._strategies) out[k] = v
    return out
  }

  addRetryPattern(pattern) {
    this._retryPatterns.push(pattern)
  }

  getRetryPatterns() {
    return [...this._retryPatterns]
  }

  // Full snapshot including strategies (for LLM context injection)
  cognitiveSnapshot() {
    return {
      results:    this.snapshot(),
      strategies: this.getStrategies(),
    }
  }

  // ── Cross-run persistence ─────────────────────────────────────────────────

  persist(graphSummary) {
    const db = _load()
    db[this.graphId] = {
      graphId:     this.graphId,
      request:     graphSummary.request  || '',
      template:    graphSummary.template || '',
      finalResult: graphSummary.finalResult || null,
      stepsTotal:  graphSummary.stepsTotal  || 0,
      stepsPassed: graphSummary.stepsPassed || 0,
      completedAt: new Date().toISOString(),
      durationMs:  graphSummary.durationMs  || 0,
      strategies:  this.getStrategies(),
      retryPatterns: this.getRetryPatterns(),
    }
    // Cap to 50 most recent graph runs
    const keys = Object.keys(db)
    if (keys.length > 50) {
      const oldest = keys.sort((a, b) =>
        (db[a].completedAt || '') < (db[b].completedAt || '') ? -1 : 1
      ).slice(0, keys.length - 50)
      for (const k of oldest) delete db[k]
    }
    _save(db)
  }

  // Return disk-persisted summary for this graphId (for status queries)
  static loadSummary(graphId) {
    const db = _load()
    return db[graphId] || null
  }

  // Return all recent summaries
  static listSummaries(limit = 20) {
    const db = _load()
    return Object.values(db)
      .sort((a, b) => (b.completedAt || '') > (a.completedAt || '') ? 1 : -1)
      .slice(0, limit)
  }
}

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

module.exports = { CrossTaskMemory }
