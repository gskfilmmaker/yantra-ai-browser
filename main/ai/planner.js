'use strict'

const SYSTEM = `You are an intent classifier for a browser AI assistant.
Given a user request, decide: simple (one agent handles it) or multi_step (needs sequential planning).

Respond ONLY with valid JSON — no markdown fences, no explanation.

Simple: {"type":"simple"}

Multi-step:
{
  "type":"multi_step",
  "title":"Short plan title",
  "steps":["Step 1: …","Step 2: …","Step 3: …"],
  "suggestedTools":["web_search","extractTable","generateReport"]
}

Use multi_step when the task has 3+ distinct phases, requires research + data extraction + output, or needs coordination across multiple pages.
Use simple for: quick questions, single-page summaries, direct lookups, short chat.`

async function classify(userPrompt) {
  let Anthropic
  try { Anthropic = require('@anthropic-ai/sdk') }
  catch { return { type: 'simple' } }

  if (!process.env.ANTHROPIC_API_KEY) return { type: 'simple' }

  try {
    const client = new Anthropic()
    const resp = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 512,
      system:     SYSTEM,
      messages:   [{ role: 'user', content: `User request: "${userPrompt.slice(0, 500)}"` }],
    })
    const text = (resp.content[0]?.text || '').trim()
    return JSON.parse(text)
  } catch {
    return { type: 'simple' }
  }
}

module.exports = { classify }
