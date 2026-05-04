'use strict'
const fs   = require('fs')
const path = require('path')
const os   = require('os')

const DIR  = path.join(os.homedir(), '.yantra')
const FILE = path.join(DIR, 'sessions.db.json')

// ── Session Store ─────────────────────────────────────────────────────────────
// Persists browser cookies and localStorage snapshots per domain so the AI
// can resume an authenticated session without re-logging in.
//
// Uses Electron's session.defaultSession.cookies API in the main process.

// ── Public API ────────────────────────────────────────────────────────────────

// Capture all cookies for the active BrowserView and store by domain.
async function saveSession(domain, webContents) {
  const cookies = await _getCookies(webContents, domain)
  if (!cookies.length) return { saved: 0 }

  const db = _load()
  db[_key(domain)] = {
    domain,
    cookies,
    savedAt: new Date().toISOString(),
    cookieCount: cookies.length,
  }
  _save(db)
  return { saved: cookies.length }
}

// Restore previously saved cookies into the active BrowserView's session.
async function restoreSession(domain, webContents) {
  const db  = _load()
  const rec = db[_key(domain)]
  if (!rec) return { restored: 0, domain }

  let restored = 0
  for (const cookie of rec.cookies) {
    try {
      await _setCookie(webContents, cookie)
      restored++
    } catch { /* ignore individual cookie failures */ }
  }

  return { restored, domain, savedAt: rec.savedAt }
}

// Check if a saved session exists for domain
function hasSession(domain) {
  const db = _load()
  return !!db[_key(domain)]
}

// List all saved sessions (without cookie details)
function listSessions() {
  const db = _load()
  return Object.values(db).map(rec => ({
    domain:      rec.domain,
    cookieCount: rec.cookieCount || 0,
    savedAt:     rec.savedAt,
  }))
}

// Delete a saved session
function clearSession(domain) {
  const db = _load()
  delete db[_key(domain)]
  _save(db)
}

// ── Electron cookie helpers ───────────────────────────────────────────────────

async function _getCookies(webContents, domain) {
  try {
    const { session } = require('electron')
    const ses = webContents?.session || session.defaultSession
    const url = webContents ? await webContents.executeJavaScript('location.href').catch(() => `https://${domain}`) : `https://${domain}`
    return await ses.cookies.get({ url })
  } catch { return [] }
}

async function _setCookie(webContents, cookie) {
  const { session } = require('electron')
  const ses = webContents?.session || session.defaultSession
  const url = `https://${cookie.domain?.replace(/^\./, '') || 'unknown'}`
  await ses.cookies.set({
    url,
    name:     cookie.name,
    value:    cookie.value,
    domain:   cookie.domain,
    path:     cookie.path || '/',
    secure:   cookie.secure || false,
    httpOnly: cookie.httpOnly || false,
    expirationDate: cookie.expirationDate,
  })
}

// ── Persistence ───────────────────────────────────────────────────────────────

function _key(domain) {
  try {
    const u = new URL(domain.startsWith('http') ? domain : `https://${domain}`)
    return u.hostname.replace(/^www\./, '')
  } catch { return domain.toLowerCase().trim() }
}

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

module.exports = { saveSession, restoreSession, hasSession, listSessions, clearSession }
