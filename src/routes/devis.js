const express = require('express');
const { requireAuth } = require('../middleware/auth');
const logger = require('../services/logger');

const router = express.Router();

// ════════════════════════════════════════════════════
// /api/devis
// CRUD pour les devis. Statuts : draft, sent, accepted, refused.
// Un devis accepté peut être converti en facture via /:id/convert.
// ════════════════════════════════════════════════════

async function generateDevisRef(supabase, cabinetId) {
  const year = new Date().getFullYear();
  const { count } = await supabase
    .from('devis')
    .select('id', { count: 'exact', head: true })
    .eq('cabinet_id', cabinetId)
    .gte('created_at', `${year}-01-01`);
  const num = String((count || 0) + 1).padStart(4, '0');
  return `D-${year}-${num}`;
}

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

// GET /api/devis
router.get('/', requireAuth, async (req, res) => {
  const { statut = 'all', client_id } = req.query;
  try {
    let query = req.supabase
      .from('devis')
      .select('*, clients(nom, email)')
      .eq('cabinet_id', req.cabinet.id)
      .order('created_at', { ascending: false });
    if (statut !== 'all') query = query.eq('statut', statut);
    if (client_id) query = query.eq('client_id', client_id);
    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    res.json({ devis: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/devis/:id
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { data, error } = await req.supabase
      .from('devis')
      .select('*, clients(*)')
      .eq('id', req.params.id)
      .eq('cabinet_id', req.cabinet.id)
      .single();
    if (error || !data) return res.status(404).json({ error: 'Devis introuvable.' });
    res.json({ devis: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/devis
router.post('/', requireAuth, async (req, res) => {
  const { client_id, prestation, description, montant_ht, tva = 20, reference: customRef } = req.body;
  if (!montant_ht && !prestation) {
    return res.status(400).json({ error: 'prestation ou montant_ht requis.' });
  }

  try {
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

    const reference = customRef || await generateDevisRef(req.supabase, req.cabinet.id);

    const { data, error } = await req.supabase
      .from('devis')
      .insert([{
        cabinet_id: req.cabinet.id,
        client_id: client_id || null,
        reference,
        prestation: prestation?.trim() || null,
        description: description?.trim() || null,
        montant_ht: montant_ht ? parseFloat(montant_ht) : null,
        tva: parseFloat(tva),
        statut: 'draft',
        client_nom: clientNom,
        client_email: clientEmail,
      }])
      .select()
      .single();

    if (error) {
      logger.error(`POST devis error: ${error.message}`);
      return res.status(500).json({ error: error.message });
    }
    logger.info(`Devis créé: ${data.reference}`);
    res.status(201).json({ devis: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/devis/:id
router.patch('/:id', requireAuth, async (req, res) => {
  const allowedFields = ['prestation', 'description', 'montant_ht', 'tva', 'statut', 'reference'];
  const updates = {};
  for (const field of allowedFields) {
    if (req.body[field] !== undefined) updates[field] = req.body[field];
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });

  try {
    const { data, error } = await req.supabase
      .from('devis')
      .update(updates)
      .eq('id', req.params.id)
      .eq('cabinet_id', req.cabinet.id)
      .select()
      .single();
    if (error || !data) return res.status(404).json({ error: 'Devis introuvable.' });
    res.json({ devis: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/devis/:id/accept — marque comme accepté
router.post('/:id/accept', requireAuth, async (req, res) => {
  try {
    const { data, error } = await req.supabase
      .from('devis')
      .update({ statut: 'accepted' })
      .eq('id', req.params.id)
      .eq('cabinet_id', req.cabinet.id)
      .select()
      .single();
    if (error || !data) return res.status(404).json({ error: 'Devis introuvable.' });
    res.json({ devis: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/devis/:id/refuse
router.post('/:id/refuse', requireAuth, async (req, res) => {
  try {
    const { data, error } = await req.supabase
      .from('devis')
      .update({ statut: 'refused' })
      .eq('id', req.params.id)
      .eq('cabinet_id', req.cabinet.id)
      .select()
      .single();
    if (error || !data) return res.status(404).json({ error: 'Devis introuvable.' });
    res.json({ devis: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/devis/:id/convert — convertit un devis (accepté) en facture
router.post('/:id/convert', requireAuth, async (req, res) => {
  const { date_echeance } = req.body;
  if (!date_echeance) return res.status(400).json({ error: 'date_echeance requise.' });

  try {
    const { data: devis, error: devisErr } = await req.supabase
      .from('devis')
      .select('*')
      .eq('id', req.params.id)
      .eq('cabinet_id', req.cabinet.id)
      .single();
    if (devisErr || !devis) return res.status(404).json({ error: 'Devis introuvable.' });

    const tva = parseFloat(devis.tva || 20);
    const ht = parseFloat(devis.montant_ht || 0);
    const ttc = +(ht * (1 + tva / 100)).toFixed(2);

    const factureRef = await generateFactureRef(req.supabase, req.cabinet.id);

    const { data: facture, error: factureErr } = await req.supabase
      .from('factures')
      .insert([{
        cabinet_id: req.cabinet.id,
        client_id: devis.client_id,
        reference: factureRef,
        montant: ttc,
        montant_ht: ht,
        tva,
        description: devis.prestation || devis.description,
        date_echeance,
        date_emission: new Date().toISOString().slice(0, 10),
        statut: 'pending',
        client_nom: devis.client_nom,
        client_email: devis.client_email,
        last_stage_sent: 0,
      }])
      .select()
      .single();

    if (factureErr) return res.status(500).json({ error: factureErr.message });

    // Marquer le devis comme converti (statut accepted si pas déjà)
    await req.supabase
      .from('devis')
      .update({ statut: 'accepted' })
      .eq('id', devis.id);

    logger.info(`Devis ${devis.reference} → Facture ${facture.reference}`);
    res.status(201).json({ facture, devis_ref: devis.reference });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/devis/:id
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { error } = await req.supabase
      .from('devis')
      .delete()
      .eq('id', req.params.id)
      .eq('cabinet_id', req.cabinet.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
