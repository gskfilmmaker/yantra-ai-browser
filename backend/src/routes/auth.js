'use strict'
const router = require('express').Router()
const bcrypt = require('bcryptjs')
const jwt    = require('jsonwebtoken')

// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { email, password, name } = req.body
    if (!email || !password) return res.status(400).json({ error: 'email and password required' })

    // TODO: check if user exists in DB (PostgreSQL via pg/drizzle)
    const hash = await bcrypt.hash(password, 12)

    // TODO: INSERT INTO users (email, name, password_hash) VALUES (...)
    const userId = `user_${Date.now()}` // placeholder until DB wired up

    const token = jwt.sign({ sub: userId, email }, process.env.JWT_SECRET, { expiresIn: '7d' })
    res.status(201).json({ token, userId })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body
    if (!email || !password) return res.status(400).json({ error: 'email and password required' })

    // TODO: SELECT * FROM users WHERE email = $1
    // const user = await db.getUserByEmail(email)
    // if (!user || !await bcrypt.compare(password, user.password_hash))
    //   return res.status(401).json({ error: 'Invalid credentials' })

    const userId = `user_placeholder`
    const token  = jwt.sign({ sub: userId, email }, process.env.JWT_SECRET, { expiresIn: '7d' })
    res.json({ token, userId })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/auth/refresh
router.post('/refresh', (req, res) => {
  const { token } = req.body
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET, { ignoreExpiration: true })
    if (Date.now() / 1000 - payload.iat > 30 * 86400) return res.status(401).json({ error: 'Token too old' })
    const newToken = jwt.sign({ sub: payload.sub, email: payload.email }, process.env.JWT_SECRET, { expiresIn: '7d' })
    res.json({ token: newToken })
  } catch {
    res.status(401).json({ error: 'Invalid token' })
  }
})

module.exports = router
