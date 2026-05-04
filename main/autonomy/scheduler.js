'use strict'
const fs   = require('fs')
const path = require('path')
const os   = require('os')

const DIR  = path.join(os.homedir(), '.yantra')
const FILE = path.join(DIR, 'schedules.json')

// ── Scheduler ─────────────────────────────────────────────────────────────────
// Runs autonomous agent tasks on a time-based schedule.
// Supports human-readable intervals: "5m", "1h", "daily", "12h", etc.
// Schedules survive app restarts (persisted to disk).

let _win        = null
let _timers     = new Map()   // scheduleId → NodeJS.Timer
let _onTask     = null        // callback(schedule) → runs the task

// ── Public API ────────────────────────────────────────────────────────────────

function init(win, onTaskFn) {
  _win    = win
  _onTask = onTaskFn
  _restoreAll()
}

function schedule(name, interval, request, opts = {}) {
  const id  = `sched_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
  const ms  = _parseInterval(interval)
  if (!ms) throw new Error(`Invalid interval: "${interval}". Use e.g. "5m", "1h", "daily", "30s"`)

  const entry = {
    id,
    name,
    interval,
    intervalMs: ms,
    request,
    agentHint:  opts.agentHint || null,
    runCount:   0,
    lastRun:    null,
    nextRun:    new Date(Date.now() + ms).toISOString(),
    enabled:    true,
    createdAt:  new Date().toISOString(),
    runImmediately: opts.runImmediately || false,
  }

  _save(entry)
  _startTimer(entry)

  if (opts.runImmediately) {
    setTimeout(() => _runSchedule(entry), 1000)
  }

  return id
}

function cancel(id) {
  const schedules = _loadAll()
  const entry = schedules[id]
  if (!entry) return false

  const timer = _timers.get(id)
  if (timer) { clearInterval(timer); _timers.delete(id) }

  delete schedules[id]
  _saveAll(schedules)
  return true
}

function pause(id) {
  const schedules = _loadAll()
  if (!schedules[id]) return false
  schedules[id].enabled = false
  _saveAll(schedules)
  const timer = _timers.get(id)
  if (timer) { clearInterval(timer); _timers.delete(id) }
  return true
}

function resume(id) {
  const schedules = _loadAll()
  if (!schedules[id]) return false
  schedules[id].enabled = true
  _saveAll(schedules)
  _startTimer(schedules[id])
  return true
}

function list() {
  return Object.values(_loadAll()).map(e => ({
    id:         e.id,
    name:       e.name,
    interval:   e.interval,
    request:    e.request.slice(0, 80),
    runCount:   e.runCount,
    lastRun:    e.lastRun,
    nextRun:    e.nextRun,
    enabled:    e.enabled,
    createdAt:  e.createdAt,
  }))
}

// ── Internal ──────────────────────────────────────────────────────────────────

function _startTimer(entry) {
  if (!entry.enabled) return
  const timer = setInterval(() => _runSchedule(entry), entry.intervalMs)
  _timers.set(entry.id, timer)
}

async function _runSchedule(entry) {
  const schedules = _loadAll()
  if (!schedules[entry.id]?.enabled) return

  schedules[entry.id].runCount++
  schedules[entry.id].lastRun = new Date().toISOString()
  schedules[entry.id].nextRun = new Date(Date.now() + entry.intervalMs).toISOString()
  _saveAll(schedules)

  // Notify renderer of schedule fire
  if (_win && !_win.isDestroyed()) {
    _win.webContents.send('autonomy-event', {
      type:       'schedule_fire',
      scheduleId: entry.id,
      name:       entry.name,
      request:    entry.request,
    })
  }

  // Run the task via registered callback
  if (_onTask) {
    try {
      const result = await _onTask(entry)
      if (_win && !_win.isDestroyed()) {
        _win.webContents.send('autonomy-event', {
          type:       'schedule_done',
          scheduleId: entry.id,
          name:       entry.name,
          result:     typeof result === 'string' ? result.slice(0, 500) : result,
        })
      }
    } catch (e) {
      if (_win && !_win.isDestroyed()) {
        _win.webContents.send('autonomy-event', {
          type:  'schedule_error',
          scheduleId: entry.id,
          error: e.message,
        })
      }
    }
  }
}

function _restoreAll() {
  const schedules = _loadAll()
  for (const entry of Object.values(schedules)) {
    if (entry.enabled) _startTimer(entry)
  }
}

// ── Interval parser ───────────────────────────────────────────────────────────
// Accepts: "30s", "5m", "2h", "daily", "12h", "1d"

function _parseInterval(str) {
  if (!str) return null
  const s = str.trim().toLowerCase()
  if (s === 'daily' || s === '1d' || s === 'day') return 24 * 60 * 60 * 1000
  const match = s.match(/^(\d+(?:\.\d+)?)\s*(s|sec|m|min|h|hr|hour|d|day)s?$/)
  if (!match) return null
  const n   = parseFloat(match[1])
  const unit = match[2][0]
  const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000 }
  return Math.round(n * (multipliers[unit] || 60000))
}

// ── Persistence ───────────────────────────────────────────────────────────────

function _save(entry) {
  const db = _loadAll()
  db[entry.id] = entry
  _saveAll(db)
}

function _loadAll() {
  try {
    if (!fs.existsSync(FILE)) return {}
    return JSON.parse(fs.readFileSync(FILE, 'utf8'))
  } catch { return {} }
}

function _saveAll(db) {
  try {
    fs.mkdirSync(DIR, { recursive: true })
    fs.writeFileSync(FILE, JSON.stringify(db, null, 2))
  } catch { /* non-fatal */ }
}

module.exports = { init, schedule, cancel, pause, resume, list }
