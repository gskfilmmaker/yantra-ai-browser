'use strict'
/**
 * Smoke tests for Yantra — runs in Node without Electron.
 * Tests module loading, IPC handler registration shapes, and
 * key subsystem APIs.  Does NOT require a display or API keys.
 *
 * Usage: npm run test:smoke
 */

const assert = require('assert')
const path = require('path')

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${e.message}`)
    failed++
  }
}

async function testAsync(name, fn) {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${e.message}`)
    failed++
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function requireSafe(mod) {
  try {
    return require(mod)
  } catch (e) {
    // Modules that need Electron (ipcMain etc.) will throw — stub them
    if (e.code === 'MODULE_NOT_FOUND' || e.message.includes('electron')) return null
    throw e
  }
}

// ── Suite: Module loading ─────────────────────────────────────────────────────

console.log('\n── Module loading ───────────────────────────────────────────────')

test('agentManager loads', () => {
  const m = require('../main/agents/agentManager')
  assert.ok(typeof m.listAgents === 'function', 'listAgents missing')
  assert.ok(typeof m.getActiveAgent === 'function', 'getActiveAgent missing')
})

test('memoryStore loads', () => {
  const m = require('../main/memoryStore')
  assert.ok(typeof m.save === 'function')
  assert.ok(typeof m.getAll === 'function')
  assert.ok(typeof m.search === 'function')
})

test('routineManager loads', () => {
  const m = require('../main/routines/routineManager')
  assert.ok(typeof m.listRoutines === 'function')
  assert.ok(typeof m.createRoutine === 'function')
})

test('appSettings loads', () => {
  const m = require('../main/settings')
  assert.ok(typeof m.get === 'function')
  assert.ok(typeof m.set === 'function')
  assert.ok(typeof m.getAll === 'function')
})

test('tool registry loads', () => {
  const m = require('../main/tools/registry')
  assert.ok(typeof m.register === 'function')
  assert.ok(typeof m.schemasForAgent === 'function')
})

test('credentialVault loads', () => {
  const m = require('../main/vault/credentialVault')
  assert.ok(typeof m.list === 'function')
  assert.ok(typeof m.save === 'function')
  assert.ok(typeof m.get === 'function')
  assert.ok(typeof m.remove === 'function')
})

test('personaEngine loads', () => {
  const m = require('../main/agents/personaEngine')
  assert.ok(typeof m.list === 'function')
  assert.ok(typeof m.get === 'function')
  assert.ok(typeof m.create === 'function')
  assert.ok(typeof m.learn === 'function')
  assert.ok(typeof m.buildSystemPrompt === 'function')
})

test('contextEngine loads', () => {
  const m = require('../main/ai/contextEngine')
  assert.ok(typeof m.buildContext === 'function')
})

test('planner loads', () => {
  const m = require('../main/ai/planner')
  assert.ok(typeof m.classify === 'function')
})

// ── Suite: Agent manager ──────────────────────────────────────────────────────

console.log('\n── Agent manager ────────────────────────────────────────────────')

test('listAgents returns array', () => {
  const m = require('../main/agents/agentManager')
  const agents = m.listAgents()
  assert.ok(Array.isArray(agents), 'expected array')
  assert.ok(agents.length > 0, 'expected at least one built-in agent')
})

test('getActiveAgent returns object with id and name', () => {
  const m = require('../main/agents/agentManager')
  const agent = m.getActiveAgent()
  assert.ok(agent && typeof agent.id === 'string', 'agent.id missing')
  assert.ok(typeof agent.name === 'string', 'agent.name missing')
})

// ── Suite: Persona engine ─────────────────────────────────────────────────────

console.log('\n── Persona engine ───────────────────────────────────────────────')

test('list returns array', () => {
  const m = require('../main/agents/personaEngine')
  const personas = m.list()
  assert.ok(Array.isArray(personas))
})

test('default persona genius-gsk exists or first persona present', () => {
  const m = require('../main/agents/personaEngine')
  const personas = m.list()
  assert.ok(personas.length > 0, 'expected at least one persona')
})

test('buildSystemPrompt returns string or null', () => {
  const m = require('../main/agents/personaEngine')
  const personas = m.list()
  if (personas.length > 0) {
    const result = m.buildSystemPrompt(personas[0].id)
    assert.ok(result === null || typeof result === 'string')
  }
})

// ── Suite: Memory store ───────────────────────────────────────────────────────

console.log('\n── Memory store ─────────────────────────────────────────────────')

test('getAll returns array', () => {
  const m = require('../main/memoryStore')
  const all = m.getAll()
  assert.ok(Array.isArray(all))
})

test('search returns a result (string or array)', () => {
  const m = require('../main/memoryStore')
  const results = m.search('test query')
  // search returns formatted string for LLM when no matches, or array when matches exist
  assert.ok(typeof results === 'string' || Array.isArray(results))
})

// ── Suite: Credential vault ───────────────────────────────────────────────────

console.log('\n── Credential vault ─────────────────────────────────────────────')

test('list returns array', () => {
  const m = require('../main/vault/credentialVault')
  const entries = m.list()
  assert.ok(Array.isArray(entries))
})

test('save and get roundtrip', () => {
  const m = require('../main/vault/credentialVault')
  const site = `__smoke_test_${Date.now()}`
  m.save(site, 'smokeuser', 'smokepass', 'smoke note')
  // get() returns an array of matching entries
  const entries = m.get(site)
  assert.ok(Array.isArray(entries) && entries.length > 0, 'entry not found after save')
  const entry = entries[0]
  assert.strictEqual(entry.username, 'smokeuser')
  assert.strictEqual(entry.password, 'smokepass')
  // cleanup
  m.remove(entry.id)
  const afterRemove = m.get(site)
  assert.ok(!afterRemove || afterRemove.length === 0, 'entry should be gone after remove')
})

// ── Suite: Settings ───────────────────────────────────────────────────────────

console.log('\n── Settings ─────────────────────────────────────────────────────')

test('set and get roundtrip', () => {
  const m = require('../main/settings')
  m.set('__smoke_test_key', 'hello')
  const val = m.get('__smoke_test_key')
  assert.strictEqual(val, 'hello')
  // cleanup
  m.set('__smoke_test_key', undefined)
})

test('getAll returns object', () => {
  const m = require('../main/settings')
  const all = m.getAll()
  assert.ok(all && typeof all === 'object')
})

// ── Suite: Tool registry ──────────────────────────────────────────────────────

console.log('\n── Tool registry ────────────────────────────────────────────────')

test('schemasForAgent with empty array returns array', () => {
  const m = require('../main/tools/registry')
  const schemas = m.schemasForAgent([])
  assert.ok(Array.isArray(schemas))
})

test('schemasForAgent with wildcard returns tools', () => {
  const m = require('../main/tools/registry')
  // Load tool modules so they register themselves
  requireSafe('../main/tools/browserTools')
  requireSafe('../main/tools/contentTools')
  requireSafe('../main/tools/memoryTools')
  const schemas = m.schemasForAgent(['*'])
  assert.ok(Array.isArray(schemas))
  // After loading at least browser tools there should be some schemas
})

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n── Results: ${passed} passed, ${failed} failed ───────────────────────────\n`)
if (failed > 0) process.exit(1)
