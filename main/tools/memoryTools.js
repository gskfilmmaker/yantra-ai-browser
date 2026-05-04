'use strict'
const { register } = require('./registry')
const mem = () => require('../memoryStore')

register({
  name: 'saveFinding',
  description: 'Save a key finding, fact, summary, or insight to persistent memory for later retrieval.',
  inputSchema: {
    type: 'object',
    properties: {
      title:   { type: 'string', description: 'Short descriptive title' },
      content: { type: 'string', description: 'The finding or insight to save' },
      tags:    { type: 'array', items: { type: 'string' }, description: 'Optional topic tags' },
    },
    required: ['title', 'content'],
  },
  execute({ title, content, tags = [] }) {
    mem().save({ type: 'finding', title, result: content, tags })
    return `Saved finding: "${title}"`
  },
})

register({
  name: 'getRecentFindings',
  description: 'Retrieve recent saved findings and research results from memory.',
  inputSchema: { type: 'object', properties: { limit: { type: 'number', description: 'Max results (default 10)' } } },
  execute({ limit = 10 } = {}) {
    const items = mem().getHistory(limit)
    if (!items.length) return 'No findings in memory yet.'
    return items
      .map(i => `**${i.title || i.type}** (${(i.timestamp || '').slice(0, 10)})\n${(i.result || '').slice(0, 300)}`)
      .join('\n\n---\n\n')
  },
})

register({
  name: 'searchMemory',
  description: 'Search past findings, research, and saved content by keyword.',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  execute({ query }) {
    return mem().search(query)
  },
})
