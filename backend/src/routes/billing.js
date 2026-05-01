'use strict'
const router = require('express').Router()
// const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY)

const PLANS = {
  free:  { name: 'Free',       price: 0,    monthlyTokens: 100_000,  agents: 3 },
  pro:   { name: 'Pro',        price: 2900, monthlyTokens: 2_000_000, agents: 20 },
  team:  { name: 'Team',       price: 9900, monthlyTokens: 10_000_000, agents: 100 },
}

// GET /api/billing/plans
router.get('/plans', (_req, res) => res.json({ plans: PLANS }))

// GET /api/billing/subscription
router.get('/subscription', (req, res) => {
  // TODO: SELECT * FROM subscriptions WHERE user_id = $1
  res.json({ plan: 'free', status: 'active', userId: req.user.sub })
})

// POST /api/billing/checkout — create Stripe checkout session
router.post('/checkout', async (req, res) => {
  const { plan } = req.body
  if (!PLANS[plan]) return res.status(400).json({ error: 'Invalid plan' })
  // TODO: const session = await stripe.checkout.sessions.create({ ... })
  // res.json({ url: session.url })
  res.json({ message: 'Stripe not yet wired — set STRIPE_SECRET_KEY and STRIPE_PRICE_IDs in .env' })
})

// POST /api/billing/webhook — Stripe webhook handler
router.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  // TODO: const event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET)
  res.json({ received: true })
})

module.exports = router
