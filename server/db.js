'use strict'
const path = require('path')
const fs   = require('fs')

const DATA_DIR = path.join(__dirname, 'data')
const DB_PATH  = path.join(DATA_DIR, 'yantra.db')

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })

const Database = require('better-sqlite3')
const db = new Database(DB_PATH)

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL')
db.pragma('synchronous = NORMAL')

// ── Schema ─────────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id           TEXT PRIMARY KEY,
    goal         TEXT NOT NULL,
    messages     TEXT NOT NULL DEFAULT '[]',
    started_at   INTEGER NOT NULL,
    completed_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS memory (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT NOT NULL,
    content    TEXT NOT NULL,
    tags       TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL
  );
`)

// ── Prepared statements ────────────────────────────────────────────────────────

const stmts = {
  upsertSession: db.prepare(`
    INSERT INTO sessions (id, goal, messages, started_at, completed_at)
    VALUES (@id, @goal, @messages, @started_at, @completed_at)
    ON CONFLICT(id) DO UPDATE SET
      messages     = excluded.messages,
      completed_at = excluded.completed_at
  `),
  getSession:    db.prepare('SELECT * FROM sessions WHERE id = ?'),
  listRecent:    db.prepare('SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?'),
  getIncomplete: db.prepare('SELECT * FROM sessions WHERE completed_at IS NULL ORDER BY started_at DESC'),

  insertMemory:  db.prepare('INSERT INTO memory (title, content, tags, created_at) VALUES (@title, @content, @tags, @created_at)'),
  recentMemory:  db.prepare('SELECT * FROM memory ORDER BY created_at DESC LIMIT ?'),
  searchMemory:  db.prepare("SELECT * FROM memory WHERE title LIKE ? OR content LIKE ? ORDER BY created_at DESC LIMIT 10"),
}

// ── Session helpers ────────────────────────────────────────────────────────────

function saveSession(id, goal, messages, completedAt = null) {
  stmts.upsertSession.run({
    id,
    goal,
    messages:     JSON.stringify(messages),
    started_at:   Date.now(),
    completed_at: completedAt,
  })
}

function getSession(id) {
  const row = stmts.getSession.get(id)
  if (!row) return null
  return { ...row, messages: JSON.parse(row.messages) }
}

function getIncomplete() {
  return stmts.getIncomplete.all().map(row => ({ ...row, messages: JSON.parse(row.messages) }))
}

function listRecent(n = 20) {
  return stmts.listRecent.all(n).map(row => ({ ...row, messages: JSON.parse(row.messages) }))
}

// ── Memory helpers ─────────────────────────────────────────────────────────────

function saveNote(title, content, tags = []) {
  const info = stmts.insertMemory.run({
    title,
    content,
    tags:       JSON.stringify(tags),
    created_at: Date.now(),
  })
  return info.lastInsertRowid
}

function getRecentNotes(n = 10) {
  return stmts.recentMemory.all(n).map(row => ({ ...row, tags: JSON.parse(row.tags) }))
}

function searchMemoryDb(query) {
  const like = `%${query}%`
  return stmts.searchMemory.all(like, like).map(row => ({ ...row, tags: JSON.parse(row.tags) }))
}

module.exports = { saveSession, getSession, getIncomplete, listRecent, saveNote, getRecentNotes, searchMemoryDb, db }
