'use strict'
const { register } = require('./registry')

// tabManager imported lazily to avoid load-order issues
const tm = () => require('../tabManager')

register({
  name: 'get_current_page',
  description: "Get the title, URL, text content, and links of the currently active browser tab. Use when user says 'this page', 'current page', 'what I'm reading', etc.",
  inputSchema: { type: 'object', properties: {} },
  async execute() {
    const page = await tm().getPageContent()
    if (!page) return 'No browser tab is active. Open a website first.'
    const links = page.links?.slice(0, 20).map(l => `• [${l.text}](${l.href})`).join('\n') || ''
    return `Title: ${page.title}\nURL: ${page.url}\n\nContent:\n${page.content}\n\nLinks:\n${links}`
  },
})

register({
  name: 'get_all_tabs',
  description: 'Get content from all open browser tabs. Use for comparison or multi-source analysis.',
  inputSchema: { type: 'object', properties: {} },
  async execute() {
    const tabs = await tm().getAllTabsContent()
    if (!tabs.length) return 'No browser tabs are open.'
    return tabs.map(t =>
      `**${t.title}** (${t.url})\n${(t.content?.content || '').slice(0, 800)}`
    ).join('\n\n---\n\n')
  },
})

register({
  name: 'open_url',
  description: 'Navigate the browser to a URL or open it in a new tab.',
  inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'Full URL to open' } }, required: ['url'] },
  execute({ url }) {
    const active = tm().getActiveTab()
    if (active?.type === 'browser') { tm().navigate(url); return `Navigating to ${url}` }
    tm().createTab({ type: 'browser', url })
    return `Opening ${url} in new tab.`
  },
})

register({
  name: 'extractLinks',
  description: 'Extract all hyperlinks from the current page.',
  inputSchema: { type: 'object', properties: {} },
  async execute() {
    const page = await tm().getPageContent()
    if (!page?.links?.length) return 'No links found or no active page.'
    return page.links.slice(0, 50).map(l => `• [${l.text}](${l.href})`).join('\n')
  },
})

register({
  name: 'compareTabs',
  description: 'Compare content across all open browser tabs side by side.',
  inputSchema: { type: 'object', properties: {} },
  async execute() {
    const tabs = await tm().getAllTabsContent()
    if (tabs.length < 2) return 'Need at least 2 open tabs to compare.'
    return tabs.map(t =>
      `### ${t.title}\n**URL:** ${t.url}\n${(t.content?.content || '').slice(0, 600)}`
    ).join('\n\n---\n\n')
  },
})
