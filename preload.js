'use strict'
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  // ── Tab management ──────────────────────────────────────────────────────────
  tab: {
    create:  (opts)  => ipcRenderer.invoke('tab:create', opts),
    switch:  (id)    => ipcRenderer.invoke('tab:switch', id),
    close:   (id)    => ipcRenderer.invoke('tab:close', id),
    getAll:  ()      => ipcRenderer.invoke('tab:getAll'),
  },

  // ── Browser navigation ──────────────────────────────────────────────────────
  browser: {
    navigate:    (url)    => ipcRenderer.invoke('browser:navigate', url),
    goBack:      ()       => ipcRenderer.invoke('browser:goBack'),
    goForward:   ()       => ipcRenderer.invoke('browser:goForward'),
    reload:      ()       => ipcRenderer.invoke('browser:reload'),
    getContent:  (id)     => ipcRenderer.invoke('browser:getContent', id),
    getAllContent: ()      => ipcRenderer.invoke('browser:getAllContent'),
    setBounds:   (bounds) => ipcRenderer.invoke('browser:setBounds', bounds),
  },

  // ── AI agent ────────────────────────────────────────────────────────────────
  agent: {
    run: (data) => ipcRenderer.invoke('agent:run', data),
  },

  // ── Memory ──────────────────────────────────────────────────────────────────
  memory: {
    save:       (entry) => ipcRenderer.invoke('memory:save', entry),
    getHistory: (n)     => ipcRenderer.invoke('memory:getHistory', n),
  },

  // ── Event listeners (Main → Renderer) ──────────────────────────────────────
  on: {
    tabUpdated:  (cb) => ipcRenderer.on('tab:updated',   (_, d) => cb(d)),
    tabSwitched: (cb) => ipcRenderer.on('tab:switched',  (_, d) => cb(d)),
    tabClosed:   (cb) => ipcRenderer.on('tab:closed',    (_, d) => cb(d)),
    agentEvent:  (cb) => ipcRenderer.on('agent-event',   (_, d) => cb(d)),
    focusUrlBar: (cb) => ipcRenderer.on('focus-url-bar', ()    => cb()),
  },

  // Remove all listeners for a channel (cleanup)
  off: (channel) => ipcRenderer.removeAllListeners(channel),
})
