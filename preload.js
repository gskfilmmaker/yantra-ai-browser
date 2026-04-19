const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  sendAiMessage: (data) => ipcRenderer.invoke('send-ai-message', data),
  executeJs: (webContentsId, code) => ipcRenderer.invoke('execute-js', webContentsId, code),
  captureScreenshot: (webContentsId) => ipcRenderer.invoke('capture-screenshot', webContentsId),
  getPageContent: (webContentsId) => ipcRenderer.invoke('get-page-content', webContentsId),

  onAiChunk: (callback) => {
    ipcRenderer.removeAllListeners('ai-stream-chunk')
    ipcRenderer.on('ai-stream-chunk', (_event, chunk) => callback(chunk))
  },
  onAiDone: (callback) => {
    ipcRenderer.removeAllListeners('ai-stream-done')
    ipcRenderer.once('ai-stream-done', (_event, response) => {
      ipcRenderer.removeAllListeners('ai-stream-chunk')
      callback(response)
    })
  },
})
