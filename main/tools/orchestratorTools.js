'use strict'
const registry = require('./registry')
const { executeIntelligent } = require('../automation/intelligence/intelligenceLayer')

// ── executeTask ───────────────────────────────────────────────────────────────
// Execution Intelligence v3 — routes through the intelligence layer which adds:
//   • task memory (known selectors from prior runs on same domain)
//   • semantic element resolution (text / aria-label / role matching)
//   • vision + DOM fusion fallback when CSS selectors fail
//   • adaptive replanning: modifies selectors, inserts steps, up to 3 replan rounds
//   • structured reasoning output embedded in every response

registry.register({
  name: 'executeTask',
  description: `Execute a reliable multi-step browser automation task using the OAVR engine with Execution Intelligence v3.

Intelligence features (automatic, no configuration needed):
 • Semantic element matching — finds elements by visible text, aria-label, role (not just CSS selectors)
 • Task memory — reuses selector patterns learned from prior runs on the same site
 • Adaptive replanning — when a step fails, generates a new plan (new selector, insert scroll/wait, etc.)
 • Vision + DOM fusion fallback — captures visual context when DOM matching is exhausted
 • Up to 3 replan rounds before marking a task failed

Each step is typed (navigate, click, type, etc.) and has optional verification rules. The engine:
 1. Snapshots the DOM before each step
 2. Executes the step via the matching tool
 3. Waits intelligently (navigation, DOM settle, etc.)
 4. Snapshots the DOM after
 5. Verifies success against explicit rules or smart heuristics
 6. Retries with escalating strategies if verification fails
 7. Halts automatically if a CAPTCHA is detected

Returns a structured Markdown report with per-step results, retry counts, durations, and a JSON summary.

Use this instead of chaining individual tools when you need reliable multi-step automation.`,

  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Human-readable task name for the report (e.g. "Fill contact form")',
      },
      steps: {
        type: 'array',
        description: 'Ordered list of automation steps',
        items: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'Step identifier used in the report (e.g. "open_page", "click_submit")',
            },
            type: {
              type: 'string',
              enum: Object.keys({
                navigate: 1, click: 1, type: 1, press_key: 1, scroll: 1,
                wait: 1, screenshot: 1, get_structure: 1,
                extract_table: 1, extract_entities: 1, extract_text: 1,
                fetch: 1, detect_captcha: 1, confirm: 1,
              }),
              description: `Step type mapping to underlying tool:
  navigate → open_url  |  click → clickElement  |  type → typeInField
  press_key → pressKey  |  scroll → scrollPage  |  wait → waitForElement
  screenshot → captureScreenshot  |  get_structure → getPageStructure
  extract_table → extractTable  |  extract_entities → extractEntities
  extract_text → getSelectedText  |  fetch → fetch_webpage
  detect_captcha → detectCaptcha  |  confirm → confirmAction`,
            },
            params: {
              type: 'object',
              description: 'Parameters forwarded to the underlying tool. Use same params as the direct tool call.',
            },
            verify: {
              type: 'object',
              description: `Optional verification rules (all keys optional, checked with AND logic):
  urlChanged: true          — URL must differ from before
  urlContains: "checkout"   — URL must include this substring
  urlMatches: "order/\\d+"  — URL must match this regex
  elementPresent: "#success"— CSS selector must exist after action
  elementAbsent: ".spinner" — CSS selector must be gone
  textPresent: "Thank you"  — text must appear in page body
  textAbsent: "Error"       — text must not appear
  pageChanged: true         — DOM must change significantly
  noError: true             — no error signals on page
  resultContains: "Saved"   — tool result string must include this
  inputValue: {"email": "x@y.com"} — input fields must have these values`,
            },
            required: {
              type: 'boolean',
              description: 'If true (default), task stops when this step fails. Set false for optional steps.',
            },
            maxRetries: {
              type: 'number',
              description: 'Max retry attempts on failure (default: 2)',
            },
            retryStrategy: {
              type: 'string',
              enum: ['immediate', 'wait', 'wait_long', 'exponential', 'scroll_and_retry', 'refetch_structure'],
              description: 'Retry strategy (default: wait). refetch_structure re-runs getPageStructure to recover selectors.',
            },
          },
          required: ['type'],
        },
      },
    },
    required: ['steps'],
  },

  async execute({ name, steps } = {}) {
    if (!Array.isArray(steps) || steps.length === 0) {
      return 'Error: steps must be a non-empty array.'
    }
    const taskId = `task_${Date.now()}`
    try {
      return await executeIntelligent({ id: taskId, name: name || taskId, steps })
    } catch (e) {
      return `Task execution error: ${e.message}`
    }
  },
})
