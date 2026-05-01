'use strict'
const tabManager  = require('../tabManager')
const memoryStore = require('../memoryStore')

async function buildContext({ agent, userPrompt }) {
  const blocks = {}

  // ── 1. Auto-inject current page if agent wants it ────────────────────────
  if (agent.autoContext) {
    const page = await tabManager.getPageContent()
    if (page && page.url && !page.url.startsWith('about:')) {
      blocks.page = {
        title:   page.title,
        url:     page.url,
        content: (page.content || '').slice(0, 3000),
      }
    }
  }

  // ── 2. Relevant recent memory ─────────────────────────────────────────────
  const recent = memoryStore.getHistory(4)
  if (recent.length) {
    blocks.memory = recent
      .map(m => `${m.title || m.type}: ${(m.result || '').slice(0, 200)}`)
      .join('\n')
  }

  // ── 3. Build system prompt from agent config ──────────────────────────────
  let systemPrompt = agent.systemPrompt || 'You are Yantra, a production AI browser automation platform.'
  systemPrompt += `\n\nACTIVE AGENT: ${agent.name}`
  if (agent.personality) systemPrompt += ` — ${agent.personality}`
  systemPrompt += `\n\nCore rules:\n- Use tools proactively to complete tasks\n- Save important findings with saveFinding\n- Be specific, cite URLs as sources\n- Chain multiple tools for complex research`

  // ── 4. Build context prefix prepended to user message ────────────────────
  const parts = []

  if (blocks.page) {
    parts.push(
      `CURRENT PAGE:\nTitle: ${blocks.page.title}\nURL: ${blocks.page.url}\nContent:\n${blocks.page.content}`
    )
  }

  if (blocks.memory) {
    parts.push(`RELEVANT MEMORY:\n${blocks.memory}`)
  }

  return {
    systemPrompt,
    contextBlocks: blocks,
    // Non-empty only if there's real context to inject
    contextPrefix: parts.length ? parts.join('\n\n---\n\n') : '',
  }
}

module.exports = { buildContext }
