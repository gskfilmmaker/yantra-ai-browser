'use strict'
const tabManager = require('./tabManager')
const memoryStore = require('./memoryStore')

// Routes structured actions from Claude back into the browser/system.
// Returns a string result (or null if action unrecognised).

async function routeAction(action, params = {}, anthropic) {
  switch (action) {

    case 'summarizePage': {
      const page = await tabManager.getPageContent()
      if (!page) return 'No browser tab is active. Open a website first.'
      const res = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        messages: [{ role: 'user', content:
          `Summarize this page concisely. Include key points, main topic, and notable facts.\n\nTitle: ${page.title}\nURL: ${page.url}\n\n${page.content}`
        }],
      })
      const summary = res.content[0].text
      memoryStore.save({ type: 'summary', url: page.url, title: page.title, result: summary })
      return summary
    }

    case 'extractLinks': {
      const page = await tabManager.getPageContent()
      if (!page) return 'No browser tab is active.'
      if (!page.links?.length) return 'No links found on this page.'
      return page.links.slice(0, 30).map(l => `• [${l.text}](${l.href})`).join('\n')
    }

    case 'extractText': {
      const page = await tabManager.getPageContent()
      if (!page) return 'No browser tab is active.'
      const text = page.content?.slice(0, 4000) || '(empty)'
      memoryStore.save({ type: 'extract', url: page.url, title: page.title, result: text })
      return text
    }

    case 'openURL': {
      const url = params.url
      if (!url) return 'No URL provided.'
      const activeTab = tabManager.getActiveTab()
      if (activeTab?.type === 'browser') {
        tabManager.navigate(url)
        return `Navigating to ${url}`
      } else {
        tabManager.createTab({ type: 'browser', url })
        return `Opening ${url} in a new tab.`
      }
    }

    case 'compareAllTabs': {
      const all = await tabManager.getAllTabsContent()
      if (!all.length) return 'No browser tabs open to compare.'
      return all.map(t =>
        `**${t.title}** (${t.url})\n${(t.content?.content || '').slice(0, 600)}…`
      ).join('\n\n---\n\n')
    }

    case 'getPageContent': {
      const page = await tabManager.getPageContent()
      if (!page) return 'No browser tab is active.'
      return `**${page.title}**\n${page.url}\n\n${page.content?.slice(0, 3000)}`
    }

    default:
      return null
  }
}

module.exports = { routeAction }
