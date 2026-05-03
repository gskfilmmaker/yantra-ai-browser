# Yantra Cloud Architecture

## Overview

Yantra is a **hybrid local + cloud** AI browser. The local Electron app owns the
browser surface, credentials, and real-time agent execution. The cloud layer
provides sync, sharing, remote agent runs, and a web UI for non-desktop users.

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                       USER DEVICE                               │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                  Electron App (local)                    │   │
│  │                                                         │   │
│  │  ┌──────────────┐   ┌──────────────┐  ┌─────────────┐  │   │
│  │  │  BrowserView │   │  AI Overlay  │  │  Sidebar    │  │   │
│  │  │  (Chromium)  │   │  (chat/plan) │  │  (panels)   │  │   │
│  │  └──────────────┘   └──────────────┘  └─────────────┘  │   │
│  │                                                         │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────┐  │   │
│  │  │  Agents  │  │ Routines │  │ Personas │  │  Vault │  │   │
│  │  └──────────┘  └──────────┘  └──────────┘  └────────┘  │   │
│  │                                                         │   │
│  │  ┌────────────────────────────────────────────────────┐ │   │
│  │  │              local file store (~/.yantra)           │ │   │
│  │  │  memory.json  sessions.json  vault.enc  agents.json │ │   │
│  │  └────────────────────────────────────────────────────┘ │   │
│  └──────────────────────────────────┬──────────────────────┘   │
│                                     │ HTTPS / WebSocket         │
└─────────────────────────────────────┼───────────────────────────┘
                                      │
┌─────────────────────────────────────▼───────────────────────────┐
│                      VERCEL CLOUD (Edge + Serverless)            │
│                                                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  Next.js App  (apps/web)                                  │  │
│  │  • /dashboard  — memory browser, routine editor           │  │
│  │  • /share/:id  — shareable agent run transcript           │  │
│  │  • /api/sync   — memory + agent state delta sync          │  │
│  │  • /api/run    — headless remote agent execution          │  │
│  │  • /api/auth   — Clerk/NextAuth session management        │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌──────────────────┐  ┌──────────────────┐                     │
│  │  Vercel KV       │  │  Vercel Blob      │                     │
│  │  (session cache, │  │  (transcripts,    │                     │
│  │   rate limits)   │  │   screenshots)    │                     │
│  └──────────────────┘  └──────────────────┘                     │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Background Workers  (Vercel Cron / Queue)               │   │
│  │  • Scheduled routine execution (when desktop is offline) │   │
│  │  • Memory embedding + vector index                       │   │
│  │  • Nightly digest email                                  │   │
│  └──────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

---

## What Runs Where

| Concern | Local (Electron) | Cloud (Vercel) |
|---|---|---|
| Browser automation | ✅ Full control | — |
| Credential vault | ✅ Encrypted on disk | — (never leaves device) |
| AI agent execution (interactive) | ✅ Streaming to UI | — |
| AI agent execution (scheduled / headless) | ✅ (autonomyEngine) | ✅ fallback when offline |
| Memory store | ✅ Primary (memory.json) | ✅ Sync replica |
| Persona definitions | ✅ Local | ✅ Sync replica |
| Routine definitions | ✅ Local | ✅ Sync replica |
| Session history | ✅ Local (sessions.json) | ✅ Sync replica (encrypted) |
| Dashboard / web UI | — | ✅ |
| Share links | — | ✅ |
| LLM API calls | ✅ Direct to Anthropic/OpenAI | ✅ proxied (no key exposure) |

---

## Sync Protocol

1. **On agent-run complete:** local app POSTs a delta (`POST /api/sync/memory`)
   with the new memory entry and a device ID + HMAC signature.
2. **On app launch:** local app GETs `/api/sync/state?since=<last_sync_ts>` and
   merges remote changes (last-write-wins per entry, using `updatedAt` timestamp).
3. **Conflict resolution:** local always wins for vault entries. Cloud wins for
   entries created on another device.

---

## Security Boundaries

- **Vault data never leaves the local device.** The sync API explicitly
  excludes vault entries from all payloads.
- **LLM API keys** are stored in the local OS keychain (future) or
  `~/.yantra/settings.json` (current). They are never sent to Vercel.
- **Cloud-proxied LLM calls** use a server-side key stored in Vercel
  environment variables; the desktop app can opt in to use the proxy to
  avoid exposing its own key.
- **Share links** contain only the transcript text; no credentials, no
  memory context, no persona instructions.

---

## Local-First Guarantee

The app is **fully functional with no internet connection.** Cloud sync is
opportunistic. If the sync endpoint is unreachable, the app queues deltas
locally and retries with exponential backoff when connectivity returns.
