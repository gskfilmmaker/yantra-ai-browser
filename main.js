const { app, BrowserWindow, ipcMain, webContents: electronWebContents } = require('electron')
const path = require('path')

let mainWindow

app.commandLine.appendSwitch('disable-features', 'OutOfBlinkCors')

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
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 14 },
    backgroundColor: '#0f0f1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      webviewTag: true,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
  })

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'))
}

// --- IPC Handlers ---

ipcMain.handle('capture-screenshot', async (_event, webContentsId) => {
  try {
    const wc = electronWebContents.fromId(webContentsId)
    if (!wc || wc.isDestroyed()) return null
    const image = await wc.capturePage()
    return image.toDataURL()
  } catch (e) {
    return null
  }
})

ipcMain.handle('execute-js', async (_event, webContentsId, code) => {
  try {
    const wc = electronWebContents.fromId(webContentsId)
    if (!wc || wc.isDestroyed()) return null
    return await wc.executeJavaScript(code)
  } catch (e) {
    return null
  }
})

ipcMain.handle('get-page-content', async (_event, webContentsId) => {
  try {
    const wc = electronWebContents.fromId(webContentsId)
    if (!wc || wc.isDestroyed()) return { url: '', title: '', text: '' }
    const url = wc.getURL()
    const title = wc.getTitle()
    const text = await wc.executeJavaScript(
      '(function(){ return (document.body ? document.body.innerText : "").slice(0,3000) })()'
    ).catch(() => '')
    return { url, title, text }
  } catch (e) {
    return { url: '', title: '', text: '' }
  }
})

ipcMain.handle('send-ai-message', async (event, { message, webContentsId, history }) => {
  let Anthropic
  try {
    Anthropic = require('@anthropic-ai/sdk')
  } catch (e) {
    const err = 'Error: @anthropic-ai/sdk not installed. Run: npm install'
    event.sender.send('ai-stream-done', err)
    return err
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    const err = 'Error: ANTHROPIC_API_KEY environment variable is not set. Please set it and restart the app.'
    event.sender.send('ai-stream-done', err)
    return err
  }

  const anthropic = new Anthropic()

  let screenshot = null
  let pageContent = { url: '', title: '', text: '' }

  if (webContentsId) {
    try {
      const wc = electronWebContents.fromId(webContentsId)
      if (wc && !wc.isDestroyed()) {
        const image = await wc.capturePage()
        screenshot = image.toBase64()
        pageContent.url = wc.getURL()
        pageContent.title = wc.getTitle()
        pageContent.text = await wc.executeJavaScript(
          '(function(){ return (document.body ? document.body.innerText : "").slice(0,2000) })()'
        ).catch(() => '')
      }
    } catch (e) {
      // page info unavailable, continue without it
    }
  }

  const systemPrompt = `You are Strawberry, an intelligent AI browser companion. You help users browse the web, research topics, and automate browser tasks.

You can:
1. Answer questions about what's currently on the page (screenshots are included when available)
2. Research any topic
3. Automate browser interactions by generating action sequences

When you want to perform browser automation, embed a JSON block like this in your response:
\`\`\`automation
{
  "actions": [
    {"type": "click", "selector": "CSS_SELECTOR"},
    {"type": "type", "selector": "CSS_SELECTOR", "text": "TEXT_TO_TYPE"},
    {"type": "navigate", "url": "https://example.com"},
    {"type": "scroll", "direction": "down", "amount": 400},
    {"type": "wait", "ms": 1000}
  ]
}
\`\`\`

Be concise, helpful, and proactive. When given a screenshot, always analyze what you see on the page.`

  const messages = []

  for (const h of (history || [])) {
    messages.push({ role: h.role, content: h.content })
  }

  const userContent = []

  if (screenshot) {
    userContent.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: screenshot },
    })
  }

  const contextPrefix = pageContent.url
    ? `Current page: ${pageContent.url}\nPage title: ${pageContent.title}\n${pageContent.text ? `Page text excerpt:\n${pageContent.text}\n\n` : ''}`
    : ''

  userContent.push({ type: 'text', text: contextPrefix + message })
  messages.push({ role: 'user', content: userContent })

  let fullResponse = ''

  try {
    const stream = anthropic.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages,
    })

    stream.on('text', (text) => {
      fullResponse += text
      if (!event.sender.isDestroyed()) {
        event.sender.send('ai-stream-chunk', text)
      }
    })

    await stream.finalMessage()

    if (!event.sender.isDestroyed()) {
      event.sender.send('ai-stream-done', fullResponse)
    }
    return fullResponse
  } catch (e) {
    const errMsg = `Error: ${e.message}`
    if (!event.sender.isDestroyed()) {
      event.sender.send('ai-stream-done', errMsg)
    }
    return errMsg
  }
})
