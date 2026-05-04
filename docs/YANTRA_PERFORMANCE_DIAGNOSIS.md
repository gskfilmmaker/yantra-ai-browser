# Yantra — Performance Diagnosis Report

## Executive Summary

The app has four concrete performance problems that compound during any agent run.
None requires a framework change. All are fixable in the existing vanilla-JS stack.

---

## 1. IPC Flood: Full Text Snapshot Per Token

**File:** `main/ai/llmClient.js` lines 70–72, 133–136

```js
// Anthropic
stream.on('text', (_, snapshot) => {
  event.sender.send('agent-event', { sessionId, type: 'text', text: snapshot })
})

// OpenAI — same pattern
event.sender.send('agent-event', { sessionId, type: 'text', text: textSoFar })
```

**Problem:** Every single LLM token triggers one IPC message carrying the *entire text
so far* — not a delta. A 600-token response generates ~600 IPC round-trips, the last
one carrying ~600 tokens. Total bytes transmitted ≈ 600 × (avg 300 bytes) = **180 KB
of redundant IPC traffic per response**. Each round-trip also serialises/deserialises
JSON on both sides.

**Renderer side (`src/renderer.js` lines 945–953):** On every `text` event, `patchCard`
calls `el.innerHTML = cardHTML(item)` — a full DOM re-parse and layout for the entire
card. At ~20 tokens/second this is 20 forced layouts per second from a single response.

**Severity:** Critical. Causes jank proportional to response length.

---

## 2. DOM Thrash: Full Card Re-render Per Token

**File:** `src/renderer.js` lines 885–889

```js
function patchCard(itemId) {
  const el = document.getElementById(`card-${itemId}`)
  if (item && el) el.innerHTML = cardHTML(item)   // ← full re-parse every token
}
```

All card content is rebuilt including markdown rendering (`renderMd`) on every token.
The `renderMd` function runs 7 regex chains on the growing text with each event.
This is O(n²) work for an n-token response.

**Severity:** High. Scales quadratically with response length.

---

## 3. Synchronous File I/O on Tool Execution

**Files:** `main/vault/credentialVault.js`, `main/agents/personaEngine.js`,
`main/cognition/learningLayer.js`, `main/autonomy/scheduler.js`,
`main/autonomy/conditionMonitor.js`

All persistence modules use `fs.readFileSync` / `fs.writeFileSync` on the main
process thread. While these are fast for small files (~50 KB), during a multi-tool
agent run they execute synchronously inside the IPC handler thread — stalling all
other IPC responses until the write completes.

**Severity:** Medium. Noticeable during vault-autofill or scheduler-fire events.

---

## 4. BrowserView Bounds Recalculated Too Eagerly

**File:** `src/renderer.js` lines 730–753

`scheduleBoundsUpdate()` is called from: resize events, AI input keystrokes,
drag events (every mousemove), tab switches, find bar open/close, and
overlay show/hide. The debounce is 30 ms. During a drag-resize this fires
every 30 ms repeatedly, each triggering an IPC call to `browser:setBounds`.

**Severity:** Low–Medium. Causes stutter during drag-resize.

---

## 5. No Renderer-Side Event Batching for Autonomy

**File:** `main/autonomy/autonomyEngine.js` + `main/autonomy/conditionMonitor.js`

The condition monitor can poll multiple URLs every 5 minutes and emit IPC
events. When multiple monitors fire close together, IPC events arrive in
bursts with no batching. The renderer has no listener for `autonomy-event`
at all — events are silently dropped.

**Severity:** Low. Becomes high when many monitors are active.

---

## 6. UI Architecture Gaps (UX, not performance)

| Gap | Impact |
|-----|--------|
| Vault, Personas, Automation only accessible via AI chat commands | Non-technical users cannot discover features |
| Sidebar is 52 px icons only — no labels | Poor discoverability |
| No activity feed — agent events invisible unless chat is open | Autonomous tasks invisible |
| No command palette | Power users must type long chat commands |
| No onboarding — cold start with blank browser | Confusing for new users |
| Autonomy events not wired to renderer | Scheduler/monitor output lost |

---

## Fixes Applied

See `docs/YANTRA_PERFORMANCE_FIXES.md` for the implementation.

---

*Report generated: 2026-05-03*
