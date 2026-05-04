'use strict'
const fs = require('fs')
const path = require('path')
const os = require('os')

const DIR  = path.join(os.homedir(), '.yantra')
const FILE = path.join(DIR, 'memory.json')

function ensureDir() {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true })
}

function load() {
  ensureDir()
  if (!fs.existsSync(FILE)) {
    // Migrate from .strawberry if present
    const old = path.join(os.homedir(), '.strawberry', 'memory.json')
    if (fs.existsSync(old)) {
      try { fs.copyFileSync(old, FILE) } catch { return [] }
    } else {
      return []
    }
  }
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch { return [] }
}

function save(entry) {
  const items = load()
  const record = { ...entry, id: Date.now(), timestamp: new Date().toISOString() }
  items.unshift(record)
  if (items.length > 500) items.splice(500)
  ensureDir()
  fs.writeFileSync(FILE, JSON.stringify(items, null, 2))
  return record
}

function getHistory(limit = 50) {
  return load().slice(0, limit)
}

function search(query) {
  if (!query) return 'No query provided.'
  const q = query.toLowerCase()
  const matches = load().filter(item =>
    JSON.stringify(item).toLowerCase().includes(q)
  ).slice(0, 8)
  if (!matches.length) return `No memory found matching "${query}".`
  return matches
    .map(i => `**${i.title || i.type}** (${(i.timestamp || '').slice(0, 10)})\n${(i.result || '').slice(0, 300)}`)
    .join('\n\n---\n\n')
}

function getAll() { return load() }

function deleteEntry(id) {
  const items = load().filter(i => String(i.id) !== String(id))
  ensureDir()
  fs.writeFileSync(FILE, JSON.stringify(items, null, 2))
}

module.exports = { save, getHistory, getAll, deleteEntry, search }
