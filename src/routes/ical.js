const express = require('express');
const fetch = require('node-fetch');
const ical = require('node-ical');
const logger = require('../services/logger');

const router = express.Router();
const icalCache = new Map();

const isValidIcalUrl = (url) => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' &&
      (parsed.hostname.includes('doctolib.fr') || parsed.pathname.endsWith('.ics'));
  } catch { return false; }
};

const parseIcalEvents = (events) => {
  const now = new Date();
  const in30days = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  return Object.values(events)
    .filter(e => e.type === 'VEVENT' && e.start && new Date(e.start) >= now && new Date(e.start) <= in30days)
    .map(e => ({
      id: e.uid || String(Math.random()),
      titre: e.summary || 'Rendez-vous',
      debut: new Date(e.start).toISOString(),
      fin: e.end ? new Date(e.end).toISOString() : null,
      patient: (e.summary || '').replace(/^RDV\s*/i, '').trim() || 'Patient',
      statut: 'confirmed',
      rappelSms: false,
      rappelEmail: false,
    }))
    .sort((a, b) => new Date(a.debut) - new Date(b.debut));
};

router.post('/sync', async (req, res) => {
  const { icalUrl, cabinetId = 'demo' } = req.body;
  if (!icalUrl) return res.status(400).json({ error: 'icalUrl requis.' });
  if (!isValidIcalUrl(icalUrl)) return res.status(400).json({ error: 'Lien iCal invalide.' });
  try {
    const response = await fetch(icalUrl, { headers: { 'User-Agent': 'MediFlow/1.0' } });
    if (!response.ok) return res.status(400).json({ error: `Impossible de lire le lien (${response.status}).` });
    const icalText = await response.text();
    if (!icalText.includes('BEGIN:VCALENDAR')) return res.status(400).json({ error: 'Lien invalide.' });
    const events = ical.parseICS(icalText);
    const rdvs = parseIcalEvents(events);
    icalCache.set(cabinetId, { icalUrl, rdvs, lastSync: new Date().toISOString(), total: rdvs.length });
    logger.info(`iCal sync OK — ${rdvs.length} RDV pour ${cabinetId}`);
    res.json({ success: true, rdvs, total: rdvs.length, lastSync: new Date().toISOString() });
  } catch (err) {
    logger.error(`iCal error: ${err.message}`);
    res.status(500).json({ error: 'Erreur lecture calendrier.' });
  }
});

router.get('/rdvs', (req, res) => {
  const { cabinetId = 'demo' } = req.query;
  const cached = icalCache.get(cabinetId);
  if (!cached) return res.json({ rdvs: [], total: 0, lastSync: null, connected: false });
  res.json({ rdvs: cached.rdvs, total: cached.total, lastSync: cached.lastSync, connected: true });
});

module.exports = router;
