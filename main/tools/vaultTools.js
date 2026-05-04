'use strict'
const registry    = require('./registry')
const vault       = require('../vault/credentialVault')
const sessionStore = require('../vault/sessionStore')

// ── saveCredential ────────────────────────────────────────────────────────────

registry.register({
  name: 'saveCredential',
  description: 'Securely save a username and password for a website to the encrypted credential vault. Uses OS keychain (macOS Keychain / Windows DPAPI) for encryption.',
  inputSchema: {
    type: 'object',
    properties: {
      site:     { type: 'string', description: 'Website URL or domain (e.g. "github.com" or "https://github.com")' },
      username: { type: 'string', description: 'Username or email address' },
      password: { type: 'string', description: 'Password to encrypt and store' },
      notes:    { type: 'string', description: 'Optional notes about this credential' },
    },
    required: ['site', 'username', 'password'],
  },
  async execute({ site, username, password, notes = '' } = {}) {
    if (!site || !username || !password) return 'Error: site, username, and password are required.'
    try {
      const id = vault.save(site, username, password, notes)
      return `✓ Credential saved for **${site}** (username: ${username})\nVault ID: \`${id}\``
    } catch (e) {
      return `Error saving credential: ${e.message}`
    }
  },
})

// ── getCredential ─────────────────────────────────────────────────────────────

registry.register({
  name: 'getCredential',
  description: 'Retrieve saved credentials for a website from the encrypted vault.',
  inputSchema: {
    type: 'object',
    properties: {
      site: { type: 'string', description: 'Website URL or domain to look up' },
    },
    required: ['site'],
  },
  async execute({ site } = {}) {
    if (!site) return 'Error: site is required.'
    const entries = vault.get(site)
    if (!entries.length) return `No credentials found for **${site}**. Use \`saveCredential\` to store them.`
    return entries.map(e =>
      `**${e.domain}**\n- Username: ${e.username}\n- Password: ${'•'.repeat(Math.min(e.password.length, 12))}\n- Saved: ${e.createdAt}`
    ).join('\n\n')
  },
})

// ── listCredentials ───────────────────────────────────────────────────────────

registry.register({
  name: 'listCredentials',
  description: 'List all saved credentials in the vault (passwords are never shown in the list).',
  inputSchema: { type: 'object', properties: {} },
  async execute() {
    const entries = vault.list()
    if (!entries.length) return 'Vault is empty. Use `saveCredential` to store credentials.'
    const rows = entries.map(e => `| ${e.domain} | ${e.username} | ${e.notes || '—'} |`).join('\n')
    return `## Credential Vault (${entries.length} entries)\n\n| Domain | Username | Notes |\n|---|---|---|\n${rows}`
  },
})

// ── autofillCredential ────────────────────────────────────────────────────────

registry.register({
  name: 'autofillCredential',
  description: 'Automatically fill the username and password fields on the current page using saved credentials from the vault.',
  inputSchema: {
    type: 'object',
    properties: {
      site: { type: 'string', description: 'Domain to look up credentials for. Defaults to current page domain.' },
    },
  },
  async execute({ site } = {}) {
    let domain = site
    if (!domain) {
      try {
        const tm  = require('../tabManager')
        const tab = tm.getActiveTab()
        domain    = tab?.url ? new URL(tab.url).hostname : null
      } catch { /* ignore */ }
    }
    if (!domain) return 'Error: could not determine current page domain. Pass site explicitly.'

    const entries = vault.get(domain)
    if (!entries.length) return `No credentials found for **${domain}**. Use \`saveCredential\` first.`

    const cred = entries[0]

    // Inject credentials into the page via automation tools
    const clickTool  = require('./registry').get('clickElement')
    const typeTool   = require('./registry').get('typeInField')

    const steps = []

    // Try common username selectors
    const userSelectors = ['input[type="email"]', 'input[name="email"]', 'input[name="username"]', '#email', '#username', 'input[type="text"]']
    const passSelectors = ['input[type="password"]', '#password', 'input[name="password"]']

    if (typeTool) {
      for (const sel of userSelectors) {
        try {
          const r = await typeTool.execute({ selector: sel, text: cred.username, clearFirst: true })
          if (!r.includes('Error') && !r.includes('not found')) { steps.push(`✓ Username filled (${sel})`); break }
        } catch { continue }
      }
      for (const sel of passSelectors) {
        try {
          const r = await typeTool.execute({ selector: sel, text: cred.password, clearFirst: true })
          if (!r.includes('Error') && !r.includes('not found')) { steps.push(`✓ Password filled (${sel})`); break }
        } catch { continue }
      }
    }

    if (!steps.length) return `Found credentials for ${domain} but could not locate login fields. Try navigating to the login page first.`
    return `## Autofill Complete\n**Domain:** ${domain}\n**Username:** ${cred.username}\n\n${steps.join('\n')}`
  },
})

// ── savePageSession ───────────────────────────────────────────────────────────

registry.register({
  name: 'savePageSession',
  description: 'Save the current browser session cookies for a domain so you can restore them later without logging in again.',
  inputSchema: {
    type: 'object',
    properties: {
      domain: { type: 'string', description: 'Domain to save session for. Defaults to current page.' },
    },
  },
  async execute({ domain } = {}) {
    try {
      const tm  = require('../tabManager')
      const tab = tm.getActiveTab()
      const wc  = tab?.view?.webContents
      const url = domain || tab?.url || ''
      const result = await sessionStore.saveSession(url, wc)
      return `✓ Session saved for **${url}** — ${result.saved} cookies stored.\nUse \`restorePageSession\` to resume without logging in.`
    } catch (e) {
      return `Error saving session: ${e.message}`
    }
  },
})

// ── restorePageSession ────────────────────────────────────────────────────────

registry.register({
  name: 'restorePageSession',
  description: 'Restore a previously saved browser session for a domain, resuming an authenticated state without re-logging in.',
  inputSchema: {
    type: 'object',
    properties: {
      domain: { type: 'string', description: 'Domain to restore session for.' },
    },
    required: ['domain'],
  },
  async execute({ domain } = {}) {
    if (!domain) return 'Error: domain is required.'
    try {
      const tm  = require('../tabManager')
      const tab = tm.getActiveTab()
      const wc  = tab?.view?.webContents
      const result = await sessionStore.restoreSession(domain, wc)
      if (!result.restored) return `No saved session found for **${domain}**. Use \`savePageSession\` after logging in.`
      return `✓ Session restored for **${domain}** — ${result.restored} cookies loaded.\nSaved at: ${result.savedAt}`
    } catch (e) {
      return `Error restoring session: ${e.message}`
    }
  },
})

// ── listSessions ──────────────────────────────────────────────────────────────

registry.register({
  name: 'listSessions',
  description: 'List all saved browser sessions.',
  inputSchema: { type: 'object', properties: {} },
  async execute() {
    const sessions = sessionStore.listSessions()
    if (!sessions.length) return 'No saved sessions. Navigate to a site, log in, then use `savePageSession`.'
    const rows = sessions.map(s => `| ${s.domain} | ${s.cookieCount} cookies | ${s.savedAt} |`).join('\n')
    return `## Saved Sessions (${sessions.length})\n\n| Domain | Cookies | Saved At |\n|---|---|---|\n${rows}`
  },
})
