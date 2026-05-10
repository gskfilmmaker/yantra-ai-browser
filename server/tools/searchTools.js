'use strict'
/**
 * Web search and fetch tools — no API key required.
 * search_web: DuckDuckGo HTML scraping
 * fetch_webpage: Playwright page evaluation (reuses session browser context)
 */

const { register } = require('./registry')
const https = require('https')
const http  = require('http')

// ── Tiny HTTP fetch helper ─────────────────────────────────────────────────────

function httpGet(url, options = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http
    const req = mod.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        ...options.headers,
      },
      timeout: 15000,
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(httpGet(res.headers.location, options))
      }
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')) })
  })
}

// ── DuckDuckGo HTML scraper ────────────────────────────────────────────────────

function parseDDGHtml(html) {
  // Extract result snippets from DDG HTML response
  const results = []
  // Match result blocks: title, url, snippet
  const blockRe = /<div class="result__body">([\s\S]*?)<\/div>\s*<\/div>/g
  const titleRe = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/
  const snippRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/

  // Simpler approach: extract all result__a links and result__snippets
  const linkRe    = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
  const snippetRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g

  const links    = []
  const snippets = []

  let m
  while ((m = linkRe.exec(html)) !== null) {
    links.push({
      url:   m[1],
      title: m[2].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim(),
    })
  }
  while ((m = snippetRe.exec(html)) !== null) {
    snippets.push(m[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim())
  }

  for (let i = 0; i < Math.min(links.length, snippets.length, 8); i++) {
    if (links[i].title && links[i].url) {
      results.push({ title: links[i].title, url: links[i].url, snippet: snippets[i] || '' })
    }
  }
  return results
}

// ── Tools ──────────────────────────────────────────────────────────────────────

register({
  name: 'web_search',
  description: 'Search the web using DuckDuckGo. Returns top results with titles, URLs, and snippets. No API key required.',
  inputSchema: {
    type: 'object',
    properties: {
      query:      { type: 'string', description: 'Search query' },
      max_results: { type: 'number', description: 'Maximum results to return (default: 6, max: 10)' },
    },
    required: ['query'],
  },
  async execute({ query, max_results = 6 } = {}) {
    if (!query) return 'Error: query is required'
    const limit = Math.min(max_results || 6, 10)
    const encoded = encodeURIComponent(query)

    try {
      // DuckDuckGo HTML endpoint
      const { status, body } = await httpGet(
        `https://html.duckduckgo.com/html/?q=${encoded}&kl=us-en`,
        { headers: { 'Accept': 'text/html' } }
      )

      if (status !== 200) return `Search failed (HTTP ${status})`

      const results = parseDDGHtml(body)

      if (!results.length) {
        // Fallback: try to extract any links from page
        return `No structured results found for "${query}". Try fetch_webpage on a specific URL instead.`
      }

      return results.slice(0, limit).map((r, i) =>
        `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`
      ).join('\n\n')
    } catch (e) {
      return `Search error: ${e.message}`
    }
  },
})

register({
  name: 'fetch_webpage',
  description: 'Fetch and extract the text content of a webpage by URL. Returns clean readable text. Faster than navigate_to for read-only access.',
  inputSchema: {
    type: 'object',
    properties: {
      url:          { type: 'string', description: 'URL to fetch' },
      max_length:   { type: 'number', description: 'Max characters to return (default: 4000)' },
    },
    required: ['url'],
  },
  async execute({ url, max_length = 4000 } = {}, { sessionId } = {}) {
    if (!url) return 'Error: url is required'
    if (!url.match(/^https?:\/\//i)) url = 'https://' + url

    try {
      // Use Playwright for JavaScript-heavy pages
      const { getPage } = require('./browserTools')
      const page = await getPage(sessionId ? `fetch_${sessionId}` : 'fetch_shared')

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 })
      const title = await page.title()
      const text  = await page.evaluate((limit) => {
        const clone = document.cloneNode(true)
        // Remove noise elements
        document.querySelectorAll('script,style,noscript,nav,footer,aside,header,[role="banner"],[role="navigation"]').forEach(el => el.remove())
        const body = document.body?.innerText || document.documentElement.innerText || ''
        return body.replace(/\s+/g, ' ').trim().slice(0, limit)
      }, max_length)

      const finalUrl = page.url()
      return `**${title}**\nURL: ${finalUrl}\n\n${text}`
    } catch (e) {
      // Fallback to simple HTTP fetch if Playwright fails
      try {
        const { status, body } = await httpGet(url)
        if (status !== 200) return `HTTP ${status} fetching ${url}`
        // Strip HTML tags crudely
        const text = body
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, max_length)
        return `URL: ${url}\n\n${text}`
      } catch (e2) {
        return `Error fetching webpage: ${e2.message}`
      }
    }
  },
})
