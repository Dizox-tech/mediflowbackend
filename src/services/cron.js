const cron = require('node-cron');
const fetch = require('node-fetch');
const logger = require('./logger');

const BASE_URL = `http://localhost:${process.env.PORT || 3001}`;

const syncJob = cron.schedule('*/15 * * * *', async () => {
  logger.info('⏰ Cron — Sync iCal + rappels');
  try {
    const res = await fetch(`${BASE_URL}/api/ical/rdvs?cabinetId=demo`);
    const data = await res.json();
    if (!data.connected || data.rdvs.length === 0) return;
    await fetch(`${BASE_URL}/api/reminders/process`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rdvs: data.rdvs, settings: { sms48h: true, email24h: true } }),
    });
  } catch (err) {
    logger.error(`Cron error: ${err.message}`);
  }
}, { scheduled: false });

const dailyReport = cron.schedule('0 9 * * *', () => {
  logger.info('📊 Rapport quotidien');
}, { scheduled: false });

const startCronJobs = () => { syncJob.start(); dailyReport.start(); logger.info('✅ Cron jobs démarrés'); };
const stopCronJobs = () => { syncJob.stop(); dailyReport.stop(); };

module.exports = { startCronJobs, stopCronJobs };
