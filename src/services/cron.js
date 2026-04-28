const cron = require('node-cron');
const logger = require('./logger');
const { supabaseAdmin } = require('../middleware/auth');
const { processRelancesAll } = require('./relances');

// ════════════════════════════════════════════════════
// Cron Losaro
// 1. Tous les jours à 9h00 (heure Paris) → traite les relances impayés
// 2. Tous les lundis à 8h00 → rapport hebdomadaire (pour plus tard)
// ════════════════════════════════════════════════════

const dailyRelances = cron.schedule('0 9 * * *', async () => {
  logger.info('⏰ Cron quotidien — process relances Losaro');
  if (!supabaseAdmin) {
    logger.error('Cron relances: supabaseAdmin non disponible');
    return;
  }
  try {
    const res = await processRelancesAll(supabaseAdmin);
    logger.info(`Cron quotidien terminé : ${res.processed} relance(s) envoyée(s)`);
  } catch (err) {
    logger.error(`Cron relances error: ${err.message}`);
  }
}, { scheduled: false, timezone: 'Europe/Paris' });

const weeklyReport = cron.schedule('0 8 * * 1', () => {
  logger.info('📊 Cron hebdomadaire — rapport (placeholder)');
  // TODO : envoyer un email récap aux dirigeants
}, { scheduled: false, timezone: 'Europe/Paris' });

const startCronJobs = () => {
  dailyRelances.start();
  weeklyReport.start();
  logger.info('✅ Cron jobs démarrés (relances 9h, rapport lundi 8h)');
};

const stopCronJobs = () => {
  dailyRelances.stop();
  weeklyReport.stop();
};

module.exports = { startCronJobs, stopCronJobs };
