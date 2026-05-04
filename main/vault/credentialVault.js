'use strict'
const fs     = require('fs')
const path   = require('path')
const os     = require('os')
const crypto = require('crypto')

const DIR  = path.join(os.homedir(), '.yantra')
const FILE = path.join(DIR, 'vault.json')

// ── Credential Vault ──────────────────────────────────────────────────────────
// Encrypts credentials using Electron's safeStorage (OS keychain on Mac/Win).
// Falls back to AES-256-GCM with a machine-derived key when safeStorage is
// unavailable (e.g. running headless in tests).
//
// Stored per entry: { id, domain, username, encryptedPassword, notes, createdAt }

// ── Encryption layer ──────────────────────────────────────────────────────────

function _encrypt(plaintext) {
  try {
    const { safeStorage } = require('electron')
    if (safeStorage.isEncryptionAvailable()) {
      return { mode: 'safe', data: safeStorage.encryptString(plaintext).toString('base64') }
    }
  } catch { /* not in Electron context */ }
  // AES-256-GCM fallback
  const key = _machineKey()
  const iv  = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const enc  = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag  = cipher.getAuthTag()
  return {
    mode: 'aes',
    data: Buffer.concat([iv, tag, enc]).toString('base64'),
  }
}

function _decrypt(stored) {
  if (stored.mode === 'safe') {
    try {
      const { safeStorage } = require('electron')
      return safeStorage.decryptString(Buffer.from(stored.data, 'base64'))
    } catch { return null }
  }
  // AES-256-GCM fallback
  try {
    const key  = _machineKey()
    const buf  = Buffer.from(stored.data, 'base64')
    const iv   = buf.slice(0, 12)
    const tag  = buf.slice(12, 28)
    const enc  = buf.slice(28)
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    return decipher.update(enc) + decipher.final('utf8')
  } catch { return null }
}

function _machineKey() {
  // Machine-stable key derived from hostname + username
  const seed = `yantra-vault-${os.hostname()}-${os.userInfo().username}`
  return crypto.createHash('sha256').update(seed).digest()
}

// ── Public API ────────────────────────────────────────────────────────────────

function save(domain, username, password, notes = '') {
  const db  = _load()
  const id  = `${_domainKey(domain)}_${Date.now()}`
  const now = new Date().toISOString()

  // Replace existing entry for same domain+username
  const existingIdx = db.findIndex(e => e.domain === _domainKey(domain) && e.username === username)
  const entry = {
    id,
    domain:            _domainKey(domain),
    domainRaw:         domain,
    username,
    encryptedPassword: _encrypt(password),
    notes,
    createdAt: now,
    updatedAt: now,
  }

  if (existingIdx >= 0) {
    entry.id        = db[existingIdx].id
    entry.createdAt = db[existingIdx].createdAt
    db[existingIdx] = entry
  } else {
    db.push(entry)
  }

  _saveDB(db)
  return entry.id
}

function get(domain) {
  const db = _load()
  const entries = db.filter(e => e.domain === _domainKey(domain))
  return entries.map(e => ({
    id:        e.id,
    domain:    e.domainRaw || e.domain,
    username:  e.username,
    password:  _decrypt(e.encryptedPassword) || '',
    notes:     e.notes || '',
    createdAt: e.createdAt,
  }))
}

function list() {
  const db = _load()
  return db.map(e => ({
    id:       e.id,
    domain:   e.domainRaw || e.domain,
    username: e.username,
    notes:    e.notes || '',
    // Never expose password in list
  }))
}

function remove(id) {
  const db = _load()
  const filtered = db.filter(e => e.id !== id)
  _saveDB(filtered)
  return filtered.length < db.length
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _domainKey(raw) {
  try {
    const u = new URL(raw.startsWith('http') ? raw : `https://${raw}`)
    return u.hostname.replace(/^www\./, '')
  } catch { return raw.toLowerCase().trim() }
}

function _load() {
  try {
    if (!fs.existsSync(FILE)) return []
    return JSON.parse(fs.readFileSync(FILE, 'utf8'))
  } catch { return [] }
}

function _saveDB(db) {
  try {
    fs.mkdirSync(DIR, { recursive: true })
    fs.writeFileSync(FILE, JSON.stringify(db, null, 2))
  } catch { /* non-fatal */ }
}

module.exports = { save, get, list, remove }
