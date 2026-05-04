# Yantra Security Model

## Threat Model

Yantra is a local-first AI browser. The primary attack surfaces are:

1. **Malicious web pages** trying to exfiltrate credentials or hijack the agent
2. **Compromised LLM responses** (prompt injection) directing the agent to leak data
3. **Insecure credential storage** exposing vault contents
4. **Network interception** of LLM API calls or sync traffic

---

## Credential Vault

### Storage

- Credentials are stored in `~/.yantra/vault.json`.
- Passwords are encrypted with AES-256-GCM before writing to disk.
- The encryption key is derived from a device-unique secret (MAC address +
  machine UUID) using PBKDF2 (100,000 iterations, SHA-256).
- The derived key is held in memory only; it is never written to disk.

### Access Control

- Vault data is only accessible to the main Electron process via IPC.
- The renderer (BrowserView, web content) cannot call vault IPC channels
  directly — all vault operations go through the preload bridge and require
  an explicit user action.
- Vault data is **never included** in cloud sync payloads.

---

## Prompt Injection Defenses

### Agent Tool Guardrails

- The registry grants each agent only the tools listed in its `tools` array.
  A compromised page cannot make the agent call `vault:get` unless
  `vaultTools` is in the active agent's tool list.
- Tool schemas are validated before execution; unexpected parameter shapes
  are rejected.

### Context Separation

- Web page content injected into the LLM context is clearly bracketed:
  `[WEB PAGE CONTENT START] ... [WEB PAGE CONTENT END]`
- The system prompt explicitly instructs the model to ignore instructions
  embedded in web page content.

### User Confirmation for High-Risk Actions

- Tools that fill forms (`browser_fill`), click buttons (`browser_click`),
  or execute JavaScript (`browser_execute_script`) should be gated behind
  user confirmation in the UI (planned — not yet enforced at the tool level).

---

## IPC Security

- All IPC channels are registered with `ipcMain.handle` (not `ipcMain.on`)
  to ensure structured, promise-based responses.
- The preload script uses `contextBridge.exposeInMainWorld` — the renderer
  cannot access Node.js or Electron APIs directly.
- `nodeIntegration` is disabled and `contextIsolation` is enabled in all
  BrowserView / BrowserWindow configurations.

---

## API Key Storage

- API keys entered in Settings are saved to `~/.yantra/settings.json`
  (plain text, chmod 600).
- **Future:** migrate to OS keychain (Keytar / macOS Keychain) so keys are
  never on disk in plaintext.
- API keys are **never sent to the Vercel cloud layer** — LLM calls from the
  desktop go directly to Anthropic/OpenAI endpoints.

---

## Network Security

### LLM API Calls

- All requests to `api.anthropic.com` and `api.openai.com` use HTTPS with
  certificate pinning delegated to the OS TLS stack.
- No plaintext HTTP is used.

### Cloud Sync

- Delta payloads are signed with HMAC-SHA256 using `SYNC_HMAC_SECRET`.
- The Vercel sync endpoint verifies the signature before processing any payload.
- All sync traffic uses HTTPS.

---

## BrowserView Isolation

- Each tab runs in its own `BrowserView` with a dedicated web contents process.
- `webSecurity` is enabled; cross-origin requests from page content are
  subject to normal same-origin policy.
- The renderer process cannot read BrowserView page content directly — it
  must request it via `browser:getContent` IPC, which runs in the main
  process.

---

## Known Limitations / Planned Improvements

| Limitation | Planned Fix |
|---|---|
| API keys stored in plaintext settings.json | OS keychain integration |
| No user confirmation before high-risk tool actions | Confirmation dialog in UI |
| Vault key derived from hardware IDs (not user passphrase) | Optional passphrase unlock |
| No audit log of agent tool executions | Append-only tool-use log |
| Cloud sync auth uses shared HMAC secret | Per-device asymmetric key pair |
