'use strict'
const fs   = require('fs')
const path = require('path')
const os   = require('os')
const http = require('http')

const TOKEN_FILE = path.join(os.homedir(), '.yantra', 'gdrive-tokens.json')
const SCOPES     = ['https://www.googleapis.com/auth/drive.file']

let _oauth2Client = null

// ── Token persistence ─────────────────────────────────────────────────────────

function loadTokens() {
  try {
    if (fs.existsSync(TOKEN_FILE)) return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'))
  } catch { /* ignore */ }
  return null
}

function saveTokens(tokens) {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true })
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens), 'utf8')
}

function clearTokens() {
  try { fs.unlinkSync(TOKEN_FILE) } catch { /* ignore */ }
}

// ── OAuth2 client ─────────────────────────────────────────────────────────────

function buildClient(clientId, clientSecret) {
  const { google } = require('googleapis')
  const client = new google.auth.OAuth2(
    clientId,
    clientSecret,
    'http://localhost:42813/oauth2callback'
  )
  const saved = loadTokens()
  if (saved) client.setCredentials(saved)
  _oauth2Client = client
  return client
}

function getClient() {
  if (_oauth2Client) return _oauth2Client
  const { appSettings } = requireSettings()
  const clientId     = appSettings.get('gdriveClientId')
  const clientSecret = appSettings.get('gdriveClientSecret')
  if (!clientId || !clientSecret) return null
  return buildClient(clientId, clientSecret)
}

function requireSettings() {
  return { appSettings: require('../settings') }
}

// ── Auth URL generation ───────────────────────────────────────────────────────

function getAuthUrl(clientId, clientSecret) {
  const client = buildClient(clientId, clientSecret)
  return client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  })
}

// ── OAuth callback server ─────────────────────────────────────────────────────
// Starts a temporary localhost server to receive the OAuth redirect,
// exchanges the code for tokens, then shuts down.

function waitForOAuthCode() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost:42813')
      const code = url.searchParams.get('code')
      const err  = url.searchParams.get('error')
      res.writeHead(200, { 'Content-Type': 'text/html' })
      if (code) {
        res.end('<html><body style="font-family:sans-serif;padding:40px;background:#111;color:#eee"><h2>✅ Google Drive connected!</h2><p>You can close this tab and return to Yantra.</p></body></html>')
        server.close()
        resolve(code)
      } else {
        res.end('<html><body style="font-family:sans-serif;padding:40px;background:#111;color:#eee"><h2>❌ Authorization failed</h2><p>' + (err || 'Unknown error') + '</p></body></html>')
        server.close()
        reject(new Error(err || 'OAuth authorization denied'))
      }
    })
    server.listen(42813, 'localhost', () => {})
    server.on('error', reject)
    // Auto-close after 5 minutes if not used
    setTimeout(() => { server.close(); reject(new Error('OAuth timeout')) }, 300_000)
  })
}

async function exchangeCode(code) {
  const client = _oauth2Client
  if (!client) throw new Error('OAuth client not initialised')
  const { tokens } = await client.getToken(code)
  client.setCredentials(tokens)
  saveTokens(tokens)
  return tokens
}

// ── Drive operations ──────────────────────────────────────────────────────────

async function uploadFile(filePath, { folderId, fileName } = {}) {
  const client = getClient()
  if (!client) throw new Error('Google Drive not connected. Add credentials in Settings.')
  const { google } = require('googleapis')
  const drive = google.drive({ version: 'v3', auth: client })
  const name  = fileName || path.basename(filePath)
  const media = { body: fs.createReadStream(filePath) }
  const meta  = { name, ...(folderId ? { parents: [folderId] } : {}) }
  const res   = await drive.files.create({ requestBody: meta, media, fields: 'id,name,webViewLink' })
  return res.data
}

async function listFolders() {
  const client = getClient()
  if (!client) throw new Error('Google Drive not connected.')
  const { google } = require('googleapis')
  const drive = google.drive({ version: 'v3', auth: client })
  const res = await drive.files.list({
    q: "mimeType='application/vnd.google-apps.folder' and trashed=false",
    fields: 'files(id,name)',
    pageSize: 50,
  })
  return res.data.files || []
}

async function createFolder(name, parentFolderId) {
  const client = getClient()
  if (!client) throw new Error('Google Drive not connected.')
  const { google } = require('googleapis')
  const drive = google.drive({ version: 'v3', auth: client })
  const meta  = {
    name,
    mimeType: 'application/vnd.google-apps.folder',
    ...(parentFolderId ? { parents: [parentFolderId] } : {}),
  }
  const res = await drive.files.create({ requestBody: meta, fields: 'id,name' })
  return res.data
}

function isConnected() {
  const tokens = loadTokens()
  return !!(tokens && (tokens.access_token || tokens.refresh_token))
}

module.exports = {
  getAuthUrl,
  buildClient,
  waitForOAuthCode,
  exchangeCode,
  uploadFile,
  listFolders,
  createFolder,
  isConnected,
  clearTokens,
}
