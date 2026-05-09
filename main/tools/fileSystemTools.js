'use strict'
const fs   = require('fs')
const path = require('path')
const os   = require('os')
const registry = require('./registry')

const DOWNLOADS = path.join(os.homedir(), 'Downloads')

function expandPath(p) {
  return (p || '').replace(/^~/, os.homedir())
}

function findGoogleDrivePath() {
  // macOS DriveFS — newer Google Drive desktop app
  const cloudStorage = path.join(os.homedir(), 'Library', 'CloudStorage')
  if (fs.existsSync(cloudStorage)) {
    const entries = fs.readdirSync(cloudStorage)
    const gd = entries.find(e => e.startsWith('GoogleDrive-'))
    if (gd) {
      const myDrive = path.join(cloudStorage, gd, 'My Drive')
      if (fs.existsSync(myDrive)) return myDrive
      return path.join(cloudStorage, gd)
    }
  }
  // macOS — older Backup & Sync app
  const oldPath = path.join(os.homedir(), 'Google Drive')
  if (fs.existsSync(oldPath)) return oldPath
  return null
}

// ── list_directory ────────────────────────────────────────────────────────────

registry.register({
  name: 'list_directory',
  description: 'List files and folders in a directory. Returns name, type, size in bytes, and last-modified date for each entry.',
  inputSchema: {
    type: 'object',
    properties: {
      directory: { type: 'string', description: 'Directory path. Use ~ for home. E.g. ~/Downloads, ~/Desktop' },
    },
    required: ['directory'],
  },
  async execute({ directory }) {
    const dir = expandPath(directory)
    if (!fs.existsSync(dir)) return `Directory not found: ${dir}`
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    const result = entries.map(e => {
      const full = path.join(dir, e.name)
      try {
        const stat = fs.statSync(full)
        return { name: e.name, type: e.isDirectory() ? 'dir' : 'file', size: stat.size, modified: stat.mtime.toISOString() }
      } catch {
        return { name: e.name, type: 'unknown', size: 0, modified: '' }
      }
    })
    return JSON.stringify(result)
  },
})

// ── find_recent_downloads ─────────────────────────────────────────────────────

registry.register({
  name: 'find_recent_downloads',
  description: 'List the most recently modified files in ~/Downloads, sorted newest first. Use this to find files just downloaded from the browser.',
  inputSchema: {
    type: 'object',
    properties: {
      count:     { type: 'number', description: 'Max files to return (default 10)' },
      extension: { type: 'string', description: 'Filter by extension, e.g. "pdf". Omit for all types.' },
    },
    required: [],
  },
  async execute({ count = 10, extension } = {}) {
    if (!fs.existsSync(DOWNLOADS)) return 'Downloads folder not found.'
    let entries = fs.readdirSync(DOWNLOADS, { withFileTypes: true })
      .filter(e => e.isFile())
      .map(e => {
        const full = path.join(DOWNLOADS, e.name)
        const stat = fs.statSync(full)
        return { name: e.name, path: full, size: stat.size, modified: stat.mtime }
      })
    if (extension) {
      const ext = extension.startsWith('.') ? extension.toLowerCase() : `.${extension.toLowerCase()}`
      entries = entries.filter(e => e.name.toLowerCase().endsWith(ext))
    }
    entries.sort((a, b) => b.modified - a.modified)
    return JSON.stringify(entries.slice(0, count).map(e => ({ ...e, modified: e.modified.toISOString() })))
  },
})

// ── wait_for_download ─────────────────────────────────────────────────────────

registry.register({
  name: 'wait_for_download',
  description: 'Wait for a new file to finish downloading into ~/Downloads. Call this immediately after clicking a download button. Returns the filename and path once the download is complete.',
  inputSchema: {
    type: 'object',
    properties: {
      timeout_seconds: { type: 'number', description: 'Max seconds to wait (default 120, max 300)' },
      extension:       { type: 'string', description: 'Expected file extension, e.g. "pdf"' },
    },
    required: [],
  },
  async execute({ timeout_seconds = 120, extension } = {}) {
    const tm      = require('../tabManager')
    const timeout = Math.min(timeout_seconds || 120, 300) * 1000
    const ext     = extension ? (extension.startsWith('.') ? extension.toLowerCase() : `.${extension.toLowerCase()}`) : null

    // Snapshot completed downloads already known before this call
    const baseline = new Set(tm.getRecentDownloads().map(d => d.path))
    const start    = Date.now()

    return new Promise(resolve => {
      const check = setInterval(() => {
        // Primary signal: tabManager tracks Electron download-item completions
        for (const d of tm.getRecentDownloads()) {
          if (!baseline.has(d.path) && (!ext || d.filename.toLowerCase().endsWith(ext))) {
            clearInterval(check)
            resolve(`Download complete!\nFilename: ${d.filename}\nPath: ${d.path}\nSize: ${d.size} bytes`)
            return
          }
        }

        if (Date.now() - start > timeout) {
          clearInterval(check)
          // Fallback: filesystem scan for files newer than call time
          try {
            const newer = fs.readdirSync(DOWNLOADS)
              .filter(f => !ext || f.toLowerCase().endsWith(ext))
              .map(f => ({ f, mtime: fs.statSync(path.join(DOWNLOADS, f)).mtimeMs }))
              .filter(o => o.mtime > start)
              .sort((a, b) => b.mtime - a.mtime)
            if (newer.length) {
              const hit = newer[0]
              resolve(`Download found (timeout fallback):\nFilename: ${hit.f}\nPath: ${path.join(DOWNLOADS, hit.f)}`)
            } else {
              resolve(`Timed out after ${timeout_seconds}s. Use find_recent_downloads to check ~/Downloads.`)
            }
          } catch {
            resolve(`Timed out after ${timeout_seconds}s. Use find_recent_downloads to check ~/Downloads.`)
          }
        }
      }, 1000)
    })
  },
})

// ── move_file ─────────────────────────────────────────────────────────────────

registry.register({
  name: 'move_file',
  description: 'Move a file from one location to another. Creates the destination directory if it does not exist.',
  inputSchema: {
    type: 'object',
    properties: {
      source:      { type: 'string', description: 'Full path to the file. Use ~ for home.' },
      destination: { type: 'string', description: 'Full destination path including filename. Use ~ for home.' },
    },
    required: ['source', 'destination'],
  },
  async execute({ source, destination }) {
    const src  = expandPath(source)
    const dest = expandPath(destination)
    if (!fs.existsSync(src)) return `File not found: ${src}`
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.renameSync(src, dest)
    return `Moved: ${src} → ${dest}`
  },
})

// ── copy_file ─────────────────────────────────────────────────────────────────

registry.register({
  name: 'copy_file',
  description: 'Copy a file to a new location without removing the original. Creates destination directory if needed.',
  inputSchema: {
    type: 'object',
    properties: {
      source:      { type: 'string', description: 'Full path to source file.' },
      destination: { type: 'string', description: 'Full destination path including filename.' },
    },
    required: ['source', 'destination'],
  },
  async execute({ source, destination }) {
    const src  = expandPath(source)
    const dest = expandPath(destination)
    if (!fs.existsSync(src)) return `File not found: ${src}`
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(src, dest)
    return `Copied: ${src} → ${dest}`
  },
})

// ── get_google_drive_path ─────────────────────────────────────────────────────

registry.register({
  name: 'get_google_drive_path',
  description: 'Get the local path to the Google Drive sync folder on this Mac. Files placed here sync to Google Drive cloud automatically via the desktop app.',
  inputSchema: { type: 'object', properties: {}, required: [] },
  async execute() {
    const p = findGoogleDrivePath()
    if (!p) return 'Google Drive sync folder not found. Install the Google Drive desktop app and sign in.'
    return `Google Drive sync folder: ${p}\nAny file placed here will automatically sync to Google Drive cloud.`
  },
})

// ── move_to_google_drive ──────────────────────────────────────────────────────

registry.register({
  name: 'move_to_google_drive',
  description: 'Move a downloaded file into the local Google Drive sync folder so it uploads to Google Drive automatically. Typical usage: call wait_for_download, then call this with the returned filename.',
  inputSchema: {
    type: 'object',
    properties: {
      filename_or_path: { type: 'string', description: 'Filename in ~/Downloads (e.g. "book.pdf") OR a full absolute path.' },
      subfolder: { type: 'string', description: 'Optional subfolder inside Google Drive, e.g. "Scribd Books". Created if it does not exist.' },
    },
    required: ['filename_or_path'],
  },
  async execute({ filename_or_path, subfolder } = {}) {
    const gdPath = findGoogleDrivePath()
    if (!gdPath) return 'Google Drive sync folder not found. Install the Google Drive desktop app and sign in at drive.google.com.'

    const src = (filename_or_path.startsWith('/') || filename_or_path.startsWith('~'))
      ? expandPath(filename_or_path)
      : path.join(DOWNLOADS, filename_or_path)

    if (!fs.existsSync(src)) {
      return `File not found: ${src}\nTip: use find_recent_downloads to see what is in ~/Downloads.`
    }

    const destDir = subfolder ? path.join(gdPath, subfolder) : gdPath
    fs.mkdirSync(destDir, { recursive: true })
    const dest = path.join(destDir, path.basename(src))
    fs.renameSync(src, dest)

    return `Moved to Google Drive!\nFile: ${path.basename(src)}\nLocal path: ${dest}\nGoogle Drive folder: ${subfolder || '(root)'}\nThe file will sync to Google Drive cloud automatically.`
  },
})
