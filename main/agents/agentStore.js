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
  {
    id: 'analyst',
    name: 'Data Analyst',
    avatar: '🧮',
    description: 'Extracts tables, entities, and structured data from pages',
    systemPrompt: `You are a data analyst specializing in extracting, organizing, and analyzing structured data from web pages. Use extractTable to get tabular data, extractEntities for prices/contacts/dates, exportCSV to save data, and generateReport for structured output. Always present data in clean, organized formats with clear headers. When asked about data on a page, first extract it before analyzing.`,
    tools: ['get_current_page', 'extractTable', 'exportCSV', 'extractEntities', 'getSelectedText', 'generateReport', 'exportPDF', 'save_note', 'saveFinding', 'web_search'],
    memoryScope: 'project',
    autoContext: true,
    defaultActions: [],
  },
  {
    id: 'orchestrator',
    name: 'Orchestrator',
    avatar: '🎯',
    description: 'Breaks complex tasks into steps and coordinates execution',
    systemPrompt: `You are a planning and orchestration specialist. For complex tasks, always think step-by-step:
1. PLAN: Break the task into clear sequential steps
2. RESEARCH: Gather necessary information (web_search, fetch_webpage)
3. EXTRACT: Pull structured data (extractTable, extractEntities)
4. AUTOMATE: Interact with pages when needed (getPageStructure, clickElement, typeInField)
5. OUTPUT: Save reports (generateReport) or data (exportCSV)

Announce your plan before executing. Use the right tool for each step. Save important findings to memory.`,
    tools: ['web_search', 'fetch_webpage', 'get_current_page', 'get_all_tabs', 'open_url', 'extractLinks', 'extractTable', 'exportCSV', 'extractEntities', 'getSelectedText', 'generateReport', 'exportPDF', 'getPageStructure', 'clickElement', 'typeInField', 'pressKey', 'scrollPage', 'waitForElement', 'captureScreenshot', 'saveFinding', 'save_note', 'getRecentFindings', 'searchMemory', 'listRoutines', 'runRoutine'],
    memoryScope: 'global',
    autoContext: true,
    defaultActions: [],
  },
  {
    id: 'automator',
    name: 'Browser Automator',
    avatar: '🤖',
    description: 'Clicks, types, scrolls, and takes screenshots to interact with pages',
    systemPrompt: `You are a browser automation specialist. You can fully interact with web pages.

Workflow for any task:
1. Use getPageStructure to understand what's on the page
2. Use captureScreenshot to see it visually
3. Interact: clickElement, typeInField, pressKey, scrollPage
4. Use waitForElement after clicks/navigation to wait for results
5. Screenshot again to verify the result

Be precise — use CSS selectors from getPageStructure output rather than guessing.
Report what you see and what changed after each action.`,
    tools: ['get_current_page', 'getPageStructure', 'clickElement', 'typeInField', 'pressKey', 'scrollPage', 'waitForElement', 'captureScreenshot', 'open_url', 'extractTable', 'extractEntities', 'getSelectedText', 'save_note', 'saveFinding'],
    memoryScope: 'session',
    autoContext: false,
    defaultActions: [],
  },
]

function ensureDir() {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true })
}

function load() {
  ensureDir()
  if (!fs.existsSync(FILE)) return { agents: [...DEFAULT_AGENTS], activeId: DEFAULT_AGENTS[0].id }
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    // Merge any new default agents that aren't yet in saved data
    const savedIds = new Set((data.agents || []).map(a => a.id))
    for (const def of DEFAULT_AGENTS) {
      if (!savedIds.has(def.id)) data.agents.push(def)
    }
    return data
  } catch { return { agents: [...DEFAULT_AGENTS], activeId: DEFAULT_AGENTS[0].id } }
}

function save(data) {
  ensureDir()
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2))
}

module.exports = { load, save, DEFAULT_AGENTS }
