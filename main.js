'use strict'
const { app, BrowserWindow, Menu } = require('electron')
const path = require('path')
const tabManager    = require('./main/tabManager')
const { register: registerIPC } = require('./main/ipcHandlers')
const triggerEngine = require('./main/routines/triggerEngine')
const settings      = require('./main/settings')

// Disable hardware acceleration — prevents GPU process crash/restart freezes
app.disableHardwareAcceleration()

// Load saved API keys on startup
const _saved = settings.getAll()
if (!process.env.ANTHROPIC_API_KEY  && _saved.apiKey)           process.env.ANTHROPIC_API_KEY  = _saved.apiKey
if (!process.env.OPENAI_API_KEY     && _saved.openaiApiKey)     process.env.OPENAI_API_KEY     = _saved.openaiApiKey
if (!process.env.PREFERRED_PROVIDER && _saved.preferredProvider) process.env.PREFERRED_PROVIDER = _saved.preferredProvider

let mainWindow

app.whenReady().then(() => {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 13 },
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'))

  // Wire tab manager to this window
  tabManager.setWindow(mainWindow)

  // Register all IPC handlers
  registerIPC()

  // Create initial browser tab (shows new-tab page until user navigates)
  tabManager.createTab({ type: 'browser', url: '' })

  // Wire routine trigger engine
  triggerEngine.init(mainWindow)

  // ── Application menu with keyboard shortcuts ──────────────────────────────
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'Strawberry',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        {
          label: 'New Tab',
          accelerator: 'CmdOrCtrl+T',
          click: () => tabManager.createTab({ type: 'browser', url: '' }),
        },
        {
          label: 'Close Tab',
          accelerator: 'CmdOrCtrl+W',
          click: () => { const t = tabManager.getActiveTab(); if (t) tabManager.closeTab(t.id) },
        },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Focus URL Bar',
          accelerator: 'CmdOrCtrl+L',
          click: () => mainWindow.webContents.send('focus-url-bar'),
        },
        {
          label: 'Reload Page',
          accelerator: 'CmdOrCtrl+R',
          click: () => tabManager.reload(),
        },
        {
          label: 'Go Back',
          accelerator: 'CmdOrCtrl+[',
          click: () => tabManager.goBack(),
        },
        {
          label: 'Go Forward',
          accelerator: 'CmdOrCtrl+]',
          click: () => tabManager.goForward(),
        },
        { type: 'separator' },
        {
          label: 'Find in Page',
          accelerator: 'CmdOrCtrl+F',
          click: () => mainWindow.webContents.send('start-find'),
        },
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ],
    },
  ]))

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
