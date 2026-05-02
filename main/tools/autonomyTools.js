'use strict'
const registry = require('./registry')

// ── scheduleTask ──────────────────────────────────────────────────────────────

registry.register({
  name: 'scheduleTask',
  description: `Schedule an autonomous agent task to run automatically on a repeating interval.

The cognitive engine (cogitate) runs the request at the specified interval — without any user interaction.

Examples:
- Every morning check crypto prices: interval "daily", request "Research current BTC and ETH prices, save to memory"
- Every hour monitor competitor: interval "1h", request "Check competitor pricing page for changes"
- Every 30 min check emails: interval "30m", request "Summarize any new content on the page"`,

  inputSchema: {
    type: 'object',
    properties: {
      name:           { type: 'string', description: 'Human-readable name for this schedule' },
      interval:       { type: 'string', description: 'How often to run: "30s", "5m", "1h", "12h", "daily"' },
      request:        { type: 'string', description: 'The task to cogitate at each interval' },
      runImmediately: { type: 'boolean', description: 'Run once immediately on creation (default: false)' },
    },
    required: ['name', 'interval', 'request'],
  },

  async execute({ name, interval, request, runImmediately = false } = {}) {
    if (!name || !interval || !request) return 'Error: name, interval, and request are required.'
    try {
      const { scheduler } = require('../autonomy/autonomyEngine')
      const id = scheduler.schedule(name, interval, request, { runImmediately })
      return `✓ Schedule created: **${name}**\n- **ID:** \`${id}\`\n- **Interval:** every ${interval}\n- **Task:** ${request.slice(0, 100)}\n\nThe cognitive engine will run this autonomously. Use \`listSchedules\` to see all schedules.`
    } catch (e) {
      return `Error creating schedule: ${e.message}`
    }
  },
})

// ── listSchedules ─────────────────────────────────────────────────────────────

registry.register({
  name: 'listSchedules',
  description: 'List all autonomous scheduled tasks and their status.',
  inputSchema: { type: 'object', properties: {} },

  async execute() {
    try {
      const { scheduler } = require('../autonomy/autonomyEngine')
      const schedules = scheduler.list()
      if (!schedules.length) return 'No schedules running. Use `scheduleTask` to create one.'

      const rows = schedules.map(s =>
        `| \`${s.id.slice(-8)}\` | ${s.name} | ${s.interval} | ${s.runCount} runs | ${s.lastRun ? s.lastRun.slice(0, 16) : 'never'} | ${s.enabled ? '▶ active' : '⏸ paused'} |`
      ).join('\n')
      return `## Autonomous Schedules (${schedules.length})\n\n| ID | Name | Interval | Runs | Last Run | Status |\n|---|---|---|---|---|---|\n${rows}`
    } catch (e) {
      return `Error listing schedules: ${e.message}`
    }
  },
})

// ── cancelSchedule ────────────────────────────────────────────────────────────

registry.register({
  name: 'cancelSchedule',
  description: 'Cancel (permanently delete) an autonomous scheduled task.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Schedule ID to cancel' },
    },
    required: ['id'],
  },

  async execute({ id } = {}) {
    if (!id) return 'Error: id is required.'
    try {
      const { scheduler } = require('../autonomy/autonomyEngine')
      const ok = scheduler.cancel(id)
      return ok ? `✓ Schedule \`${id}\` cancelled.` : `No schedule found with ID \`${id}\`.`
    } catch (e) {
      return `Error cancelling schedule: ${e.message}`
    }
  },
})

// ── watchPage ─────────────────────────────────────────────────────────────────

registry.register({
  name: 'watchPage',
  description: `Monitor a web page for changes and trigger an autonomous action when a condition is met.

Condition types:
- text_appears    — trigger when specific text appears on the page
- text_disappears — trigger when text disappears from the page
- any_change      — trigger when any significant content change is detected

When triggered, optionally runs a cogitate request automatically.`,

  inputSchema: {
    type: 'object',
    properties: {
      name:      { type: 'string', description: 'Human-readable monitor name' },
      url:       { type: 'string', description: 'URL to monitor' },
      condition: {
        type: 'object',
        description: 'Trigger condition',
        properties: {
          type:  { type: 'string', enum: ['text_appears', 'text_disappears', 'any_change'] },
          value: { type: 'string', description: 'Text to watch for (not needed for any_change)' },
        },
        required: ['type'],
      },
      interval:  { type: 'string', description: 'How often to check: "5m", "1h", "daily"' },
      onTrigger: { type: 'string', description: 'Optional cogitate request to run automatically when condition fires' },
    },
    required: ['name', 'url', 'condition'],
  },

  async execute({ name, url, condition, interval = '5m', onTrigger } = {}) {
    if (!name || !url || !condition) return 'Error: name, url, and condition are required.'
    try {
      const { conditionMonitor } = require('../autonomy/autonomyEngine')
      const id = conditionMonitor.watch(name, url, condition, interval, { onTrigger })
      const lines = [
        `✓ Monitor created: **${name}**`,
        `- **ID:** \`${id}\``,
        `- **URL:** ${url}`,
        `- **Condition:** ${condition.type}${condition.value ? ` ("${condition.value}")` : ''}`,
        `- **Check interval:** every ${interval}`,
        onTrigger ? `- **On trigger:** ${onTrigger.slice(0, 80)}` : '',
      ].filter(Boolean)
      return lines.join('\n')
    } catch (e) {
      return `Error creating monitor: ${e.message}`
    }
  },
})

// ── listMonitors ──────────────────────────────────────────────────────────────

registry.register({
  name: 'listMonitors',
  description: 'List all active page monitors.',
  inputSchema: { type: 'object', properties: {} },

  async execute() {
    try {
      const { conditionMonitor } = require('../autonomy/autonomyEngine')
      const monitors = conditionMonitor.list()
      if (!monitors.length) return 'No monitors running. Use `watchPage` to create one.'
      const rows = monitors.map(m =>
        `| \`${m.id.slice(-8)}\` | ${m.name} | ${m.url.slice(0, 40)} | ${m.condition.type} | ${m.triggerCount} | ${m.interval} |`
      ).join('\n')
      return `## Page Monitors (${monitors.length})\n\n| ID | Name | URL | Condition | Triggers | Interval |\n|---|---|---|---|---|---|\n${rows}`
    } catch (e) {
      return `Error listing monitors: ${e.message}`
    }
  },
})
