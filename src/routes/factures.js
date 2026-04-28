const express = require('express');
const { requireAuth } = require('../middleware/auth');
const logger = require('../services/logger');

const router = express.Router();

// ════════════════════════════════════════════════════
// /api/factures
// CRUD pour les factures avec gestion d'état (pending, paid, overdue, cancelled).
// La logique de relances utilise last_stage_sent + last_sent_at + date_echeance.
// ════════════════════════════════════════════════════

// Helper : génère une référence de facture séquentielle (F-2026-0001)
async function generateFactureRef(supabase, cabinetId) {
  const year = new Date().getFullYear();
  const { count } = await supabase
    .from('factures')
    .select('id', { count: 'exact', head: true })
    .eq('cabinet_id', cabinetId)
    .gte('created_at', `${year}-01-01`);
  const num = String((count || 0) + 1).padStart(4, '0');
  return `F-${year}-${num}`;
}

// GET /api/factures — liste avec filtres ?statut=pending|paid|overdue|all
router.get('/', requireAuth, async (req, res) => {
  const { statut = 'all', client_id } = req.query;

  try {
    let query = req.supabase
      .from('factures')
      .select('*, clients(nom, email)')
      .eq('cabinet_id', req.cabinet.id)
      .order('created_at', { ascending: false });

    if (statut !== 'all') query = query.eq('statut', statut);
    if (client_id) query = query.eq('client_id', client_id);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    // Recalcul du statut overdue à la volée (pas en BDD)
    const now = new Date();
    const enriched = (data || []).map(f => {
      if (f.statut === 'pending' && f.date_echeance && new Date(f.date_echeance) < now) {
        const daysLate = Math.floor((now - new Date(f.date_echeance)) / (1000 * 60 * 60 * 24));
        return { ...f, daysLate, isOverdue: true };
      }
      return { ...f, daysLate: 0, isOverdue: false };
    });

    res.json({ factures: enriched });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/factures/:id
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { data, error } = await req.supabase
      .from('factures')
      .select('*, clients(*)')
      .eq('id', req.params.id)
      .eq('cabinet_id', req.cabinet.id)
      .single();

    if (error || !data) return res.status(404).json({ error: 'Facture introuvable.' });
    res.json({ facture: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/factures
router.post('/', requireAuth, async (req, res) => {
  const {
    client_id, montant, montant_ht, tva = 20, description,
    date_echeance, date_emission, reference: customRef,
  } = req.body;

  if (!montant || !date_echeance) {
    return res.status(400).json({ error: 'montant et date_echeance requis.' });
  }

  try {
    // Snapshot du client (pour les relances même si client supprimé)
    let clientNom = null, clientEmail = null;
    if (client_id) {
      const { data: client } = await req.supabase
        .from('clients')
        .select('nom, email')
        .eq('id', client_id)
        .eq('cabinet_id', req.cabinet.id)
        .single();
      if (!client) return res.status(404).json({ error: 'Client introuvable.' });
      clientNom = client.nom;
      clientEmail = client.email;
    }

    const reference = customRef || await generateFactureRef(req.supabase, req.cabinet.id);

    const { data, error } = await req.supabase
      .from('factures')
      .insert([{
        cabinet_id: req.cabinet.id,
        client_id: client_id || null,
        reference,
        montant: parseFloat(montant),
        montant_ht: montant_ht ? parseFloat(montant_ht) : parseFloat(montant) / (1 + parseFloat(tva) / 100),
        tva: parseFloat(tva),
        description: description?.trim() || null,
        date_echeance,
        date_emission: date_emission || new Date().toISOString().slice(0, 10),
        statut: 'pending',
        client_nom: clientNom,
        client_email: clientEmail,
        last_stage_sent: 0,
      }])
      .select()
      .single();

    if (error) {
      logger.error(`POST factures error: ${error.message}`);
      return res.status(500).json({ error: error.message });
    }
    logger.info(`Facture créée: ${data.reference} (${data.montant}€)`);
    res.status(201).json({ facture: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/factures/:id
router.patch('/:id', requireAuth, async (req, res) => {
  const allowedFields = ['montant', 'montant_ht', 'tva', 'description', 'date_echeance', 'date_emission', 'statut', 'reference'];
  const updates = {};
  for (const field of allowedFields) {
    if (req.body[field] !== undefined) updates[field] = req.body[field];
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });

  try {
    const { data, error } = await req.supabase
      .from('factures')
      .update(updates)
      .eq('id', req.params.id)
      .eq('cabinet_id', req.cabinet.id)
      .select()
      .single();
    if (error || !data) return res.status(404).json({ error: 'Facture introuvable.' });
    res.json({ facture: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/factures/:id/mark-paid — raccourci pour marquer comme payée
router.post('/:id/mark-paid', requireAuth, async (req, res) => {
  try {
    const { data, error } = await req.supabase
      .from('factures')
      .update({ statut: 'paid' })
      .eq('id', req.params.id)
      .eq('cabinet_id', req.cabinet.id)
      .select()
      .single();
    if (error || !data) return res.status(404).json({ error: 'Facture introuvable.' });
    logger.info(`Facture payée: ${data.reference}`);
    res.json({ facture: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/factures/:id/cancel — annule une facture
router.post('/:id/cancel', requireAuth, async (req, res) => {
  try {
    const { data, error } = await req.supabase
      .from('factures')
      .update({ statut: 'cancelled' })
      .eq('id', req.params.id)
      .eq('cabinet_id', req.cabinet.id)
      .select()
      .single();
    if (error || !data) return res.status(404).json({ error: 'Facture introuvable.' });
    res.json({ facture: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/factures/:id
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { error } = await req.supabase
      .from('factures')
      .delete()
      .eq('id', req.params.id)
      .eq('cabinet_id', req.cabinet.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/factures/stats/summary — KPIs dashboard (CA mois, impayés, etc.)
router.get('/stats/summary', requireAuth, async (req, res) => {
  try {
    const now = new Date();
    const startMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    const { data: factures, error } = await req.supabase
      .from('factures')
      .select('montant, montant_ht, statut, date_echeance, last_stage_sent, created_at')
      .eq('cabinet_id', req.cabinet.id);

    if (error) return res.status(500).json({ error: error.message });

    const stats = {
      caTotal: 0,
      caMois: 0,
      caMoisHt: 0,
      enAttente: 0,
      enAttenteMontant: 0,
      enRetard: 0,
      enRetardMontant: 0,
      paye: 0,
      payeMontant: 0,
      relancesEnvoyees: 0,
    };

    for (const f of factures || []) {
      const montant = parseFloat(f.montant) || 0;
      const ht = parseFloat(f.montant_ht) || 0;

      if (f.statut === 'paid') {
        stats.paye++;
        stats.payeMontant += montant;
        stats.caTotal += montant;
        if (f.created_at >= startMonth) {
          stats.caMois += montant;
          stats.caMoisHt += ht;
        }
      } else if (f.statut === 'pending') {
        stats.enAttente++;
        stats.enAttenteMontant += montant;
        if (f.date_echeance && new Date(f.date_echeance) < now) {
          stats.enRetard++;
          stats.enRetardMontant += montant;
        }
      }

      if ((f.last_stage_sent || 0) > 0) stats.relancesEnvoyees++;
    }

    res.json({ stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
