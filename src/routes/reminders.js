const express = require('express');
const logger = require('../services/logger');
const { requireAuth } = require('../middleware/auth');
const {
  RELANCE_SCHEDULE,
  sendRelanceEmail,
  processRelancesForCabinet,
  processRelancesAll,
} = require('../services/relances');

const router = express.Router();

// ════════════════════════════════════════════════════
// /api/reminders — Système de relances Losaro
// (les anciens endpoints de rappels RDV ont été supprimés)
// ════════════════════════════════════════════════════

// GET /api/reminders/relances/schedule — calendrier de relances
router.get('/relances/schedule', (req, res) => {
  res.json({ schedule: RELANCE_SCHEDULE.map(d => ({ day: d, label: `J+${d}` })) });
});

// POST /api/reminders/relances/send — envoie une relance manuelle pour 1 facture
router.post('/relances/send', requireAuth, async (req, res) => {
  const { facture_id, stage } = req.body;
  if (!facture_id) return res.status(400).json({ error: 'facture_id requis.' });

  try {
    const { data: f, error } = await req.supabase
      .from('factures')
      .select('*')
      .eq('id', facture_id)
      .eq('cabinet_id', req.cabinet.id)
      .single();
    if (error || !f) return res.status(404).json({ error: 'Facture introuvable.' });
    if (!f.client_email) return res.status(400).json({ error: 'Pas d\'email client sur cette facture.' });

    // Garde-fous métier : pas de relance sur facture payée/annulée ni sur facture pas encore échue.
    if (f.statut === 'paid' || f.statut === 'cancelled') {
      return res.status(400).json({
        error: `Facture déjà ${f.statut === 'paid' ? 'payée' : 'annulée'}, relance impossible.`
      });
    }
    const daysLate = Math.floor(
      (new Date() - new Date(f.date_echeance)) / (1000 * 60 * 60 * 24)
    );
    if (daysLate < 1) {
      return res.status(400).json({
        error: 'Facture pas encore échue, relance impossible.'
      });
    }

    const targetStage = stage || (() => {
      // Auto : stage le plus avancé applicable selon le retard
      const now = new Date();
      const days = Math.floor((now - new Date(f.date_echeance)) / (1000 * 60 * 60 * 24));
      const lastSent = f.last_stage_sent || 0;
      const applicableStages = RELANCE_SCHEDULE.filter(s => s > lastSent && days >= s);
      return applicableStages.length > 0
        ? applicableStages[applicableStages.length - 1]
        : RELANCE_SCHEDULE[0];
    })();

    const companyName = req.cabinet.entreprise || req.cabinet.nom || 'Losaro';
    const result = await sendRelanceEmail(targetStage, {
      clientName: f.client_nom || 'Client',
      clientEmail: f.client_email,
      amount: f.montant,
      invoiceRef: f.reference,
      companyName,
      contactEmail: req.cabinet.email || 'contact@losaro.fr',
      tvaRegime: req.cabinet.tva_regime,
    });

    if (result.success) {
      await req.supabase
        .from('factures')
        .update({ last_stage_sent: targetStage, last_sent_at: new Date().toISOString() })
        .eq('id', f.id);
    }
    res.json({ ...result, stage: targetStage });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/reminders/relances/process — process les relances DU cabinet authentifié
router.post('/relances/process', requireAuth, async (req, res) => {
  try {
    const results = await processRelancesForCabinet(req.supabase, req.cabinet);
    res.json({ success: true, processed: results.length, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/reminders/relances/process-all — process pour TOUS les cabinets (cron-job.org)
// Sécurisé par un secret partagé dans le header x-cron-secret
router.post('/relances/process-all', async (req, res) => {
  const secret = req.headers['x-cron-secret'];
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    logger.warn('process-all : tentative non autorisée');
    return res.status(403).json({ error: 'Forbidden.' });
  }

  const { supabaseAdmin } = require('../middleware/auth');
  if (!supabaseAdmin) return res.status(503).json({ error: 'Supabase non disponible.' });

  try {
    const result = await processRelancesAll(supabaseAdmin);
    res.json(result);
  } catch (err) {
    logger.error(`process-all error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
