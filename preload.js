const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  runAgent: (data) => ipcRenderer.invoke('run-agent', data),
  onAgentEvent: (callback) => {
    ipcRenderer.removeAllListeners('agent-event')
    ipcRenderer.on('agent-event', (_e, payload) => callback(payload))
  },
})
