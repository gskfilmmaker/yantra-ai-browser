'use strict'
const registry = require('../tools/registry')

const MAX_TURNS = 12

/**
 * Full streaming agent loop.
 *
 * @param {object} opts
 *   event        – IPC event (for sending back to renderer)
 *   sessionId    – tab/session ID
 *   message      – user message (may include context prefix)
 *   history      – prior messages [{role, content}]
 *   systemPrompt – built by contextEngine
 *   tools        – Anthropic-format schemas (from registry.schemasForAgent)
 *
 * @returns {Array} final messages array (history + this turn)
 */
async function runAgentLoop({ event, sessionId, message, history, systemPrompt, tools }) {
  let Anthropic
  try   { Anthropic = require('@anthropic-ai/sdk') }
  catch { throw new Error('Run: npm install') }

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('Set ANTHROPIC_API_KEY and restart the app.')
  }

  const anthropic = new Anthropic()
  const messages  = [...(history || []), { role: 'user', content: message }]

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const stream = anthropic.messages.stream({
      model:      'claude-sonnet-4-6',
      max_tokens: 4096,
      system:     [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      tools:      tools.length ? tools : undefined,
      messages,
    })

    // Stream text tokens live to renderer
    stream.on('text', (_, snapshot) => {
      event.sender.send('agent-event', { sessionId, type: 'text', text: snapshot })
    })

    const response = await stream.finalMessage()

    if (response.stop_reason === 'end_turn') {
      messages.push({ role: 'assistant', content: response.content })
      break
    }

    if (response.stop_reason === 'tool_use') {
      const toolBlocks  = response.content.filter(b => b.type === 'tool_use')
      const toolResults = []

      for (const tb of toolBlocks) {
        event.sender.send('agent-event', {
          sessionId, type: 'tool_call',
          toolId: tb.id, toolName: tb.name, toolInput: tb.input,
        })

        const result = await registry.execute(tb.name, tb.input, { sessionId })

        event.sender.send('agent-event', {
          sessionId, type: 'tool_result',
          toolId: tb.id, toolName: tb.name, result,
        })

        toolResults.push({ type: 'tool_result', tool_use_id: tb.id, content: result })
      }

      messages.push({ role: 'assistant', content: response.content })
      messages.push({ role: 'user', content: toolResults })
      continue
    }

    break
  }

  return messages
}

module.exports = { runAgentLoop }
