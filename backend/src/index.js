'use strict'
const express    = require('express')
const cors       = require('cors')
const helmet     = require('helmet')
const morgan     = require('morgan')
const rateLimit  = require('express-rate-limit')

const authRoutes    = require('./routes/auth')
const agentRoutes   = require('./routes/agents')
const sessionRoutes = require('./routes/sessions')
const billingRoutes = require('./routes/billing')
const usageRoutes   = require('./routes/usage')
const { authMiddleware } = require('./middleware/auth')

const app  = express()
const PORT = process.env.PORT || 3001

// ── Security & logging ────────────────────────────────────────────────────────
app.use(helmet())
app.use(cors({ origin: process.env.ALLOWED_ORIGINS?.split(',') || '*' }))
app.use(morgan('combined'))
app.use(express.json({ limit: '2mb' }))

// ── Rate limiting ─────────────────────────────────────────────────────────────
const limiter = rateLimit({ windowMs: 60_000, max: 120 })
app.use('/api/', limiter)

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', ts: new Date().toISOString() }))

// ── Public routes ─────────────────────────────────────────────────────────────
app.use('/api/auth',    authRoutes)

// ── Protected routes ──────────────────────────────────────────────────────────
app.use('/api/agents',   authMiddleware, agentRoutes)
app.use('/api/sessions', authMiddleware, sessionRoutes)
app.use('/api/billing',  authMiddleware, billingRoutes)
app.use('/api/usage',    authMiddleware, usageRoutes)

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error(err)
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' })
})

app.listen(PORT, () => console.log(`Yantra API listening on :${PORT}`))
module.exports = app
