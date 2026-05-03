'use strict'
const registry = require('../tools/registry')

const MAX_TURNS = 12

// ── OpenAI helpers ────────────────────────────────────────────────────────────

function toOpenAITools(anthropicTools) {
  return anthropicTools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }))
}

function toOpenAIMessages(systemPrompt, anthropicMessages) {
  const result = [{ role: 'system', content: systemPrompt }]
  for (const msg of anthropicMessages) {
    if (typeof msg.content === 'string') {
      result.push({ role: msg.role, content: msg.content })
      continue
    }
    if (!Array.isArray(msg.content)) continue
    if (msg.role === 'assistant') {
      const text = msg.content.find(b => b.type === 'text')?.text || ''
      const tcs  = msg.content.filter(b => b.type === 'tool_use')
      if (tcs.length) {
        result.push({
          role: 'assistant', content: text || null,
          tool_calls: tcs.map(tc => ({
            id: tc.id, type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.input) },
          })),
        })
      } else if (text) {
        result.push({ role: 'assistant', content: text })
      }
    } else if (msg.role === 'user') {
      const trs   = msg.content.filter(b => b.type === 'tool_result')
      const texts = msg.content.filter(b => b.type === 'text')
      for (const tr of trs) {
        const content = typeof tr.content === 'string'
          ? tr.content
          : Array.isArray(tr.content)
            ? tr.content.map(c => c.type === 'text' ? c.text : '[image]').join('')
            : ''
        result.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: content || '' })
      }
      if (texts.length) result.push({ role: 'user', content: texts.map(t => t.text).join('') })
    }
  }
  return result
}

// ── Anthropic agent loop ──────────────────────────────────────────────────────

async function runAgentLoopAnthropic({ event, sessionId, message, history, systemPrompt, tools }) {
  const Anthropic = require('@anthropic-ai/sdk')
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

    // Batch text snapshots every 60 ms to avoid IPC flood (O(n²) bytes → O(1))
    let _snap = '', _snapTimer = null
    const _flushSnap = () => {
      if (_snap && !event.sender.isDestroyed())
        event.sender.send('agent-event', { sessionId, type: 'text', text: _snap })
      _snapTimer = null
    }
    stream.on('text', (_, snapshot) => {
      _snap = snapshot
      if (!_snapTimer) _snapTimer = setTimeout(_flushSnap, 60)
    })

    const response = await stream.finalMessage()
    // Flush any buffered text after stream ends
    clearTimeout(_snapTimer)
    _flushSnap()

    if (response.stop_reason === 'end_turn') {
      messages.push({ role: 'assistant', content: response.content })
      break
    }

    if (response.stop_reason === 'tool_use') {
      const toolBlocks  = response.content.filter(b => b.type === 'tool_use')
      const toolResults = []
      for (const tb of toolBlocks) {
        event.sender.send('agent-event', { sessionId, type: 'tool_call', toolId: tb.id, toolName: tb.name, toolInput: tb.input })
        const result = await registry.execute(tb.name, tb.input, { sessionId })
        event.sender.send('agent-event', { sessionId, type: 'tool_result', toolId: tb.id, toolName: tb.name, result })
        let apiContent
        if (typeof result === 'string' && result.startsWith('data:image/')) {
          const isJpeg = result.startsWith('data:image/jpeg;base64,')
          const prefix = isJpeg ? 'data:image/jpeg;base64,' : 'data:image/png;base64,'
          apiContent = [{ type: 'image', source: { type: 'base64', media_type: isJpeg ? 'image/jpeg' : 'image/png', data: result.slice(prefix.length) } }]
        } else {
          apiContent = result
        }
        toolResults.push({ type: 'tool_result', tool_use_id: tb.id, content: apiContent })
      }
      messages.push({ role: 'assistant', content: response.content })
      messages.push({ role: 'user',      content: toolResults })
      continue
    }

    break
  }

  return messages
}

// ── OpenAI agent loop ─────────────────────────────────────────────────────────

async function runAgentLoopOpenAI({ event, sessionId, message, history, systemPrompt, tools }) {
  const { OpenAI } = require('openai')
  const openai     = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  const openaiTools = tools.length ? toOpenAITools(tools) : undefined
  const messages    = toOpenAIMessages(systemPrompt, history || [])
  messages.push({ role: 'user', content: message })

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const stream = await openai.chat.completions.create({
      model: 'gpt-4o', max_tokens: 4096,
      messages, tools: openaiTools, stream: true,
    })

    let textSoFar   = ''
    let finishReason = null
    const tcMap     = {}
    // Batch OpenAI text deltas every 60 ms
    let _oaiTimer = null
    const _flushOai = () => {
      if (textSoFar && !event.sender.isDestroyed())
        event.sender.send('agent-event', { sessionId, type: 'text', text: textSoFar })
      _oaiTimer = null
    }

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta
      const fr    = chunk.choices[0]?.finish_reason
      if (fr) finishReason = fr

      if (delta?.content) {
        textSoFar += delta.content
        if (!_oaiTimer) _oaiTimer = setTimeout(_flushOai, 60)
      }

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (!tcMap[tc.index]) tcMap[tc.index] = { id: '', type: 'function', function: { name: '', arguments: '' } }
          if (tc.id)                     tcMap[tc.index].id = tc.id
          if (tc.function?.name)         tcMap[tc.index].function.name      += tc.function.name
          if (tc.function?.arguments)    tcMap[tc.index].function.arguments += tc.function.arguments
        }
      }
    }

    // Flush remaining buffered text
    clearTimeout(_oaiTimer)
    _flushOai()

    const toolCalls = Object.values(tcMap)

    if (!toolCalls.length || finishReason === 'stop') {
      messages.push({ role: 'assistant', content: textSoFar })
      break
    }

    messages.push({ role: 'assistant', content: textSoFar || null, tool_calls: toolCalls })

    for (const tc of toolCalls) {
      let input = {}
      try { input = JSON.parse(tc.function.arguments) } catch {}
      event.sender.send('agent-event', { sessionId, type: 'tool_call', toolId: tc.id, toolName: tc.function.name, toolInput: input })
      const result = await registry.execute(tc.function.name, input, { sessionId })
      event.sender.send('agent-event', { sessionId, type: 'tool_result', toolId: tc.id, toolName: tc.function.name, result })
      const content = typeof result === 'string' && result.startsWith('data:image/')
        ? '[screenshot captured]'
        : typeof result === 'string' ? result : JSON.stringify(result)
      messages.push({ role: 'tool', tool_call_id: tc.id, content })
    }
  }

  return messages
}

// ── Provider router with auto-fallback ────────────────────────────────────────

async function runAgentLoop({ event, sessionId, message, history, systemPrompt, tools }) {
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY
  const hasOpenAI    = !!process.env.OPENAI_API_KEY
  const preferred    = process.env.PREFERRED_PROVIDER || 'anthropic'

  if (!hasAnthropic && !hasOpenAI) {
    throw new Error('Set ANTHROPIC_API_KEY or OPENAI_API_KEY in Settings.')
  }

  const primaryIsAnthropic = hasAnthropic && (preferred !== 'openai')

  if (primaryIsAnthropic) {
    try {
      return await runAgentLoopAnthropic({ event, sessionId, message, history, systemPrompt, tools })
    } catch (err) {
      const isOverload = err.status === 529 || err.status === 429 ||
        /overload|rate.?limit/i.test(err.message || '')
      if (isOverload && hasOpenAI) {
        event.sender.send('agent-event', { sessionId, type: 'text', text: '⚠️ Claude is busy — retrying with GPT-4o…\n\n' })
        return await runAgentLoopOpenAI({ event, sessionId, message, history, systemPrompt, tools })
      }
      throw err
    }
  } else {
    try {
      return await runAgentLoopOpenAI({ event, sessionId, message, history, systemPrompt, tools })
    } catch (err) {
      const isOverload = /rate.?limit|overload/i.test(err.message || '')
      if (isOverload && hasAnthropic) {
        event.sender.send('agent-event', { sessionId, type: 'text', text: '⚠️ GPT-4o rate limited — retrying with Claude…\n\n' })
        return await runAgentLoopAnthropic({ event, sessionId, message, history, systemPrompt, tools })
      }
      throw err
    }
  }
}

module.exports = { runAgentLoop }
