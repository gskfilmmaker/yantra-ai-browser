'use strict'
const TurndownService = require('turndown')
const { parseDocument, DomUtils } = require('htmlparser2')
const { register } = require('./registry')

const turndown = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced' })
turndown.addRule('strip-noise', {
  filter: ['script', 'style', 'nav', 'footer', 'header', 'aside', 'noscript', 'iframe'],
  replacement: () => '',
})

async function httpGet(url) {
  return fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      'Accept': 'text/html,application/json,*/*',
    },
  })
}

register({
  name: 'web_search',
  description: 'Search the web for current information. Always use this before answering factual or time-sensitive questions.',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  async execute({ query }) {
    try {
      const res  = await httpGet(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`)
      const html = await res.text()
      const dom  = parseDocument(html)

      const links    = DomUtils.findAll(el => el.type === 'tag' && el.name === 'a' && el.attribs?.class?.includes('result__a'), dom.children)
      const snippets = DomUtils.findAll(el => el.type === 'tag' && el.attribs?.class?.includes('result__snippet'), dom.children)

      const results = links.slice(0, 6).map((link, i) => {
        const title   = DomUtils.getText(link).trim()
        const href    = link.attribs.href || ''
        const snippet = snippets[i] ? DomUtils.getText(snippets[i]).trim() : ''
        return title ? `**${title}**\n${snippet}\n${href}` : null
      }).filter(Boolean)

      if (results.length) return results.join('\n\n')

      // Fallback: instant answer API
      const api  = await httpGet(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`)
      const data = await api.json()
      const parts = []
      if (data.AbstractText) parts.push(data.AbstractText + (data.AbstractURL ? `\nSource: ${data.AbstractURL}` : ''))
      data.RelatedTopics?.slice(0, 5).forEach(t => { if (t.Text) parts.push(`• ${t.Text}`) })
      return parts.join('\n') || 'No results. Try fetching a specific URL.'
    } catch (e) { return `Search failed: ${e.message}` }
  },
})

register({
  name: 'fetch_webpage',
  description: 'Fetch and read a specific URL. Returns clean Markdown text. Use to read articles, docs, or product pages in depth.',
  inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  async execute({ url }) {
    try {
      const res  = await httpGet(url)
      const html = await res.text()
      return turndown.turndown(html).replace(/\n{3,}/g, '\n\n').trim().slice(0, 12000)
    } catch (e) { return `Could not fetch: ${e.message}` }
  },
})

register({
  name: 'save_note',
  description: 'Save a report, summary, or research result as a Markdown file to the Desktop.',
  inputSchema: {
    type: 'object',
    properties: {
      filename: { type: 'string', description: 'File name, e.g. "report.md"' },
      content:  { type: 'string', description: 'Full Markdown content to write' },
    },
    required: ['filename', 'content'],
  },
  async execute({ filename, content }) {
    const fs   = require('fs').promises
    const path = require('path')
    const os   = require('os')
    const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_')
    const dest = path.join(os.homedir(), 'Desktop', safe)
    await fs.writeFile(dest, content, 'utf8')
    return `Saved to ~/Desktop/${safe}`
  },
})
