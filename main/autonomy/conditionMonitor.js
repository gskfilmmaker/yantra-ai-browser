'use strict'
const fs   = require('fs')
const path = require('path')
const os   = require('os')

const DIR  = path.join(os.homedir(), '.yantra')
const FILE = path.join(DIR, 'monitors.json')

// ── Condition Monitor ─────────────────────────────────────────────────────────
// Watches a URL at a given interval. Fires a callback when the page content
// changes or a specific condition becomes true (element present, text appears,
// value crosses a threshold, etc.).
//
// Condition types:
//   text_appears    — page body contains this text
//   text_disappears — page body no longer contains this text
//   element_present — CSS selector appears
//   element_absent  — CSS selector disappears
//   any_change      — any significant DOM/text change

let _win      = null
let _timers   = new Map()   // monitorId → NodeJS.Timer
let _snapshots = new Map()  // monitorId → last page snapshot text

// ── Public API ────────────────────────────────────────────────────────────────

function init(win) {
  _win = win
  _restoreAll()
}

function watch(name, url, condition, interval = '5m', opts = {}) {
  const id = `mon_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
  const ms = _parseInterval(interval)
  if (!ms) throw new Error(`Invalid interval: "${interval}"`)

  const entry = {
    id,
    name,
    url,
    condition,    // { type, value }
    interval,
    intervalMs: ms,
    onTrigger: opts.onTrigger || null,   // cogitate request to run on trigger
    triggerCount: 0,
    lastChecked:  null,
    lastTriggered: null,
    enabled:  true,
    createdAt: new Date().toISOString(),
  }

  _save(entry)
  _startTimer(entry)
  return id
}

function cancel(id) {
  const db = _loadAll()
  if (!db[id]) return false
  const t = _timers.get(id)
  if (t) { clearInterval(t); _timers.delete(id) }
  delete db[id]
  _saveAll(db)
  return true
}

function list() {
  return Object.values(_loadAll()).map(e => ({
    id:            e.id,
    name:          e.name,
    url:           e.url,
    condition:     e.condition,
    interval:      e.interval,
    triggerCount:  e.triggerCount,
    lastChecked:   e.lastChecked,
    lastTriggered: e.lastTriggered,
    enabled:       e.enabled,
  }))
}

// ── Internal ──────────────────────────────────────────────────────────────────

function _startTimer(entry) {
  if (!entry.enabled) return
  const timer = setInterval(() => _check(entry), entry.intervalMs)
  _timers.set(entry.id, timer)
}

async function _check(entry) {
  const db = _loadAll()
  if (!db[entry.id]?.enabled) return

  db[entry.id].lastChecked = new Date().toISOString()
  _saveAll(db)

  // Fetch the page text via Node.js (no browser required for simple checks)
  let pageText = ''
  try {
    const { fetch_webpage_text } = require('./pageTextFetcher')
    pageText = await fetch_webpage_text(entry.url)
  } catch {
    try {
      const https = require('https')
      const http  = require('http')
      const mod   = entry.url.startsWith('https') ? https : http
      pageText    = await new Promise((resolve, reject) => {
        mod.get(entry.url, { timeout: 10000 }, res => {
          let data = ''
          res.on('data', c => { data += c })
          res.on('end', () => resolve(data))
        }).on('error', reject)
      })
    } catch { return }
  }

  const triggered = _evaluateCondition(entry.condition, pageText, _snapshots.get(entry.id) || '')
  _snapshots.set(entry.id, pageText)

  if (triggered) {
    db[entry.id].triggerCount++
    db[entry.id].lastTriggered = new Date().toISOString()
    _saveAll(db)

    if (_win && !_win.isDestroyed()) {
      _win.webContents.send('autonomy-event', {
        type:      'monitor_triggered',
        monitorId: entry.id,
        name:      entry.name,
        url:       entry.url,
        condition: entry.condition,
        onTrigger: entry.onTrigger,
      })
    }
  }
}

function _evaluateCondition(condition, current, previous) {
  if (!condition) return false
  const { type, value = '' } = condition
  switch (type) {
    case 'text_appears':    return current.includes(value) && !previous.includes(value)
    case 'text_disappears': return !current.includes(value) && previous.includes(value)
    case 'any_change':      return previous.length > 0 && _significantChange(current, previous)
    case 'element_present': // Can't check CSS selectors without browser; fall through
    case 'element_absent':
    default:
      return false
  }
}

function _significantChange(a, b) {
  if (!a || !b) return false
  const aWords = new Set(a.toLowerCase().split(/\s+/).slice(0, 500))
  const bWords = new Set(b.toLowerCase().split(/\s+/).slice(0, 500))
  let common = 0
  for (const w of aWords) { if (bWords.has(w)) common++ }
  const similarity = (2 * common) / (aWords.size + bWords.size)
  return similarity < 0.90   // >10% change = significant
}

function _parseInterval(str) {
  if (!str) return null
  const s = str.trim().toLowerCase()
  if (s === 'daily') return 86400000
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d)/)
  if (!m) return null
  const mul = { s: 1000, m: 60000, h: 3600000, d: 86400000 }
  return Math.round(parseFloat(m[1]) * (mul[m[2]] || 60000))
}

function _restoreAll() {
  for (const entry of Object.values(_loadAll())) {
    if (entry.enabled) _startTimer(entry)
  }
}

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

module.exports = { init, watch, cancel, list }
