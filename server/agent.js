'use strict'
/**
 * Agent loop for the headless server.
 * Adapted from main/ai/llmClient.js — replaces event.sender.send with emitEvent().
 *
 * runAgentLoop({
 *   sessionId,     string
 *   message,       string — current user message
 *   history,       array  — prior Anthropic-format messages
 *   systemPrompt,  string
 *   tools,         array  — Anthropic tool schemas (from registry.schemasForAgent)
 *   emitEvent,     fn(type, data) — sends SSE event to client
 *   isCancelled,   fn() → bool
 *   getInterrupt,  fn() → string|null
 *   onCheckpoint,  fn(messages) — called after each turn for persistence
 * })
 */

const registry = require('./tools/registry')

const MAX_TURNS = 40

// ── OpenAI helpers ─────────────────────────────────────────────────────────────

function toOpenAITools(anthropicTools) {
  return anthropicTools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }))
}

function toOpenAIMessages(systemPrompt, anthropicMessages) {
  const result = [{ role: 'system', content: systemPrompt }]
  for (const msg of anthropicMessages) {
    if (msg.role === 'system') continue
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

// ── Anthropic agent loop ───────────────────────────────────────────────────────

async function runAgentLoopAnthropic({ sessionId, message, history, systemPrompt, tools, emitEvent, isCancelled, getInterrupt, onCheckpoint }) {
  const Anthropic = require('@anthropic-ai/sdk')
  const anthropic = new Anthropic()

  // Strip OpenAI-format entries that may have leaked via provider fallback
  const safeHistory = (history || []).filter(m => {
    if (m.role !== 'user' && m.role !== 'assistant') return false
    if (m.content === null || m.content === undefined) return false
    if (typeof m.content === 'string') return m.content.length > 0
    if (Array.isArray(m.content)) return m.content.length > 0
    return false
  })

  const messages  = [...safeHistory, { role: 'user', content: message }]
  const startTime = Date.now()

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (isCancelled && isCancelled()) {
      emitEvent('text', { text: '⛔ Task cancelled.' })
      break
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000)
    emitEvent('progress', { turn: turn + 1, maxTurns: MAX_TURNS, elapsed })

    const stream = anthropic.messages.stream({
      model:      'claude-sonnet-4-6',
      max_tokens: 4096,
      system:     [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      tools:      tools.length ? tools : undefined,
      messages,
    })

    // Batch text snapshots every 60 ms to avoid SSE flood
    let _snap = '', _snapTimer = null
    const _flushSnap = () => {
      if (_snap) emitEvent('text', { text: _snap })
      _snapTimer = null
    }
    stream.on('text', (_, snapshot) => {
      _snap = snapshot
      if (!_snapTimer) _snapTimer = setTimeout(_flushSnap, 60)
    })

    const response = await stream.finalMessage()
    clearTimeout(_snapTimer)
    _flushSnap()

    if (response.stop_reason === 'end_turn') {
      messages.push({ role: 'assistant', content: response.content })
      if (onCheckpoint) onCheckpoint(messages)
      break
    }

    if (response.stop_reason === 'tool_use') {
      const toolBlocks  = response.content.filter(b => b.type === 'tool_use')
      const toolResults = []

      for (const tb of toolBlocks) {
        emitEvent('tool_call', { toolId: tb.id, toolName: tb.name, toolInput: tb.input })

        const result = await registry.execute(tb.name, tb.input, { sessionId })

        emitEvent('tool_result', { toolId: tb.id, toolName: tb.name, result })

        let apiContent
        if (typeof result === 'string' && result.startsWith('data:image/')) {
          const isJpeg = result.startsWith('data:image/jpeg;base64,')
          const prefix = isJpeg ? 'data:image/jpeg;base64,' : 'data:image/png;base64,'
          const b64    = result.slice(prefix.length)
          if (b64.length > 0) {
            apiContent = [{
              type: 'image',
              source: { type: 'base64', media_type: isJpeg ? 'image/jpeg' : 'image/png', data: b64 },
            }]
          } else {
            apiContent = '[screenshot capture failed — page may not have loaded yet]'
          }
        } else {
          apiContent = result
        }

        toolResults.push({ type: 'tool_result', tool_use_id: tb.id, content: apiContent })
      }

      messages.push({ role: 'assistant', content: response.content })
      messages.push({ role: 'user',      content: toolResults })
      if (onCheckpoint) onCheckpoint(messages)

      // Inject any user interrupt sent while agent was running
      const interrupt = getInterrupt && getInterrupt()
      if (interrupt) {
        emitEvent('interrupt_ack', { text: interrupt })
        messages.push({ role: 'user', content: `[USER CORRECTION — respond to this immediately]: ${interrupt}` })
      }

      if (isCancelled && isCancelled()) {
        emitEvent('text', { text: '⛔ Task cancelled.' })
        break
      }
      continue
    }

    break
  }

  return messages
}

// ── OpenAI agent loop ──────────────────────────────────────────────────────────

async function runAgentLoopOpenAI({ sessionId, message, history, systemPrompt, tools, emitEvent, isCancelled, getInterrupt, onCheckpoint }) {
  const { OpenAI } = require('openai')
  const openai      = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  const openaiTools = tools.length ? toOpenAITools(tools) : undefined
  const messages    = toOpenAIMessages(systemPrompt, history || [])
  messages.push({ role: 'user', content: message })
  const startTime = Date.now()

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (isCancelled && isCancelled()) {
      emitEvent('text', { text: '⛔ Task cancelled.' })
      break
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000)
    emitEvent('progress', { turn: turn + 1, maxTurns: MAX_TURNS, elapsed })

    const stream = await openai.chat.completions.create({
      model: 'gpt-4o', max_tokens: 4096,
      messages, tools: openaiTools, stream: true,
    })

    let textSoFar    = ''
    let finishReason = null
    const tcMap      = {}

    // Batch OpenAI text deltas every 60 ms
    let _oaiTimer = null
    const _flushOai = () => {
      if (textSoFar) emitEvent('text', { text: textSoFar })
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
          if (tc.id)                  tcMap[tc.index].id = tc.id
          if (tc.function?.name)      tcMap[tc.index].function.name      += tc.function.name
          if (tc.function?.arguments) tcMap[tc.index].function.arguments += tc.function.arguments
        }
      }
    }

    clearTimeout(_oaiTimer)
    _flushOai()

    const toolCalls = Object.values(tcMap)

    if (!toolCalls.length || finishReason === 'stop') {
      messages.push({ role: 'assistant', content: textSoFar })
      if (onCheckpoint) onCheckpoint(messages)
      break
    }

    messages.push({ role: 'assistant', content: textSoFar || null, tool_calls: toolCalls })

    for (const tc of toolCalls) {
      let input = {}
      try { input = JSON.parse(tc.function.arguments) } catch {}
      emitEvent('tool_call', { toolId: tc.id, toolName: tc.function.name, toolInput: input })
      const result = await registry.execute(tc.function.name, input, { sessionId })
      emitEvent('tool_result', { toolId: tc.id, toolName: tc.function.name, result })
      const content = typeof result === 'string' && result.startsWith('data:image/')
        ? '[screenshot captured]'
        : typeof result === 'string' ? result : JSON.stringify(result)
      messages.push({ role: 'tool', tool_call_id: tc.id, content })
    }

    if (onCheckpoint) onCheckpoint(messages)

    const interrupt = getInterrupt && getInterrupt()
    if (interrupt) {
      emitEvent('interrupt_ack', { text: interrupt })
      messages.push({ role: 'user', content: `[USER CORRECTION — respond to this immediately]: ${interrupt}` })
    }
  }

  // Strip leading system message before storing — Anthropic loop can't use it
  return messages.filter(m => m.role !== 'system')
}

// ── Provider router with auto-fallback ─────────────────────────────────────────

async function runAgentLoop({ sessionId, message, history, systemPrompt, tools, emitEvent, isCancelled, getInterrupt, onCheckpoint }) {
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY
  const hasOpenAI    = !!process.env.OPENAI_API_KEY
  const preferred    = process.env.PREFERRED_PROVIDER || 'anthropic'

  if (!hasAnthropic && !hasOpenAI) {
    throw new Error('Set ANTHROPIC_API_KEY or OPENAI_API_KEY environment variable.')
  }

  const primaryIsAnthropic = hasAnthropic && (preferred !== 'openai')
  const shared = { sessionId, message, history, systemPrompt, tools, emitEvent, isCancelled, getInterrupt, onCheckpoint }

  if (primaryIsAnthropic) {
    try {
      return await runAgentLoopAnthropic(shared)
    } catch (err) {
      const isOverload = err.status === 529 || err.status === 429 ||
        /overload|rate.?limit/i.test(err.message || '')
      if (isOverload && hasOpenAI) {
        emitEvent('text', { text: '⚠️ Claude is busy — retrying with GPT-4o…\n\n' })
        return await runAgentLoopOpenAI(shared)
      }
      throw err
    }
  } else {
    try {
      return await runAgentLoopOpenAI(shared)
    } catch (err) {
      const isOverload = /rate.?limit|overload/i.test(err.message || '')
      if (isOverload && hasAnthropic) {
        emitEvent('text', { text: '⚠️ GPT-4o rate limited — retrying with Claude…\n\n' })
        return await runAgentLoopAnthropic(shared)
      }
      throw err
    }
  }
}

module.exports = { runAgentLoop }
