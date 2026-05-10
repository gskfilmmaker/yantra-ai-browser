'use strict'
const https = require('https')
const http  = require('http')

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

function _req(opts, body) {
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
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Connection timeout')) })
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
    reqRef = _mod.request(reqOpts, (res) => {
      let buf = ''
      res.on('data', (chunk) => {
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
                if (ev.type === 'done') { reqRef.destroy(); resolve(); return }
              } catch { /* malformed JSON — skip */ }
            }
          }
        }
      })
      res.on('end',   resolve)
      res.on('error', () => resolve())
    })
    reqRef.on('error', () => resolve())
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
  // Start session on Railway server
  const { sessionId: remoteId } = await post(baseUrl, '/api/agent/run', { message, history })

  // Indicate remote mode in the UI
  if (!event.sender.isDestroyed()) {
    event.sender.send('agent-event', {
      sessionId,
      type: 'text',
      text: `_Running on remote server (${new URL(baseUrl).hostname})…_\n\n`,
    })
  }

  // Poll for interrupts / cancels every second
  let finished = false
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
}

module.exports = { runRemoteLoop, testConnection }
