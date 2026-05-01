'use strict'
const fs   = require('fs')
const path = require('path')
const os   = require('os')

const DIR  = path.join(os.homedir(), '.yantra')
const FILE = path.join(DIR, 'routines.json')

function ensureDir() {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true })
}

function load() {
  ensureDir()
  if (!fs.existsSync(FILE)) {
    const old = path.join(os.homedir(), '.strawberry', 'routines.json')
    if (fs.existsSync(old)) {
      try { fs.copyFileSync(old, FILE) } catch { return [] }
    } else {
      return []
    }
  }
  try   { return JSON.parse(fs.readFileSync(FILE, 'utf8')) }
  catch { return [] }
}

function persist(routines) {
  ensureDir()
  fs.writeFileSync(FILE, JSON.stringify(routines, null, 2))
}

function listRoutines()   { return load() }
function getRoutine(id)   { return load().find(r => r.id === id) || null }

function createRoutine(config) {
  if (!config.name) throw new Error('Routine name is required')
  const r = {
    id:      `routine-${Date.now()}`,
    enabled: true,
    trigger: { type: 'manual' },
    actions: [],
    ...config,
  }
  const all = load(); all.push(r); persist(all)
  return r
}

function updateRoutine(id, partial) {
  const all = load()
  const idx = all.findIndex(r => r.id === id)
  if (idx === -1) throw new Error(`Routine "${id}" not found`)
  all[idx] = { ...all[idx], ...partial }
  persist(all)
  return all[idx]
}

function deleteRoutine(id) { persist(load().filter(r => r.id !== id)) }

async function runRoutine(id, ctx = {}) {
  const routine = getRoutine(id)
  if (!routine)          return `Routine "${id}" not found.`
  if (!routine.enabled)  return `Routine "${routine.name}" is disabled.`
  if (!routine.actions?.length) return `Routine "${routine.name}" has no actions configured.`

  const registry = require('../tools/registry')
  const results  = []

  for (const action of routine.actions) {
    const result = await registry.execute(action.tool, action.params || {}, ctx)
    results.push(`**${action.tool}**\n${result.slice(0, 400)}`)
  }

  const summary = `Routine **${routine.name}** completed (${routine.actions.length} actions):\n\n${results.join('\n\n---\n\n')}`

  require('../memoryStore').save({
    type: 'routine_run', title: `Routine: ${routine.name}`,
    result: summary.slice(0, 600), routineId: id,
  })

  return summary
}

function evaluateTriggers(event) {
  return load().filter(r => {
    if (!r.enabled) return false
    const t = r.trigger
    if (t.type === 'manual') return false

    const matches = (t.type === event.type)
    if (!matches) return false
    if (!t.urlPattern) return true

    try { return new RegExp(t.urlPattern, 'i').test(event.url || '') }
    catch { return false }
  })
}

module.exports = {
  listRoutines, getRoutine, createRoutine, updateRoutine, deleteRoutine,
  runRoutine, evaluateTriggers,
}
