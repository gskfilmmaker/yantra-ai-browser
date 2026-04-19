'use strict'
const { BrowserView } = require('electron')

// ─── Tab shapes ──────────────────────────────────────────────────────────────
// browser tab  → { id, type:'browser', view:BrowserView, url, title, loading }
// session tab  → { id, type:'session', url:'', title, loading:false }

class TabManager {
  constructor() {
    this.tabs = new Map()
    this.activeTabId = null
    this._win = null
    this._bounds = { x: 0, y: 84, width: 1280, height: 620 }
    this._idCounter = 0
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  setWindow(win) {
    this._win = win

    win.on('resize', () => this._recalcBounds())
    win.on('maximize', () => this._recalcBounds())
    win.on('unmaximize', () => this._recalcBounds())
  }

  // ── Public tab API ─────────────────────────────────────────────────────────

  createTab({ type = 'session', url = '' } = {}) {
    const id = `tab-${++this._idCounter}`

    if (type === 'browser') {
      const view = new BrowserView({
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          partition: 'persist:browser',
        },
      })

      const tab = { id, type: 'browser', view, url: '', title: 'New Tab', loading: false }
      this.tabs.set(id, tab)
      this._bindViewEvents(view, id)

      if (url) {
        view.webContents.loadURL(this._normalise(url))
        tab.url = url
      }

      this.switchTo(id)
    } else {
      const tab = { id, type: 'session', url: '', title: 'New session', loading: false }
      this.tabs.set(id, tab)
      this.switchTo(id)
    }

    return id
  }

  switchTo(tabId) {
    const tab = this.tabs.get(tabId)
    if (!tab || !this._win) return

    // Detach whichever BrowserView is currently attached
    for (const v of this._win.getBrowserViews()) {
      this._win.removeBrowserView(v)
    }

    this.activeTabId = tabId

    if (tab.type === 'browser' && tab.view) {
      this._win.addBrowserView(tab.view)
      tab.view.setBounds(this._bounds)
    }

    this._emit('tab:switched', { tabId, tabs: this._allInfo() })
  }

  closeTab(tabId) {
    const tab = this.tabs.get(tabId)
    if (!tab) return

    if (tab.type === 'browser' && tab.view) {
      for (const v of this._win.getBrowserViews()) {
        if (v === tab.view) this._win.removeBrowserView(v)
      }
      tab.view.webContents.destroy()
    }

    this.tabs.delete(tabId)

    if (this.activeTabId === tabId) {
      const ids = [...this.tabs.keys()]
      if (ids.length > 0) this.switchTo(ids[ids.length - 1])
      else this.createTab({ type: 'session' })
    } else {
      this._emit('tab:closed', { tabId, tabs: this._allInfo() })
    }
  }

  // ── Browser navigation ─────────────────────────────────────────────────────

  navigate(url) {
    const tab = this._activeTab()
    if (tab?.type !== 'browser') return false
    tab.view.webContents.loadURL(this._normalise(url))
    return true
  }

  goBack() {
    const tab = this._activeTab()
    if (tab?.view?.webContents.canGoBack()) tab.view.webContents.goBack()
  }

  goForward() {
    const tab = this._activeTab()
    if (tab?.view?.webContents.canGoForward()) tab.view.webContents.goForward()
  }

  reload() {
    const tab = this._activeTab()
    if (tab?.type !== 'browser') return
    tab.loading ? tab.view.webContents.stop() : tab.view.webContents.reload()
  }

  // ── Content extraction ─────────────────────────────────────────────────────

  async getPageContent(tabId) {
    const tab = this.tabs.get(tabId || this.activeTabId)
    if (!tab || tab.type !== 'browser') return null
    try {
      return await tab.view.webContents.executeJavaScript(`
        ({
          title: document.title,
          url: window.location.href,
          content: (document.body ? document.body.innerText : '').slice(0, 10000),
          links: Array.from(document.querySelectorAll('a[href]'))
            .slice(0, 60)
            .map(a => ({ text: (a.innerText||'').trim().slice(0,120), href: a.href }))
            .filter(l => l.text && l.href.startsWith('http'))
        })
      `)
    } catch (e) {
      return { error: e.message }
    }
  }

  async getAllTabsContent() {
    const out = []
    for (const [id, tab] of this.tabs) {
      if (tab.type !== 'browser') continue
      const content = await this.getPageContent(id)
      out.push({ tabId: id, title: tab.title, url: tab.url, content })
    }
    return out
  }

  // ── Bounds ─────────────────────────────────────────────────────────────────

  setBrowserBounds(bounds) {
    this._bounds = bounds
    const tab = this._activeTab()
    if (tab?.type === 'browser') tab.view.setBounds(bounds)
  }

  _recalcBounds() {
    if (!this._win) return
    const { width, height } = this._win.getContentBounds()
    const TAB_H = 40, NAV_H = 44, CHAT_H = 70
    this.setBrowserBounds({ x: 0, y: TAB_H + NAV_H, width, height: height - TAB_H - NAV_H - CHAT_H })
  }

  // ── Info helpers ───────────────────────────────────────────────────────────

  getActiveTab() { return this._activeTab() }

  getAllTabInfo() { return this._allInfo() }

  // ── Private ────────────────────────────────────────────────────────────────

  _activeTab() { return this.tabs.get(this.activeTabId) }

  _allInfo() {
    return [...this.tabs.values()].map(t => ({
      id: t.id, type: t.type, url: t.url || '', title: t.title || 'New Tab', loading: !!t.loading,
    }))
  }

  _normalise(url) {
    if (url.startsWith('http://') || url.startsWith('https://')) return url
    if (/^[\w-]+\.[a-z]{2,}/.test(url) && !url.includes(' ')) return 'https://' + url
    return `https://www.google.com/search?q=${encodeURIComponent(url)}`
  }

  _bindViewEvents(view, tabId) {
    const wc = view.webContents

    wc.on('did-start-loading', () => {
      const t = this.tabs.get(tabId); if (t) t.loading = true
      this._emitTabUpdate(tabId)
    })

    wc.on('did-stop-loading', () => {
      const t = this.tabs.get(tabId)
      if (t) { t.loading = false; t.url = wc.getURL(); t.title = wc.getTitle() }
      this._emitTabUpdate(tabId)
    })

    wc.on('page-title-updated', (_, title) => {
      const t = this.tabs.get(tabId); if (t) t.title = title
      this._emitTabUpdate(tabId)
    })

    wc.on('did-navigate', (_, url) => {
      const t = this.tabs.get(tabId); if (t) t.url = url
      this._emitTabUpdate(tabId)
    })

    wc.on('did-navigate-in-page', (_, url) => {
      const t = this.tabs.get(tabId); if (t) t.url = url
      this._emitTabUpdate(tabId)
    })

    // Open new-window requests as new browser tabs
    wc.setWindowOpenHandler(({ url }) => {
      this.createTab({ type: 'browser', url })
      return { action: 'deny' }
    })
  }

  _emitTabUpdate(tabId) {
    const t = this.tabs.get(tabId)
    if (t) this._emit('tab:updated', { id: t.id, type: t.type, url: t.url||'', title: t.title||'', loading: !!t.loading })
  }

  _emit(channel, data) {
    if (this._win && !this._win.isDestroyed()) {
      this._win.webContents.send(channel, data)
    }
  }
}

module.exports = new TabManager()
