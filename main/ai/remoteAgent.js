'use strict'
const https = require('https')
const http  = require('http')

// How long to wait for Railway to accept the initial POST (handles cold starts)
const CONNECT_TIMEOUT_MS = 45_000

// How long the SSE stream can be silent before we treat it as dead
const SSE_IDLE_TIMEOUT_MS = 90_000

// Overall hard cap on a single remote agent run
const RUN_TIMEOUT_MS = 30 * 60_000

function _opts(baseUrl, path, method = 'GET', bodyLen = 0) {
  const u = new URL(path, baseUrl.replace(/\/$/, '') + '/')
  const secure = u.protocol === 'https:'
  return {
    _mod:     secure ? https : http,
    hostname: u.hostname,
    port:     parseInt(u.port) || (secure ? 443 : 80),
    path:     u.pathname + u.search,
    method,
    headers:  bodyLen > 0
      ? { 'Content-Type': 'application/json', 'Content-Length': bodyLen }
      : {},
  }
}

function _req(opts, body, timeoutMs = CONNECT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const { _mod, ...reqOpts } = opts
    const req = _mod.request(reqOpts, (res) => {
      let raw = ''
      res.on('data', c => { raw += c })
      res.on('end',  () => {
        try   { resolve(JSON.parse(raw)) }
        catch { reject(new Error(`Server returned: ${raw.slice(0, 200)}`)) }
      })
    })
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Connection timeout — Railway may be cold-starting, try again in 30s')) })
    if (body) req.write(body)
    req.end()
  })
}

function get(baseUrl, path) {
  return _req(_opts(baseUrl, path, 'GET'))
}

function post(baseUrl, path, body) {
  const data = JSON.stringify(body)
  return _req({ ..._opts(baseUrl, path, 'POST', Buffer.byteLength(data)) }, data)
}

function streamSSE(baseUrl, path, onEvent) {
  return new Promise((resolve) => {
    const { _mod, ...reqOpts } = _opts(baseUrl, path, 'GET')
    reqOpts.headers = { Accept: 'text/event-stream', 'Cache-Control': 'no-cache' }

    let reqRef
    let idleTimer

    function resetIdleTimer() {
      clearTimeout(idleTimer)
      // If the stream goes completely silent (no data, not even heartbeats) for
      // SSE_IDLE_TIMEOUT_MS, treat the connection as dead and unblock.
      idleTimer = setTimeout(() => {
        try { reqRef && reqRef.destroy() } catch {}
        resolve()
      }, SSE_IDLE_TIMEOUT_MS)
    }

    reqRef = _mod.request(reqOpts, (res) => {
      resetIdleTimer()
      let buf = ''
      res.on('data', (chunk) => {
        resetIdleTimer()
        buf += chunk.toString()
        let idx
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          for (const line of block.split('\n')) {
            if (line.startsWith('data: ')) {
              try {
                const ev = JSON.parse(line.slice(6))
                onEvent(ev)
                if (ev.type === 'done') {
                  clearTimeout(idleTimer)
                  reqRef.destroy()
                  resolve()
                  return
                }
              } catch { /* malformed JSON — skip */ }
            }
          }
        }
      })
      res.on('end',   () => { clearTimeout(idleTimer); resolve() })
      res.on('error', () => { clearTimeout(idleTimer); resolve() })
    })
    reqRef.on('error', () => { clearTimeout(idleTimer); resolve() })
    reqRef.end()
  })
}

async function testConnection(baseUrl) {
  return get(baseUrl, '/api/health')
}

async function runRemoteLoop({
  event,
  sessionId,
  message,
  history,
  isCancelled,
  getInterrupt,
  baseUrl,
}) {
  // Show a thinking card immediately so the UI isn't silent during cold start
  if (!event.sender.isDestroyed()) {
    event.sender.send('agent-event', {
      sessionId,
      type: 'tool_call',
      toolId: 'remote-connect',
      toolName: '_connecting',
      toolInput: { host: new URL(baseUrl).hostname },
    })
  }

  // Start session on Railway server (longer timeout to survive cold starts)
  const { sessionId: remoteId } = await post(baseUrl, '/api/agent/run', { message, history })

  // Confirm connected and hand off to remote
  if (!event.sender.isDestroyed()) {
    event.sender.send('agent-event', {
      sessionId,
      type: 'text',
      text: `_Connected to remote server (${new URL(baseUrl).hostname}) — running agent…_\n\n`,
    })
  }

  // Hard cap on total run time — matches local mode's 30-minute guard
  let finished = false
  const hardTimeout = setTimeout(() => {
    if (!finished) {
      finished = true
      if (!event.sender.isDestroyed()) {
        event.sender.send('agent-event', {
          sessionId,
          type: 'error',
          text: 'Remote agent run timed out after 30 minutes.',
        })
      }
      try { post(baseUrl, `/api/agent/cancel/${remoteId}`, {}).catch(() => {}) } catch {}
    }
  }, RUN_TIMEOUT_MS)

  // Poll for interrupts / cancels every second
  const pollHandle = setInterval(async () => {
    if (finished) { clearInterval(pollHandle); return }

    if (isCancelled()) {
      finished = true
      clearInterval(pollHandle)
      try { await post(baseUrl, `/api/agent/cancel/${remoteId}`, {}) } catch {}
      return
    }

    const interrupt = getInterrupt()
    if (interrupt) {
      try { await post(baseUrl, `/api/agent/interrupt/${remoteId}`, { message: interrupt }) } catch {}
    }
  }, 1000)

  // Stream SSE events → renderer
  await streamSSE(baseUrl, `/api/agent/stream/${remoteId}`, (payload) => {
    const { type, ...rest } = payload
    if (type === 'done') { finished = true; return }
    if (!event.sender.isDestroyed()) {
      event.sender.send('agent-event', { sessionId, type, ...rest })
    }
  })

  finished = true
  clearInterval(pollHandle)
  clearTimeout(hardTimeout)
}

module.exports = { runRemoteLoop, testConnection }
