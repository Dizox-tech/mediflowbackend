const express = require('express');
const logger = require('../services/logger');
const router = express.Router();

let twilioClient = null;
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  try {
    twilioClient = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    logger.info('Twilio initialisé');
  } catch { logger.warn('Twilio non disponible'); }
}

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

const sendEmail = async ({ to, subject }) => {
  logger.debug(`[EMAIL SIMULÉ] → ${to} | ${subject}`);
  return { success: true, simulated: true };
};

router.post('/send', async (req, res) => {
  const { rdv, patientPhone, patientEmail, type = 'sms', cabinetConfig = {} } = req.body;
  if (!rdv?.debut) return res.status(400).json({ error: 'rdv.debut requis.' });
  const { medecin = 'votre médecin', telephone = '' } = cabinetConfig;
  const results = [];
  if ((type === 'sms' || type === 'both') && patientPhone) {
    const msg = `Rappel MediFlow : RDV avec ${medecin} le ${formatDate(rdv.debut)} à ${formatTime(rdv.debut)}. Annulation : ${telephone}`;
    results.push({ channel: 'sms', ...await sendSMS({ to: patientPhone, message: msg }) });
  }
  if ((type === 'email' || type === 'both') && patientEmail) {
    results.push({ channel: 'email', ...await sendEmail({ to: patientEmail, subject: `Rappel RDV — ${formatDate(rdv.debut)}` }) });
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
      await sendEmail({ to: rdv.patientEmail, subject: `Rappel RDV demain — ${formatTime(rdv.debut)}` });
      rdv.rappelEmail = true; sent++;
    }
  }
  res.json({ success: true, sent });
});

router.get('/stats', (req, res) => {
  res.json({ today: { sent: 12, confirmed: 8 }, month: { sent: 248, noShows: 3 }, timeSaved: '4h32' });
});

module.exports = router;
