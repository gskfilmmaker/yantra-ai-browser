'use strict'
const fs = require('fs')
const path = require('path')
const os = require('os')

const DIR = path.join(os.homedir(), '.strawberry')
const FILE = path.join(DIR, 'memory.json')

function ensureDir() {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true })
}

function load() {
  ensureDir()
  if (!fs.existsSync(FILE)) return []
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

module.exports = { save, getHistory }
