'use strict'
const registry     = require('./registry')
const personaEngine = require('../agents/personaEngine')

// ── listPersonas ──────────────────────────────────────────────────────────────

registry.register({
  name: 'listPersonas',
  description: 'List all available AI personas. Personas are persistent identities with accumulated memory and behavioral patterns that improve over time.',
  inputSchema: { type: 'object', properties: {} },

  async execute() {
    const personas = personaEngine.list()
    if (!personas.length) return 'No personas found.'
    const rows = personas.map(p =>
      `| ${p.avatar} **${p.name}** | ${p.description.slice(0, 60)}… | ${p.usageCount} tasks | ${p.memoryCount} memories |`
    ).join('\n')
    return `## Available Personas (${personas.length})\n\n| Persona | Description | Tasks | Memories |\n|---|---|---|---|\n${rows}`
  },
})

// ── createPersona ─────────────────────────────────────────────────────────────

registry.register({
  name: 'createPersona',
  description: 'Create a new AI persona with a custom name, personality, thinking style, and system prompt. The persona accumulates memory and improves across sessions.',

  inputSchema: {
    type: 'object',
    properties: {
      name:               { type: 'string', description: 'Persona name (e.g. "Alex the Analyst")' },
      avatar:             { type: 'string', description: 'Emoji avatar (e.g. "🔬")' },
      description:        { type: 'string', description: 'Personality and expertise description' },
      thinkingStyle:      { type: 'string', enum: ['first_principles', 'systems_thinking', 'creative', 'analytical', 'balanced'], description: 'How this persona approaches problems' },
      communicationStyle: { type: 'string', enum: ['concise_insightful', 'detailed', 'bullet_points', 'narrative'], description: 'How this persona communicates' },
      systemPromptAddition: { type: 'string', description: 'Custom system prompt extension for this persona' },
      preferredAgents:    { type: 'array', items: { type: 'string' }, description: 'Preferred agent names for this persona' },
    },
    required: ['name', 'description'],
  },

  async execute(config = {}) {
    if (!config.name || !config.description) return 'Error: name and description are required.'
    try {
      const id = personaEngine.create(config)
      return `✓ Persona created: **${config.avatar || '🤖'} ${config.name}**\n- **ID:** \`${id}\`\n- **Style:** ${config.thinkingStyle || 'balanced'} thinking, ${config.communicationStyle || 'detailed'} communication\n\nUse \`switchPersona\` to activate it.`
    } catch (e) {
      return `Error creating persona: ${e.message}`
    }
  },
})

// ── switchPersona ─────────────────────────────────────────────────────────────

registry.register({
  name: 'switchPersona',
  description: 'Activate a persona by name or ID. The persona\'s accumulated memory and behavioral patterns will be injected into subsequent conversations.',

  inputSchema: {
    type: 'object',
    properties: {
      nameOrId: { type: 'string', description: 'Persona name or ID to switch to' },
    },
    required: ['nameOrId'],
  },

  async execute({ nameOrId } = {}) {
    if (!nameOrId) return 'Error: nameOrId is required.'
    const persona = personaEngine.get(nameOrId)
    if (!persona) return `No persona found: "${nameOrId}". Use \`listPersonas\` to see available personas.`

    // Store active persona in settings for the session
    try {
      const settings = require('../settings')
      settings.set('activePersonaId', persona.id)
    } catch { /* non-fatal */ }

    const insights = personaEngine.getInsights(persona.id)
    return [
      `✓ Switched to **${persona.avatar} ${persona.name}**`,
      `_${persona.description}_`,
      '',
      insights?.memoryCount ? `📚 **${insights.memoryCount} memories** accumulated across ${insights.usageCount} tasks` : 'No prior sessions yet.',
      insights?.avgQuality  ? `📊 **Average quality score:** ${insights.avgQuality}%` : '',
      insights?.recentMemory?.length
        ? `\n**Recent learnings:**\n${insights.recentMemory.map(m => `- ${m}`).join('\n')}`
        : '',
    ].filter(Boolean).join('\n')
  },
})

// ── getPersonaInsights ────────────────────────────────────────────────────────

registry.register({
  name: 'getPersonaInsights',
  description: 'Get detailed insights about a persona — its accumulated memory, task history, quality scores, and learned behavioral patterns.',

  inputSchema: {
    type: 'object',
    properties: {
      nameOrId: { type: 'string', description: 'Persona name or ID' },
    },
    required: ['nameOrId'],
  },

  async execute({ nameOrId } = {}) {
    if (!nameOrId) return 'Error: nameOrId is required.'
    const insights = personaEngine.getInsights(nameOrId)
    if (!insights) return `No persona found: "${nameOrId}".`

    const lines = [
      `## ${insights.avatar} ${insights.name} — Insights`,
      `**Tasks completed:** ${insights.usageCount}  |  **Memories:** ${insights.memoryCount}  |  **Avg quality:** ${insights.avgQuality}%`,
    ]

    if (insights.topPatterns?.length) {
      lines.push('\n### Learned Workflow Patterns')
      for (const [pattern, count] of insights.topPatterns) {
        lines.push(`- **${pattern}** — used ${count} times`)
      }
    }

    if (insights.recentMemory?.length) {
      lines.push('\n### Recent Memory')
      for (const m of insights.recentMemory) lines.push(`- ${m}`)
    }

    if (insights.recentTasks?.length) {
      lines.push('\n### Recent Tasks')
      for (const t of insights.recentTasks) {
        lines.push(`- ${t.request} _(quality: ${Math.round((t.quality || 0) * 100)}%)_`)
      }
    }

    return lines.join('\n')
  },
})

// ── teachPersona ─────────────────────────────────────────────────────────────

registry.register({
  name: 'teachPersona',
  description: 'Explicitly teach a persona something — add a memory or insight that it will carry into future sessions.',

  inputSchema: {
    type: 'object',
    properties: {
      nameOrId: { type: 'string', description: 'Persona name or ID' },
      insight:  { type: 'string', description: 'What the persona should learn and remember' },
    },
    required: ['nameOrId', 'insight'],
  },

  async execute({ nameOrId, insight } = {}) {
    if (!nameOrId || !insight) return 'Error: nameOrId and insight are required.'
    const persona = personaEngine.get(nameOrId)
    if (!persona) return `No persona found: "${nameOrId}".`
    personaEngine.learn(persona.id, insight)
    return `✓ **${persona.name}** has learned: _"${insight.slice(0, 100)}"_\nThis will be recalled in future sessions.`
  },
})
