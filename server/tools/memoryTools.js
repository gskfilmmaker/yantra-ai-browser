'use strict'
/**
 * SQLite-backed memory tools using better-sqlite3.
 * Allows the agent to save notes, retrieve recent notes, and search memory.
 */

const { register } = require('./registry')
const { saveNote, getRecentNotes, searchMemoryDb } = require('../db')

register({
  name: 'save_note',
  description: 'Save an important note, finding, fact, or insight to persistent memory for later retrieval.',
  inputSchema: {
    type: 'object',
    properties: {
      title:   { type: 'string', description: 'Short descriptive title for the note' },
      content: { type: 'string', description: 'The content, finding, or insight to save' },
      tags:    { type: 'array', items: { type: 'string' }, description: 'Optional topic tags for categorization' },
    },
    required: ['title', 'content'],
  },
  execute({ title, content, tags = [] } = {}) {
    if (!title)   return 'Error: title is required'
    if (!content) return 'Error: content is required'
    const id = saveNote(title, content, tags)
    return `Saved note #${id}: "${title}"`
  },
})

register({
  name: 'get_recent_notes',
  description: 'Retrieve recent saved notes and findings from memory, newest first.',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Maximum number of notes to return (default: 10)' },
    },
  },
  execute({ limit = 10 } = {}) {
    const notes = getRecentNotes(Math.min(limit || 10, 50))
    if (!notes.length) return 'No notes saved yet.'
    return notes.map(n => {
      const date = new Date(n.created_at).toISOString().slice(0, 10)
      const tags = n.tags.length ? ` [${n.tags.join(', ')}]` : ''
      return `**${n.title}**${tags} (${date})\n${n.content.slice(0, 400)}`
    }).join('\n\n---\n\n')
  },
})

register({
  name: 'search_memory',
  description: 'Search saved notes and findings by keyword. Returns matching notes.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Keyword or phrase to search for' },
    },
    required: ['query'],
  },
  execute({ query } = {}) {
    if (!query) return 'Error: query is required'
    const matches = searchMemoryDb(query)
    if (!matches.length) return `No notes found matching "${query}".`
    return matches.map(n => {
      const date = new Date(n.created_at).toISOString().slice(0, 10)
      const tags = n.tags.length ? ` [${n.tags.join(', ')}]` : ''
      return `**${n.title}**${tags} (${date})\n${n.content.slice(0, 400)}`
    }).join('\n\n---\n\n')
  },
})
