'use strict'
const fs   = require('fs')
const path = require('path')
const os   = require('os')

const FILE = path.join(os.homedir(), '.strawberry', 'settings.json')

function load() {
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
