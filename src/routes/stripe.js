const express = require('express');
const { stripeRateLimiter } = require('../middleware/auth');
const logger = require('../services/logger');
const router = express.Router();

let stripe;
try {
  stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
} catch { logger.warn('Stripe non initialisé'); }

const getPriceId = (plan, period) => process.env[`STRIPE_PRICE_${plan.toUpperCase()}_${period.toUpperCase()}`];

router.post('/create-checkout', stripeRateLimiter, async (req, res) => {
  const { plan, period, email, cabinetName } = req.body;
  if (!plan || !period || !email) return res.status(400).json({ error: 'plan, period et email requis.' });
  if (!stripe) return res.status(503).json({ error: 'Paiement non disponible.' });
  const priceId = getPriceId(plan, period);
  if (!priceId) return res.status(500).json({ error: 'Configuration tarifaire manquante.' });
  try {
    const existing = await stripe.customers.list({ email, limit: 1 });
    const customer = existing.data.length > 0 ? existing.data[0] : await stripe.customers.create({ email, name: cabinetName || email });
    const session = await stripe.checkout.sessions.create({
      customer: customer.id,
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: { trial_period_days: 14 },
      success_url: `${process.env.STRIPE_SUCCESS_URL}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: process.env.STRIPE_CANCEL_URL,
      locale: 'fr',
      allow_promotion_codes: true,
    });
    res.json({ sessionId: session.id, url: session.url });
  } catch (err) {
    logger.error(`Stripe error: ${err.message}`);
    res.status(500).json({ error: 'Erreur paiement.' });
  }
});

router.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  if (!stripe) return res.sendStatus(200);
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) { return res.status(400).json({ error: err.message }); }
  logger.info(`Webhook: ${event.type}`);
  res.json({ received: true });
});

router.get('/subscription', async (req, res) => {
  const { customerId } = req.query;
  if (!customerId || !stripe) return res.json({ active: false });
  try {
    const subs = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 1 });
    if (!subs.data.length) return res.json({ active: false });
    const sub = subs.data[0];
    res.json({ active: ['active', 'trialing'].includes(sub.status), status: sub.status });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
