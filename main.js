'use strict'
const { app, BrowserWindow } = require('electron')
const path = require('path')
const tabManager = require('./main/tabManager')
const { register: registerIPC } = require('./main/ipcHandlers')

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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow.show()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
