const express = require('express');
const { stripeRateLimiter } = require('../middleware/auth');
const logger = require('../services/logger');
const { Resend } = require('resend');
const router = express.Router();

let stripe;
try {
  stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
} catch { logger.warn('Stripe non initialisé'); }

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

const getPriceId = (plan, period) => process.env[`STRIPE_PRICE_${plan.toUpperCase()}_${period.toUpperCase()}`];

// Portail client Stripe (gestion/résiliation self-service par le client)
const PORTAL_URL = 'https://billing.stripe.com/p/login/cNi28q6STf8D4k56H263K00';

// Nettoie le libellé brut Stripe ("1 × Losaro Starter (à €49.00/month)") → "Losaro Starter"
const cleanPlanLabel = (desc) => (desc || '')
  .replace(/^\d+\s*[x×]\s*/i, '')
  .replace(/\s*\(.*\)\s*$/, '')
  .trim() || 'votre abonnement';

// ── Email helpers ──
async function sendPaymentConfirmationEmail(email, nom, plan, amount) {
  if (!resend) { logger.debug(`[EMAIL PAIEMENT SIMULÉ] → ${email}`); return; }
  try {
    await resend.emails.send({
      from: 'Losaro <contact@losaro.fr>',
      to: email,
      subject: 'Votre paiement Losaro a bien été reçu',
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:2rem;color:#1a1a17">
          <strong style="font-size:1.3rem;letter-spacing:-0.03em">Losaro</strong>
          <h1 style="font-size:1.3rem;font-weight:700;margin:1.5rem 0 0.5rem">Paiement confirmé</h1>
          <p style="color:#666;margin-bottom:1.5rem">Merci ${nom || ''}, votre abonnement est actif.</p>
          <div style="background:#f8f7f4;border-radius:12px;padding:1.5rem;margin-bottom:1.5rem">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
              <tr>
                <td style="color:#666;padding-bottom:0.5rem">Plan</td>
                <td style="text-align:right;font-weight:700;padding-bottom:0.5rem">${plan}</td>
              </tr>
              <tr>
                <td style="color:#666;padding-bottom:0.5rem">Montant</td>
                <td style="text-align:right;font-weight:700;padding-bottom:0.5rem">${amount}€ HT/mois</td>
              </tr>
              <tr>
                <td style="color:#666">Statut</td>
                <td style="text-align:right;font-weight:700;color:#22c55e">Actif</td>
              </tr>
            </table>
          </div>
          <a href="https://losaro.fr" style="display:inline-block;background:#0f0f0d;color:white;text-decoration:none;padding:0.85rem 2rem;border-radius:8px;font-weight:600;font-size:0.9rem;margin-bottom:2rem">
            Accéder à mon tableau de bord →
          </a>
          <hr style="border:none;border-top:1px solid #e8e6dd;margin:1.5rem 0">
          <p style="font-size:0.75rem;color:#aaa"><a href="${PORTAL_URL}" style="color:#aaa">Gérer mon abonnement</a> · © 2026 Losaro · contact@losaro.fr</p>
        </div>
      `
    });
    logger.info(`Email paiement confirmé → ${email}`);
  } catch (err) { logger.error(`Email paiement error: ${err.message}`); }
}

async function sendTrialStartedEmail(email, nom, trialEndDate) {
  if (!resend) { logger.debug(`[EMAIL ESSAI SIMULÉ] → ${email}`); return; }
  try {
    await resend.emails.send({
      from: 'Losaro <contact@losaro.fr>',
      to: email,
      subject: 'Bienvenue chez Losaro — votre essai gratuit a démarré',
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:2rem;color:#1a1a17">
          <strong style="font-size:1.3rem;letter-spacing:-0.03em">Losaro</strong>
          <h1 style="font-size:1.3rem;font-weight:700;margin:1.5rem 0 0.5rem">Votre essai gratuit a démarré</h1>
          <p style="color:#666;margin-bottom:1.5rem">Bienvenue ${nom || ''}, vous avez accès à toutes les fonctionnalités de Losaro pendant 30 jours.</p>
          <div style="background:#f8f7f4;border-radius:12px;padding:1.5rem;margin-bottom:1.5rem">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
              <tr>
                <td style="color:#666;padding-bottom:0.5rem">Essai gratuit</td>
                <td style="text-align:right;font-weight:700;padding-bottom:0.5rem">30 jours</td>
              </tr>
              <tr>
                <td style="color:#666">Premier prélèvement</td>
                <td style="text-align:right;font-weight:700">${trialEndDate}</td>
              </tr>
            </table>
          </div>
          <p style="color:#666;margin-bottom:1.5rem">Aucun prélèvement ne sera effectué avant cette date, et c'est sans engagement : vous pouvez <a href="${PORTAL_URL}" style="color:#1a1a17">gérer ou résilier votre abonnement</a> en ligne à tout moment.</p>
          <a href="https://losaro.fr" style="display:inline-block;background:#0f0f0d;color:white;text-decoration:none;padding:0.85rem 2rem;border-radius:8px;font-weight:600;font-size:0.9rem;margin-bottom:2rem">
            Accéder à mon tableau de bord →
          </a>
          <hr style="border:none;border-top:1px solid #e8e6dd;margin:1.5rem 0">
          <p style="font-size:0.75rem;color:#aaa"><a href="${PORTAL_URL}" style="color:#aaa">Gérer mon abonnement</a> · © 2026 Losaro · contact@losaro.fr</p>
        </div>
      `
    });
    logger.info(`Email essai démarré → ${email}`);
  } catch (err) { logger.error(`Email essai error: ${err.message}`); }
}

async function sendCancellationEmail(email, nom, endDate) {
  if (!resend) { logger.debug(`[EMAIL ANNULATION SIMULÉ] → ${email}`); return; }
  try {
    await resend.emails.send({
      from: 'Losaro <contact@losaro.fr>',
      to: email,
      subject: 'Votre abonnement Losaro a été annulé',
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:2rem;color:#1a1a17">
          <strong style="font-size:1.3rem;letter-spacing:-0.03em">Losaro</strong>
          <h1 style="font-size:1.3rem;font-weight:700;margin:1.5rem 0 0.5rem">Abonnement annulé</h1>
          <p style="color:#666;margin-bottom:1.5rem">Bonjour ${nom || ''},</p>
          <p>Votre abonnement Losaro a été annulé. Vous conservez l'accès à la plateforme jusqu'au <strong>${endDate}</strong>.</p>
          <p style="margin-top:1rem">Vous pouvez vous réabonner à tout moment depuis votre tableau de bord.</p>
          <a href="https://losaro.fr" style="display:inline-block;background:#0f0f0d;color:white;text-decoration:none;padding:0.85rem 2rem;border-radius:8px;font-weight:600;font-size:0.9rem;margin:1.5rem 0">
            Me réabonner →
          </a>
          <hr style="border:none;border-top:1px solid #e8e6dd;margin:1.5rem 0">
          <p style="font-size:0.75rem;color:#aaa"><a href="${PORTAL_URL}" style="color:#aaa">Gérer mon abonnement</a> · © 2026 Losaro · contact@losaro.fr</p>
        </div>
      `
    });
    logger.info(`Email annulation → ${email}`);
  } catch (err) { logger.error(`Email annulation error: ${err.message}`); }
}

async function sendPaymentFailedEmail(email, nom) {
  if (!resend) { logger.debug(`[EMAIL ÉCHEC PAIEMENT SIMULÉ] → ${email}`); return; }
  try {
    await resend.emails.send({
      from: 'Losaro <contact@losaro.fr>',
      to: email,
      subject: 'Échec du paiement — action requise',
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:2rem;color:#1a1a17">
          <strong style="font-size:1.3rem;letter-spacing:-0.03em">Losaro</strong>
          <h1 style="font-size:1.3rem;font-weight:700;margin:1.5rem 0 0.5rem">Échec du paiement</h1>
          <p style="color:#666;margin-bottom:1.5rem">Bonjour ${nom || ''},</p>
          <p>Nous n'avons pas pu prélever votre abonnement Losaro. Votre accès reste actif pendant 7 jours.</p>
          <p style="margin-top:1rem">Veuillez mettre à jour vos informations de paiement pour éviter toute interruption de service.</p>
          <a href="${PORTAL_URL}" style="display:inline-block;background:#ef4444;color:white;text-decoration:none;padding:0.85rem 2rem;border-radius:8px;font-weight:600;font-size:0.9rem;margin:1.5rem 0">
            Mettre à jour mon moyen de paiement →
          </a>
          <hr style="border:none;border-top:1px solid #e8e6dd;margin:1.5rem 0">
          <p style="font-size:0.75rem;color:#aaa"><a href="${PORTAL_URL}" style="color:#aaa">Gérer mon abonnement</a> · © 2026 Losaro · contact@losaro.fr</p>
        </div>
      `
    });
    logger.info(`Email échec paiement → ${email}`);
  } catch (err) { logger.error(`Email échec paiement error: ${err.message}`); }
}

// ── Routes ──
router.post('/create-checkout', stripeRateLimiter, async (req, res) => {
  const { plan, period, email, cabinetName } = req.body;
  if (!plan || !period || !email) return res.status(400).json({ error: 'plan, period et email requis.' });
  if (!stripe) return res.status(503).json({ error: 'Paiement non disponible.' });
  const priceId = getPriceId(plan, period);
  if (!priceId) return res.status(500).json({ error: 'Configuration tarifaire manquante.' });
  try {
    const existing = await stripe.customers.list({ email, limit: 1 });
    const customer = existing.data.length > 0
      ? existing.data[0]
      : await stripe.customers.create({ email, name: cabinetName || email });
    const session = await stripe.checkout.sessions.create({
      customer: customer.id,
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: { trial_period_days: 30 },
      success_url: `${process.env.STRIPE_SUCCESS_URL}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: process.env.STRIPE_CANCEL_URL,
      locale: 'fr',
      allow_promotion_codes: true,
    });
    res.json({ sessionId: session.id, url: session.url });
  } catch (err) {
    logger.error(`Stripe checkout error: ${err.message}`);
    res.status(500).json({ error: 'Erreur paiement.' });
  }
});

// ── Webhook Stripe ──
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  if (!stripe) return res.sendStatus(200);

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    logger.error(`Webhook signature error: ${err.message}`);
    return res.status(400).json({ error: err.message });
  }

  logger.info(`Webhook reçu: ${event.type}`);

  try {
    switch (event.type) {

      // Paiement réussi (ou démarrage d'essai à 0€)
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        const customer = await stripe.customers.retrieve(invoice.customer);
        const email = customer.email;
        const nom = customer.name || '';
        const plan = invoice.lines?.data?.[0]?.description || 'Pro';
        const amountPaid = invoice.amount_paid / 100;
        if (amountPaid === 0) {
          // Facture à 0€ = début de période d'essai, pas un vrai paiement
          const periodEnd = invoice.lines?.data?.[0]?.period?.end;
          const trialEndDate = periodEnd
            ? new Date(periodEnd * 1000).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })
            : 'la fin de votre essai';
          await sendTrialStartedEmail(email, nom, trialEndDate);
          logger.info(`Essai démarré: ${email}`);
        } else {
          await sendPaymentConfirmationEmail(email, nom, cleanPlanLabel(plan), amountPaid.toFixed(0));
          logger.info(`Paiement confirmé: ${email} — ${amountPaid}€`);
        }
        break;
      }

      // Abonnement annulé
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const customer = await stripe.customers.retrieve(sub.customer);
        const endDate = new Date(sub.current_period_end * 1000).toLocaleDateString('fr-FR', {
          day: 'numeric', month: 'long', year: 'numeric'
        });
        await sendCancellationEmail(customer.email, customer.name, endDate);
        logger.info(`Abonnement annulé: ${customer.email}`);
        break;
      }

      // Échec de paiement
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const customer = await stripe.customers.retrieve(invoice.customer);
        await sendPaymentFailedEmail(customer.email, customer.name);
        logger.info(`Échec paiement: ${customer.email}`);
        break;
      }

      // Période d'essai terminée
      case 'customer.subscription.trial_will_end': {
        const sub = event.data.object;
        const customer = await stripe.customers.retrieve(sub.customer);
        logger.info(`Essai bientôt terminé: ${customer.email}`);
        break;
      }

      default:
        logger.debug(`Webhook ignoré: ${event.type}`);
    }
  } catch (err) {
    logger.error(`Webhook handler error: ${err.message}`);
  }

  res.json({ received: true });
});

// GET /api/stripe/subscription
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
