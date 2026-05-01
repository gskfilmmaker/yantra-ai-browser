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
    setBounds:      (bounds)      => ipcRenderer.invoke('browser:setBounds', bounds),
    hide:           ()            => ipcRenderer.invoke('browser:hide'),
    show:           ()            => ipcRenderer.invoke('browser:show'),
    findInPage:     (text, opts)  => ipcRenderer.invoke('browser:findInPage', text, opts),
    stopFindInPage: ()            => ipcRenderer.invoke('browser:stopFindInPage'),
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
    startFind:   (cb) => ipcRenderer.on('start-find',   ()    => cb()),
    findResult:  (cb) => ipcRenderer.on('find-result',  (_, d) => cb(d)),
  },

  // Remove all listeners for a channel (cleanup)
  off: (channel) => ipcRenderer.removeAllListeners(channel),
})

// ── window.yantra — full orchestration API ────────────────────────────────────
contextBridge.exposeInMainWorld('yantra', {
  agents: {
    list:      ()           => ipcRenderer.invoke('agent:list'),
    getActive: ()           => ipcRenderer.invoke('agent:getActive'),
    setActive: (id)         => ipcRenderer.invoke('agent:setActive', id),
    create:    (cfg)        => ipcRenderer.invoke('agent:create', cfg),
    update:    (id, partial)=> ipcRenderer.invoke('agent:update', id, partial),
    remove:    (id)         => ipcRenderer.invoke('agent:delete', id),
  },
  routines: {
    list:   ()        => ipcRenderer.invoke('routine:list'),
    create: (cfg)     => ipcRenderer.invoke('routine:create', cfg),
    update: (id, p)   => ipcRenderer.invoke('routine:update', id, p),
    remove: (id)      => ipcRenderer.invoke('routine:delete', id),
    run:    (id)      => ipcRenderer.invoke('routine:run', id),
  },
  memory: {
    getAll:  ()      => ipcRenderer.invoke('memory:getAll'),
    delete:  (id)    => ipcRenderer.invoke('memory:delete', id),
    search:  (q)     => ipcRenderer.invoke('memory:search', q),
    clear:   ()      => ipcRenderer.invoke('memory:clear'),
  },
  sessions: {
    clear: () => ipcRenderer.invoke('sessions:clear'),
  },
  settings: {
    get: ()       => ipcRenderer.invoke('settings:get'),
    set: (k, v)   => ipcRenderer.invoke('settings:set', k, v),
  },
  on: {
    routineEvent: (cb) => ipcRenderer.on('routine-event', (_, d) => cb(d)),
  },
})
