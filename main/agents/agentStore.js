'use strict'
const fs   = require('fs')
const path = require('path')
const os   = require('os')

const DIR  = path.join(os.homedir(), '.strawberry')
const FILE = path.join(DIR, 'agents.json')

const DEFAULT_AGENTS = [
  {
    id: 'research',
    name: 'Research Agent',
    avatar: '🔍',
    description: 'Deep web research, fact-checking, multi-source analysis',
    systemPrompt: `You are a meticulous research specialist. Search the web thoroughly, verify facts across multiple sources, and present findings with clear citations. Always use web_search before answering factual questions. Chain tools to go deep on complex topics.`,
    personality: 'thorough, analytical, citation-focused',
    tools: ['web_search', 'fetch_webpage', 'get_current_page', 'get_all_tabs', 'open_url', 'extractLinks', 'saveFinding', 'save_note', 'getRecentFindings', 'searchMemory'],
    memoryScope: 'global',
    autoContext: true,
    defaultActions: ['summarizePage', 'extractLinks'],
  },
  {
    id: 'summarizer',
    name: 'Summarizer',
    avatar: '📝',
    description: 'Quick, structured summaries of any content',
    systemPrompt: `You are a precise content summarizer. Extract the most important information, present it concisely with clear structure, and highlight key takeaways. Avoid unnecessary detail. Use bullet points and headers.`,
    personality: 'concise, structured, clarity-focused',
    tools: ['get_current_page', 'get_all_tabs', 'fetch_webpage', 'saveFinding', 'save_note'],
    memoryScope: 'session',
    autoContext: true,
    defaultActions: ['summarizePage'],
  },
  {
    id: 'coder',
    name: 'Coding Agent',
    avatar: '💻',
    description: 'Code review, debugging, technical documentation',
    systemPrompt: `You are a senior software engineer. Write clean, efficient code, spot bugs quickly, explain technical concepts clearly, and suggest best practices. Look up documentation when needed. Format code with proper syntax highlighting.`,
    personality: 'precise, technical, best-practices focused',
    tools: ['web_search', 'fetch_webpage', 'get_current_page', 'saveFinding', 'save_note'],
    memoryScope: 'project',
    autoContext: false,
    defaultActions: [],
  },
]

function ensureDir() {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true })
}

function load() {
  ensureDir()
  if (!fs.existsSync(FILE)) return { agents: DEFAULT_AGENTS, activeId: DEFAULT_AGENTS[0].id }
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) }
  catch { return { agents: DEFAULT_AGENTS, activeId: DEFAULT_AGENTS[0].id } }
}

function save(data) {
  ensureDir()
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2))
}

module.exports = { load, save, DEFAULT_AGENTS }
