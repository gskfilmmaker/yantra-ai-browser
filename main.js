const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')

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
    const res = await httpFetch(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`
    )
    const data = await res.json()
    const parts = []

    if (data.AbstractText) {
      parts.push(data.AbstractText)
      if (data.AbstractURL) parts.push(`Source: ${data.AbstractURL}`)
    }

    if (data.Results && data.Results.length > 0) {
      parts.push('\nTop results:')
      data.Results.slice(0, 5).forEach(r => parts.push(`• ${r.Text} — ${r.FirstURL}`))
    }

    if (data.RelatedTopics && data.RelatedTopics.length > 0) {
      parts.push('\nRelated:')
      data.RelatedTopics.slice(0, 6).forEach(t => {
        if (t.Text) parts.push(`• ${t.Text}${t.FirstURL ? ` — ${t.FirstURL}` : ''}`)
      })
    }

    return parts.join('\n') || 'No instant results. Try fetching a specific URL for more details.'
  } catch (e) {
    return `Search failed: ${e.message}`
  }
}

async function fetchWebpage(url) {
  try {
    const res = await httpFetch(url)
    const html = await res.text()
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&#\d+;/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim()
    return text.slice(0, 10000)
  } catch (e) {
    return `Could not fetch page: ${e.message}`
  }
}

// ─── Agent IPC ────────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'web_search',
    description: 'Search the web for current information, news, prices, facts, or any topic.',
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
    description: 'Fetch and read the full text content of any webpage URL.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The full URL to fetch' }
      },
      required: ['url']
    }
  }
]

const SYSTEM = `You are Strawberry, an intelligent AI research assistant. You help users research topics, find information, analyze data, and complete complex tasks autonomously.

When given a task:
- Use your tools proactively to gather real, current information
- Show your reasoning and steps clearly
- Cite sources with URLs when available
- Be thorough, accurate, and helpful

You have access to web search and webpage fetching. Use them whenever you need current or specific information.`

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
            if (tb.name === 'web_search') result = await webSearch(tb.input.query)
            else if (tb.name === 'fetch_webpage') result = await fetchWebpage(tb.input.url)
            else result = 'Unknown tool'
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
