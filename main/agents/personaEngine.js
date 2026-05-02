'use strict'
const fs     = require('fs')
const path   = require('path')
const os     = require('os')
const crypto = require('crypto')

const DIR  = path.join(os.homedir(), '.yantra')
const FILE = path.join(DIR, 'personas.json')

// ── Persona Engine ────────────────────────────────────────────────────────────
// Persistent AI identities with behavioral memory, thinking styles, and
// accumulated experience. Each persona has:
//   - A name + avatar + personality description
//   - Preferred tools and communication style
//   - A memory of what it has learned across sessions
//   - Behavioral patterns (how it approaches different task types)
//
// Personas layer on top of the agent system — a persona wraps an agent with
// a persistent identity and long-term behavioral memory.

// ── Default personas ──────────────────────────────────────────────────────────

const DEFAULT_PERSONAS = [
  {
    id:          'genius-gsk',
    name:        'Genius GSK',
    avatar:      '🧠',
    description: 'A highly analytical and creative thinker. Approaches every problem with first-principles reasoning. Combines deep technical knowledge with strategic vision. Prefers concise, insight-dense responses.',
    thinkingStyle: 'first_principles',
    communicationStyle: 'concise_insightful',
    preferredAgents: ['Master Orchestrator', 'Engineering', 'Deep Research'],
    preferredTools:  ['web_search', 'cogitate', 'generateReport'],
    systemPromptAddition: `You are thinking as Genius GSK — a visionary technologist who combines deep technical expertise with strategic business thinking. You break problems down to first principles, identify non-obvious connections, and communicate insights with precision and clarity. You prefer action over analysis paralysis.`,
    memory:        [],
    taskHistory:   [],
    learnedPatterns: {},
    createdAt:     new Date().toISOString(),
    usageCount:    0,
  },
]

// ── Public API ────────────────────────────────────────────────────────────────

function list() {
  const db = _load()
  return Object.values(db).map(_safeEntry)
}

function get(idOrName) {
  const db = _load()
  return Object.values(db).find(p =>
    p.id === idOrName || p.name.toLowerCase() === idOrName.toLowerCase()
  ) || null
}

function create(config) {
  const db  = _load()
  const id  = `persona_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`
  const now = new Date().toISOString()
  const persona = {
    id,
    name:                config.name,
    avatar:              config.avatar || '🤖',
    description:         config.description || '',
    thinkingStyle:       config.thinkingStyle || 'balanced',
    communicationStyle:  config.communicationStyle || 'detailed',
    preferredAgents:     config.preferredAgents || ['Master Orchestrator'],
    preferredTools:      config.preferredTools  || [],
    systemPromptAddition: config.systemPromptAddition || `You are ${config.name}. ${config.description}`,
    memory:           [],
    taskHistory:      [],
    learnedPatterns:  {},
    createdAt:        now,
    usageCount:       0,
  }
  db[id] = persona
  _save(db)
  return id
}

function update(id, partial) {
  const db = _load()
  if (!db[id]) return false
  Object.assign(db[id], partial, { id })
  _save(db)
  return true
}

function remove(id) {
  const db = _load()
  if (!db[id]) return false
  delete db[id]
  _save(db)
  return true
}

// Record something the persona learned from a task
function learn(id, insight) {
  const db = _load()
  if (!db[id]) return false
  const p = db[id]
  p.memory.push({ insight: insight.slice(0, 300), learnedAt: new Date().toISOString() })
  if (p.memory.length > 100) p.memory = p.memory.slice(-100)
  _save(db)
  return true
}

// Record a completed task in the persona's history
function recordTask(id, task) {
  const db = _load()
  if (!db[id]) return false
  const p = db[id]
  p.usageCount++
  p.taskHistory.push({
    request:      (task.request || '').slice(0, 120),
    result:       (task.result  || '').slice(0, 200),
    quality:      task.qualityScore || 0,
    completedAt:  new Date().toISOString(),
  })
  if (p.taskHistory.length > 50) p.taskHistory = p.taskHistory.slice(-50)

  // Update learned patterns
  if (task.templateName) {
    p.learnedPatterns[task.templateName] = (p.learnedPatterns[task.templateName] || 0) + 1
  }

  _save(db)
  return true
}

// Build the system prompt addition for the active persona
function buildSystemPrompt(id) {
  const db = _load()
  const p  = db[id]
  if (!p) return ''

  const memoryContext = p.memory.slice(-5).map(m => `- ${m.insight}`).join('\n')
  const patterns      = Object.entries(p.learnedPatterns)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k]) => k)
    .join(', ')

  return [
    p.systemPromptAddition,
    memoryContext ? `\nYour accumulated knowledge:\n${memoryContext}` : '',
    patterns ? `\nYour most-used workflow patterns: ${patterns}` : '',
  ].filter(Boolean).join('\n')
}

// Get persona insights summary
function getInsights(id) {
  const p = get(id)
  if (!p) return null
  return {
    name:             p.name,
    avatar:           p.avatar,
    usageCount:       p.usageCount,
    memoryCount:      p.memory.length,
    topPatterns:      Object.entries(p.learnedPatterns).sort((a, b) => b[1] - a[1]).slice(0, 5),
    recentMemory:     p.memory.slice(-5).map(m => m.insight),
    recentTasks:      p.taskHistory.slice(-3).map(t => ({ request: t.request, quality: t.quality })),
    avgQuality:       p.taskHistory.length
      ? Math.round(p.taskHistory.reduce((s, t) => s + (t.quality || 0), 0) / p.taskHistory.length * 100)
      : 0,
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _safeEntry(p) {
  return {
    id:                  p.id,
    name:                p.name,
    avatar:              p.avatar,
    description:         p.description,
    thinkingStyle:       p.thinkingStyle,
    communicationStyle:  p.communicationStyle,
    preferredAgents:     p.preferredAgents,
    usageCount:          p.usageCount || 0,
    memoryCount:         (p.memory || []).length,
    createdAt:           p.createdAt,
  }
}

function _load() {
  try {
    if (!fs.existsSync(FILE)) {
      // Seed defaults
      const db = {}
      for (const p of DEFAULT_PERSONAS) db[p.id] = p
      return db
    }
    const db = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    // Ensure defaults exist
    for (const p of DEFAULT_PERSONAS) {
      if (!db[p.id]) db[p.id] = p
    }
    return db
  } catch { return {} }
}

function _save(db) {
  try {
    fs.mkdirSync(DIR, { recursive: true })
    fs.writeFileSync(FILE, JSON.stringify(db, null, 2))
  } catch { /* non-fatal */ }
}

module.exports = { list, get, create, update, remove, learn, recordTask, buildSystemPrompt, getInsights }
