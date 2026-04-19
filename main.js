const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')
const TurndownService = require('turndown')
const { parseDocument, DomUtils } = require('htmlparser2')

// Shared turndown instance — same pipeline as real Strawberry
const turndown = new TurndownService({
  headingStyle: 'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
})
// Strip noise rules
turndown.addRule('remove-noise', {
  filter: ['script', 'style', 'nav', 'footer', 'header', 'aside', 'noscript', 'iframe'],
  replacement: () => '',
})

let mainWindow

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 14 },
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  })
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'))
}

// ─── HTTP helper (uses global fetch, available in Electron 28+ / Node 18+) ───

async function httpFetch(url, options = {}) {
  const defaultHeaders = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/json,*/*',
  }
  const res = await fetch(url, { headers: { ...defaultHeaders, ...options.headers } })
  return res
}

// ─── Tools ────────────────────────────────────────────────────────────────────

async function webSearch(query) {
  try {
    // Use DuckDuckGo HTML search for real results, parsed with htmlparser2
    const res = await httpFetch(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      { headers: { 'Accept': 'text/html' } }
    )
    const html = await res.text()
    const dom = parseDocument(html)

    const results = []

    // Extract result links and snippets from DDG HTML
    const allLinks = DomUtils.findAll(
      el => el.type === 'tag' && el.name === 'a' && el.attribs && el.attribs.class && el.attribs.class.includes('result__a'),
      dom.children
    )
    const allSnippets = DomUtils.findAll(
      el => el.type === 'tag' && el.attribs && el.attribs.class && el.attribs.class.includes('result__snippet'),
      dom.children
    )

    allLinks.slice(0, 6).forEach((link, i) => {
      const title = DomUtils.getText(link).trim()
      const href = link.attribs.href || ''
      const snippet = allSnippets[i] ? DomUtils.getText(allSnippets[i]).trim() : ''
      if (title) results.push(`**${title}**\n${snippet}\n${href}`)
    })

    if (results.length > 0) return results.join('\n\n')

    // Fallback to instant answer API
    const apiRes = await httpFetch(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`
    )
    const data = await apiRes.json()
    const parts = []
    if (data.AbstractText) parts.push(data.AbstractText + (data.AbstractURL ? `\nSource: ${data.AbstractURL}` : ''))
    data.RelatedTopics?.slice(0, 5).forEach(t => { if (t.Text) parts.push(`• ${t.Text}`) })
    return parts.join('\n') || 'No results found. Try fetching a specific URL.'
  } catch (e) {
    return `Search failed: ${e.message}`
  }
}

async function fetchWebpage(url) {
  try {
    const res = await httpFetch(url)
    const html = await res.text()
    // turndown converts HTML → clean Markdown (same pipeline as real Strawberry)
    const markdown = turndown.turndown(html)
    // Collapse excessive blank lines
    const cleaned = markdown.replace(/\n{3,}/g, '\n\n').trim()
    return cleaned.slice(0, 12000)
  } catch (e) {
    return `Could not fetch page: ${e.message}`
  }
}

async function saveNote(filename, content) {
  const fs = require('fs').promises
  const os = require('os')
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_')
  const dest = path.join(os.homedir(), 'Desktop', safe)
  await fs.writeFile(dest, content, 'utf8')
  return `Saved to Desktop/${safe}`
}

// ─── Agent IPC ────────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'web_search',
    description: 'Search the web for current information, news, pricing, facts, people, or any topic. Always search before answering questions about current events or specific data.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query' }
      },
      required: ['query']
    }
  },
  {
    name: 'fetch_webpage',
    description: 'Fetch and read the full content of any webpage URL. Returns clean Markdown. Use this to read articles, documentation, product pages, or search result URLs.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The full URL to fetch' }
      },
      required: ['url']
    }
  },
  {
    name: 'save_note',
    description: 'Save a structured note, summary, report, or extracted data to a local file. Use this to persist research results the user can access later.',
    input_schema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'Filename (e.g. "research-report.md")' },
        content: { type: 'string', description: 'The content to save (Markdown format)' }
      },
      required: ['filename', 'content']
    }
  }
]

const SYSTEM = `You are Strawberry, an intelligent AI research and automation assistant built into a browser. You autonomously research topics, analyze content, and complete complex multi-step tasks.

Core behaviors:
- Always use web_search before answering questions that need current data, prices, or facts
- Follow up searches by fetching specific URLs with fetch_webpage to get full details
- Chain multiple tool calls to complete complex research tasks
- Save important findings with save_note when the user asks for a report or wants to keep data
- Be specific, cite sources (URLs), and show your work step by step
- When you find key information, highlight it clearly

You are working autonomously — complete the entire task, not just the first step.`

ipcMain.handle('run-agent', async (event, { message, sessionId, history }) => {
  let Anthropic
  try { Anthropic = require('@anthropic-ai/sdk') }
  catch (e) {
    event.sender.send('agent-event', { sessionId, type: 'error', text: '@anthropic-ai/sdk not installed. Run: npm install' })
    return
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    event.sender.send('agent-event', { sessionId, type: 'error', text: 'ANTHROPIC_API_KEY is not set. Quit and relaunch with: ANTHROPIC_API_KEY=sk-ant-... npm start' })
    return
  }

  const anthropic = new Anthropic()
  const messages = [...(history || []), { role: 'user', content: message }]
  const MAX_TURNS = 12

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
        tools: TOOLS,
        messages,
      })

      // Emit any text blocks
      const textBlocks = response.content.filter(b => b.type === 'text')
      for (const block of textBlocks) {
        if (block.text.trim()) {
          event.sender.send('agent-event', { sessionId, type: 'text', text: block.text })
        }
      }

      if (response.stop_reason === 'end_turn') break

      if (response.stop_reason === 'tool_use') {
        const toolBlocks = response.content.filter(b => b.type === 'tool_use')
        const toolResults = []

        for (const tb of toolBlocks) {
          event.sender.send('agent-event', {
            sessionId,
            type: 'tool_call',
            toolId: tb.id,
            toolName: tb.name,
            toolInput: tb.input,
          })

          let result = ''
          try {
            if (tb.name === 'web_search') {
              result = await webSearch(tb.input.query)
            } else if (tb.name === 'fetch_webpage') {
              result = await fetchWebpage(tb.input.url)
            } else if (tb.name === 'save_note') {
              result = await saveNote(tb.input.filename, tb.input.content)
            } else {
              result = 'Unknown tool'
            }
          } catch (e) {
            result = `Error: ${e.message}`
          }

          event.sender.send('agent-event', {
            sessionId,
            type: 'tool_result',
            toolId: tb.id,
            toolName: tb.name,
            result,
          })

          toolResults.push({ type: 'tool_result', tool_use_id: tb.id, content: result })
        }

        messages.push({ role: 'assistant', content: response.content })
        messages.push({ role: 'user', content: toolResults })
        continue
      }

      break
    }
  } catch (e) {
    event.sender.send('agent-event', { sessionId, type: 'error', text: `Error: ${e.message}` })
  }

  event.sender.send('agent-event', { sessionId, type: 'done' })
})
