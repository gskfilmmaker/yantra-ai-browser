'use strict'
const { ipcMain } = require('electron')
const TurndownService = require('turndown')
const { parseDocument, DomUtils } = require('htmlparser2')
const tabManager = require('./tabManager')
const memoryStore = require('./memoryStore')
const { routeAction } = require('./aiRouter')

// ─── Content extraction pipeline (same as real Strawberry) ───────────────────

const turndown = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced' })
turndown.addRule('strip-noise', {
  filter: ['script', 'style', 'nav', 'footer', 'header', 'aside', 'noscript', 'iframe'],
  replacement: () => '',
})

async function httpGet(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      'Accept': 'text/html,application/json,*/*',
    },
  })
  return res
}

async function webSearch(query) {
  try {
    const res = await httpGet(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`)
    const html = await res.text()
    const dom = parseDocument(html)

    const links = DomUtils.findAll(
      el => el.type === 'tag' && el.name === 'a' && el.attribs?.class?.includes('result__a'),
      dom.children
    )
    const snippets = DomUtils.findAll(
      el => el.type === 'tag' && el.attribs?.class?.includes('result__snippet'),
      dom.children
    )

    const results = links.slice(0, 6).map((link, i) => {
      const title = DomUtils.getText(link).trim()
      const href = link.attribs.href || ''
      const snippet = snippets[i] ? DomUtils.getText(snippets[i]).trim() : ''
      return title ? `**${title}**\n${snippet}\n${href}` : null
    }).filter(Boolean)

    if (results.length) return results.join('\n\n')

    // Fallback: instant-answer API
    const apiRes = await httpGet(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`)
    const data = await apiRes.json()
    const parts = []
    if (data.AbstractText) parts.push(data.AbstractText + (data.AbstractURL ? `\nSource: ${data.AbstractURL}` : ''))
    data.RelatedTopics?.slice(0, 5).forEach(t => { if (t.Text) parts.push(`• ${t.Text}`) })
    return parts.join('\n') || 'No results. Try fetching a specific URL.'
  } catch (e) {
    return `Search failed: ${e.message}`
  }
}

async function fetchWebpage(url) {
  try {
    const res = await httpGet(url)
    const html = await res.text()
    const md = turndown.turndown(html).replace(/\n{3,}/g, '\n\n').trim()
    return md.slice(0, 12000)
  } catch (e) {
    return `Could not fetch: ${e.message}`
  }
}

async function saveNote(filename, content) {
  const fs = require('fs').promises
  const path = require('path')
  const os = require('os')
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_')
  const dest = path.join(os.homedir(), 'Desktop', safe)
  await fs.writeFile(dest, content, 'utf8')
  return `Saved to ~/Desktop/${safe}`
}

// ─── Agent tool definitions ───────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'web_search',
    description: 'Search the web for current information. Always use this before answering factual questions.',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'fetch_webpage',
    description: 'Fetch and read a webpage URL. Returns clean Markdown. Use to read articles, docs, product pages.',
    input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  },
  {
    name: 'get_current_page',
    description: 'Get the title, URL, text content, and links of the currently active browser tab. Use when user says "this page", "current page", "what I\'m reading", etc.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'open_url',
    description: 'Navigate the browser to a URL or open it in a new tab.',
    input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  },
  {
    name: 'get_all_tabs',
    description: 'Get content from all open browser tabs. Use for comparison or multi-source analysis.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'save_note',
    description: 'Save a report or research result as a Markdown file to the Desktop.',
    input_schema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'File name e.g. "report.md"' },
        content: { type: 'string', description: 'Markdown content to save' },
      },
      required: ['filename', 'content'],
    },
  },
]

const SYSTEM = `You are Strawberry, an intelligent AI browser assistant. You can research the web, analyze the user's open browser tabs, navigate to URLs, and save reports.

Rules:
- Use web_search before answering questions that need current data
- Use get_current_page whenever the user mentions "this page", "current tab", "what I'm looking at"
- Use fetch_webpage to read specific articles or URLs in depth
- Chain multiple tools for complex research tasks
- Be specific, cite URLs as sources, and present findings clearly
- When asked to summarize a page, ALWAYS use get_current_page first`

// ─── Per-session conversation history (server-side) ──────────────────────────

const sessionHistory = new Map()

// ─── Agent loop ───────────────────────────────────────────────────────────────

async function runAgent(event, anthropic, message, sessionId) {
  const prior = sessionHistory.get(sessionId) || []
  const messages = [...prior, { role: 'user', content: message }]
  const MAX_TURNS = 12

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      tools: TOOLS,
      messages,
    })

    // Emit text blocks immediately
    for (const block of response.content) {
      if (block.type === 'text' && block.text.trim()) {
        event.sender.send('agent-event', { sessionId, type: 'text', text: block.text })
      }
    }

    if (response.stop_reason === 'end_turn') {
      messages.push({ role: 'assistant', content: response.content })
      break
    }

    if (response.stop_reason === 'tool_use') {
      const toolBlocks = response.content.filter(b => b.type === 'tool_use')
      const toolResults = []

      for (const tb of toolBlocks) {
        event.sender.send('agent-event', {
          sessionId, type: 'tool_call',
          toolId: tb.id, toolName: tb.name, toolInput: tb.input,
        })

        let result = ''
        try {
          switch (tb.name) {
            case 'web_search':      result = await webSearch(tb.input.query); break
            case 'fetch_webpage':   result = await fetchWebpage(tb.input.url); break
            case 'get_current_page': {
              const page = await tabManager.getPageContent()
              result = page
                ? `Title: ${page.title}\nURL: ${page.url}\n\nContent:\n${page.content}\n\nLinks:\n${page.links?.slice(0,20).map(l=>`• [${l.text}](${l.href})`).join('\n')}`
                : 'No browser tab is currently active. Please open a website first.'
              break
            }
            case 'open_url':
              result = await routeAction('openURL', { url: tb.input.url }, anthropic); break
            case 'get_all_tabs':
              result = await routeAction('compareAllTabs', {}, anthropic); break
            case 'save_note':
              result = await saveNote(tb.input.filename, tb.input.content); break
            default:
              result = `Unknown tool: ${tb.name}`
          }
        } catch (e) {
          result = `Tool error: ${e.message}`
        }

        event.sender.send('agent-event', {
          sessionId, type: 'tool_result',
          toolId: tb.id, toolName: tb.name, result,
        })

        toolResults.push({ type: 'tool_result', tool_use_id: tb.id, content: result })
      }

      messages.push({ role: 'assistant', content: response.content })
      messages.push({ role: 'user', content: toolResults })
      continue
    }

    break
  }

  // Persist conversation so next message has full context
  sessionHistory.set(sessionId, messages)
}

// ─── Register all IPC handlers ────────────────────────────────────────────────

function register() {
  // Tabs
  ipcMain.handle('tab:create',  (_, opts) => tabManager.createTab(opts || {}))
  ipcMain.handle('tab:switch',  (_, id)   => tabManager.switchTo(id))
  ipcMain.handle('tab:close',   (_, id)   => tabManager.closeTab(id))
  ipcMain.handle('tab:getAll',  ()        => tabManager.getAllTabInfo())

  // Browser navigation
  ipcMain.handle('browser:navigate',   (_, url) => tabManager.navigate(url))
  ipcMain.handle('browser:goBack',     ()       => tabManager.goBack())
  ipcMain.handle('browser:goForward',  ()       => tabManager.goForward())
  ipcMain.handle('browser:reload',     ()       => tabManager.reload())
  ipcMain.handle('browser:getContent',    (_, id)     => tabManager.getPageContent(id))
  ipcMain.handle('browser:getAllContent', ()          => tabManager.getAllTabsContent())
  ipcMain.handle('browser:setBounds',     (_, bounds) => tabManager.setBrowserBounds(bounds))

  // Memory
  ipcMain.handle('memory:save',       (_, e)  => memoryStore.save(e))
  ipcMain.handle('memory:getHistory', (_, n)  => memoryStore.getHistory(n))

  // Agent
  ipcMain.handle('agent:run', async (event, { message, sessionId }) => {
    let Anthropic
    try { Anthropic = require('@anthropic-ai/sdk') } catch (e) {
      event.sender.send('agent-event', { sessionId, type: 'error', text: 'Run: npm install' })
      return
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      event.sender.send('agent-event', { sessionId, type: 'error', text: 'Set ANTHROPIC_API_KEY and restart.' })
      return
    }
    const anthropic = new Anthropic()
    try {
      await runAgent(event, anthropic, message, sessionId)
    } catch (e) {
      event.sender.send('agent-event', { sessionId, type: 'error', text: `Error: ${e.message}` })
    }
    event.sender.send('agent-event', { sessionId, type: 'done' })
  })
}

module.exports = { register }
