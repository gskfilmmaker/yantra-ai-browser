'use strict'
const scheduler       = require('./scheduler')
const conditionMonitor = require('./conditionMonitor')

// ── Autonomy Engine ───────────────────────────────────────────────────────────
// Wires the scheduler and condition monitor together.
// Provides the single init() call that main.js uses on startup.
// Routes all autonomous task runs through the cognitive engine.

let _win = null

function init(win) {
  _win = win

  // Start scheduler — passes each fired schedule through cogitate
  scheduler.init(win, async (schedule) => {
    const { cogitate } = require('../cognition/cognitiveEngine')
    return await cogitate(schedule.request, { graphId: `sched_${schedule.id}_${Date.now()}` })
  })

  // Start condition monitor — when a monitor triggers, run its onTrigger request
  conditionMonitor.init(win)

  // Listen for monitor trigger events and auto-cogitate if onTrigger is set
  win.webContents.on('did-finish-load', () => {
    // Re-emit monitor trigger events from main process to renderer
  })

  // Handle monitor trigger → cogitate
  const { ipcMain } = require('electron')
  ipcMain.on('autonomy:monitor-triggered', async (event, { monitorId, onTrigger }) => {
    if (!onTrigger) return
    try {
      const { cogitate } = require('../cognition/cognitiveEngine')
      const result = await cogitate(onTrigger, { graphId: `mon_${monitorId}_${Date.now()}` })
      if (_win && !_win.isDestroyed()) {
        _win.webContents.send('autonomy-event', {
          type: 'monitor_task_done',
          monitorId,
          result: typeof result === 'string' ? result.slice(0, 500) : result,
        })
      }
    } catch (e) {
      if (_win && !_win.isDestroyed()) {
        _win.webContents.send('autonomy-event', { type: 'monitor_task_error', monitorId, error: e.message })
      }
    }
  })
}

module.exports = { init, scheduler, conditionMonitor }
