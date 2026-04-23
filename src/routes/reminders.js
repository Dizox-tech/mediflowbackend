const express = require('express');
const logger = require('../services/logger');
const router = express.Router();
const { Resend } = require('resend');

// ── Resend ──
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// ── Twilio (optionnel) ──
let twilioClient = null;
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  try {
    twilioClient = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    logger.info('Twilio initialisé');
  } catch { logger.warn('Twilio non disponible'); }
}

// ── Helpers ──
const formatDate = (iso) => new Date(iso).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
const formatTime = (iso) => new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
const hoursUntil = (iso) => (new Date(iso) - new Date()) / (1000 * 60 * 60);

const sendSMS = async ({ to, message }) => {
  if (!twilioClient) { logger.debug(`[SMS SIMULÉ] → ${to}: ${message.slice(0, 60)}`); return { success: true, simulated: true }; }
  try {
    const msg = await twilioClient.messages.create({ body: message, from: process.env.TWILIO_PHONE_NUMBER, to });
    return { success: true, sid: msg.sid };
  } catch (err) { return { success: false, error: err.message }; }
};

// ════════════════════════════════════════
// SYSTÈME DE RELANCES LOSARO
// ════════════════════════════════════════

const RELANCE_SCHEDULE = [7, 15, 30, 45, 60];

function getRelanceTemplate(stage, data) {
  const { clientName, amount, invoiceRef, companyName, contactEmail } = data;

  const templates = {
    7: {
      subject: `Rappel – Facture ${invoiceRef} en attente de règlement`,
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:2rem;color:#1a1a17">
        <p style="font-weight:700;font-size:1.1rem;margin-bottom:1.5rem">${companyName}</p>
        <p>Bonjour ${clientName},</p>
        <p>Nous vous contactons concernant notre facture <strong>${invoiceRef}</strong> d'un montant de <strong>${amount}€ HT</strong>, dont l'échéance est maintenant dépassée de 7 jours.</p>
        <p>Si vous avez déjà procédé au règlement, merci de ne pas tenir compte de ce message. Dans le cas contraire, nous vous remercions de bien vouloir régulariser cette situation dans les meilleurs délais.</p>
        <p>Pour toute question : <a href="mailto:${contactEmail}">${contactEmail}</a></p>
        <p>Cordialement,<br>${companyName}</p>
      </div>`
    },
    15: {
      subject: `2ème rappel – Facture ${invoiceRef} – Règlement urgent`,
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:2rem;color:#1a1a17">
        <p style="font-weight:700;font-size:1.1rem;margin-bottom:1.5rem">${companyName}</p>
        <p>Bonjour ${clientName},</p>
        <p>Sauf erreur de notre part, nous n'avons pas encore reçu le règlement de notre facture <strong>${invoiceRef}</strong> de <strong>${amount}€ HT</strong>, qui accuse désormais un retard de 15 jours.</p>
        <p>Nous vous demandons de procéder au règlement dans un délai de 48 heures. Sans réponse, nous appliquerons les pénalités de retard prévues dans nos CGV.</p>
        <p>Cordialement,<br>${companyName}</p>
      </div>`
    },
    30: {
      subject: `URGENT – Facture ${invoiceRef} impayée – ${amount}€`,
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:2rem;color:#1a1a17">
        <p style="font-weight:700;font-size:1.1rem;margin-bottom:1.5rem">${companyName}</p>
        <p>Bonjour ${clientName},</p>
        <p>Malgré nos précédentes relances, la facture <strong>${invoiceRef}</strong> de <strong>${amount}€ HT</strong> reste impayée depuis 30 jours.</p>
        <p>Nous vous mettons en demeure de régler cette somme dans un délai de 8 jours. Sans règlement, nous engagerons une procédure de recouvrement.</p>
        <p>Cordialement,<br>${companyName}</p>
      </div>`
    },
    45: {
      subject: `Mise en demeure – Facture ${invoiceRef} – Action requise`,
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:2rem;color:#1a1a17">
        <p style="font-weight:700;font-size:1.1rem;margin-bottom:1.5rem">${companyName}</p>
        <p>Bonjour ${clientName},</p>
        <p>La facture <strong>${invoiceRef}</strong> de <strong>${amount}€ HT</strong> est impayée depuis 45 jours. Toutes nos tentatives de règlement amiable sont restées sans suite.</p>
        <p>Sans règlement dans les 5 jours ouvrés, nous transmettrons ce dossier à notre service contentieux.</p>
        <p>Cordialement,<br>${companyName}</p>
      </div>`
    },
    60: {
      subject: `Dernier avertissement – Facture ${invoiceRef} – Recouvrement imminent`,
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:2rem;color:#1a1a17">
        <p style="font-weight:700;font-size:1.1rem;margin-bottom:1.5rem">${companyName}</p>
        <p>Bonjour ${clientName},</p>
        <p>Ceci est notre dernier avertissement concernant la facture <strong>${invoiceRef}</strong> de <strong>${amount}€ HT</strong>, impayée depuis 60 jours.</p>
        <p>Sans règlement immédiat, nous engageons une procédure de recouvrement judiciaire sans autre préavis. Les frais de procédure seront à votre charge.</p>
        <p>Cordialement,<br>${companyName}</p>
      </div>`
    }
  };

  return templates[stage] || templates[7];
}

async function sendRelanceEmail(stage, data) {
  const template = getRelanceTemplate(stage, data);

  if (!resend) {
    logger.debug(`[EMAIL RELANCE SIMULÉ] → ${data.clientEmail} | J+${stage} | ${data.invoiceRef}`);
    return { success: true, simulated: true };
  }

  try {
    const result = await resend.emails.send({
      from: `${data.companyName} <relances@losaro.fr>`,
      to: data.clientEmail,
      subject: template.subject,
      html: template.html,
      reply_to: data.contactEmail || 'contact@losaro.fr'
    });
    logger.info(`Relance J+${stage} envoyée → ${data.clientEmail} | ${data.invoiceRef}`);
    return { success: true, id: result.id };
  } catch (error) {
    logger.error(`Resend error: ${error.message}`);
    return { success: false, error: error.message };
  }
}

// POST /api/reminders/relances/send — Envoyer une relance manuelle
router.post('/relances/send', async (req, res) => {
  const { stage = 7, clientName, clientEmail, amount, invoiceRef, companyName, contactEmail } = req.body;

  if (!clientEmail || !invoiceRef) {
    return res.status(400).json({ error: 'clientEmail et invoiceRef sont requis.' });
  }

  const result = await sendRelanceEmail(stage, {
    clientName: clientName || 'Client',
    clientEmail,
    amount: amount || 0,
    invoiceRef,
    companyName: companyName || 'Losaro',
    contactEmail: contactEmail || 'contact@losaro.fr'
  });

  res.json(result);
});

// POST /api/reminders/relances/process — Traiter toutes les relances en attente
router.post('/relances/process', async (req, res) => {
  const { rappels = [] } = req.body;
  const now = new Date();
  const results = [];

  for (const rappel of rappels) {
    const dueDate = new Date(rappel.dueDate);
    const daysLate = Math.floor((now - dueDate) / (1000 * 60 * 60 * 24));
    const lastStage = rappel.lastStageSent || 0;

    const nextStage = RELANCE_SCHEDULE.find(s => s > lastStage && daysLate >= s);
    if (!nextStage) continue;

    const result = await sendRelanceEmail(nextStage, rappel);
    results.push({ id: rappel.id, stage: nextStage, ...result });
  }

  res.json({ success: true, processed: results.length, results });
});

// GET /api/reminders/relances/schedule — Retourner le calendrier de relances
router.get('/relances/schedule', (req, res) => {
  res.json({ schedule: RELANCE_SCHEDULE.map(d => ({ day: d, label: `J+${d}` })) });
});

// ════════════════════════════════════════
// ANCIEN SYSTÈME RAPPELS RDV (conservé)
// ════════════════════════════════════════

router.post('/send', async (req, res) => {
  const { rdv, patientPhone, patientEmail, type = 'sms', cabinetConfig = {} } = req.body;
  if (!rdv?.debut) return res.status(400).json({ error: 'rdv.debut requis.' });
  const { medecin = 'votre médecin', telephone = '' } = cabinetConfig;
  const results = [];
  if ((type === 'sms' || type === 'both') && patientPhone) {
    const msg = `Rappel : RDV avec ${medecin} le ${formatDate(rdv.debut)} à ${formatTime(rdv.debut)}. Annulation : ${telephone}`;
    results.push({ channel: 'sms', ...await sendSMS({ to: patientPhone, message: msg }) });
  }
  if ((type === 'email' || type === 'both') && patientEmail) {
    results.push({ channel: 'email', success: true, simulated: true });
  }
  res.json({ success: true, results });
});

router.post('/process', async (req, res) => {
  const { rdvs = [], config = {}, settings = {} } = req.body;
  const { sms48h = true, email24h = true } = settings;
  let sent = 0;
  for (const rdv of rdvs) {
    const hours = hoursUntil(rdv.debut);
    if (sms48h && hours >= 47 && hours <= 49 && !rdv.rappelSms && rdv.patientPhone) {
      await sendSMS({ to: rdv.patientPhone, message: `Rappel RDV avec ${config.medecin} le ${formatDate(rdv.debut)} à ${formatTime(rdv.debut)}` });
      rdv.rappelSms = true; sent++;
    }
    if (email24h && hours >= 23 && hours <= 25 && !rdv.rappelEmail && rdv.patientEmail) {
      rdv.rappelEmail = true; sent++;
    }
  }
  res.json({ success: true, sent });
});

router.get('/stats', (req, res) => {
  res.json({ today: { sent: 12, confirmed: 8 }, month: { sent: 248, noShows: 3 }, timeSaved: '4h32' });
});

module.exports = router;
