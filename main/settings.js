'use strict'
const fs   = require('fs')
const path = require('path')
const os   = require('os')

const OLD_DIR  = path.join(os.homedir(), '.strawberry')
const NEW_DIR  = path.join(os.homedir(), '.yantra')
const FILE     = path.join(NEW_DIR, 'settings.json')

// One-time migration: move .strawberry/settings.json → .yantra/settings.json
function migrateIfNeeded() {
  if (!fs.existsSync(NEW_DIR)) {
    fs.mkdirSync(NEW_DIR, { recursive: true })
    const oldFile = path.join(OLD_DIR, 'settings.json')
    if (fs.existsSync(oldFile) && !fs.existsSync(FILE)) {
      try { fs.copyFileSync(oldFile, FILE) } catch { /* ignore */ }
    }
  }
}

function load() {
  migrateIfNeeded()
  try   { return JSON.parse(fs.readFileSync(FILE, 'utf8')) }
  catch { return {} }
}

function persist(data) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true })
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2))
  } catch { /* ignore */ }
}

function getAll()        { return load() }
function get(key)        { return load()[key] }
function set(key, value) { const d = load(); d[key] = value; persist(d) }

module.exports = { getAll, get, set }
