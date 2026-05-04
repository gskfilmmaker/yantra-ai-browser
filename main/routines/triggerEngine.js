'use strict'

let _win  = null
let _busy = false   // prevent re-entrant trigger runs

function init(win) {
  _win = win

  const tabManager     = require('../tabManager')
  const routineManager = require('./routineManager')

  // Intercept tabManager's internal _emit to catch navigation events
  const _origEmit = tabManager._emit.bind(tabManager)
  tabManager._emit = (channel, data) => {
    _origEmit(channel, data)
    _onTabEvent(channel, data, routineManager)
  }
}

async function _onTabEvent(channel, data, rm) {
  if (!_win || _busy) return

  let event = null

  if (channel === 'tab:updated' && !data.loading && data.url && data.url !== 'about:blank') {
    event = { type: 'page_load', url: data.url, tabId: data.id }
  } else if (channel === 'tab:switched') {
    const activeTab = (data.tabs || []).find(t => t.id === data.tabId)
    if (activeTab?.url && activeTab.url !== 'about:blank') {
      event = { type: 'tab_changed', url: activeTab.url, tabId: data.tabId }
    }
  }

  if (!event) return

  const matching = rm.evaluateTriggers(event)
  if (!matching.length) return

  _busy = true
  try {
    for (const routine of matching) {
      _win.webContents.send('routine-event', { type: 'start', routineId: routine.id, routineName: routine.name })
      try {
        const result = await rm.runRoutine(routine.id, { tabId: event.tabId })
        _win.webContents.send('routine-event', { type: 'done', routineId: routine.id, routineName: routine.name, result })
      } catch (e) {
        _win.webContents.send('routine-event', { type: 'error', routineId: routine.id, routineName: routine.name, error: e.message })
      }
    }
  } finally {
    _busy = false
  }
}

module.exports = { init }
