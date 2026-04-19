'use strict'
const { register } = require('./registry')

register({
  name: 'listRoutines',
  description: 'List all saved automation routines.',
  inputSchema: { type: 'object', properties: {} },
  execute() {
    const rm = require('../routines/routineManager')
    const list = rm.listRoutines()
    if (!list.length) return 'No routines saved yet. Create one to automate repetitive tasks.'
    return list
      .map(r => `**${r.name}** [${r.enabled ? 'enabled' : 'disabled'}]\n${r.description || ''}\nTrigger: ${r.trigger?.type || 'manual'}`)
      .join('\n\n')
  },
})

register({
  name: 'runRoutine',
  description: 'Run a saved automation routine by name.',
  inputSchema: {
    type: 'object',
    properties: { name: { type: 'string', description: 'Routine name or ID' } },
    required: ['name'],
  },
  async execute({ name }, ctx) {
    const rm = require('../routines/routineManager')
    const routine = rm.listRoutines().find(
      r => r.name.toLowerCase() === name.toLowerCase() || r.id === name
    )
    if (!routine) return `Routine "${name}" not found. Use listRoutines to see available routines.`
    return rm.runRoutine(routine.id, ctx)
  },
})
