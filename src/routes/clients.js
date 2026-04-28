const express = require('express');
const { requireAuth } = require('../middleware/auth');
const logger = require('../services/logger');

const router = express.Router();

// ════════════════════════════════════════════════════
// /api/clients
// CRUD pour les clients d'un cabinet (artisan/PME).
// Toutes les routes requièrent une authentification valide.
// ════════════════════════════════════════════════════

// GET /api/clients — liste les clients du cabinet authentifié
router.get('/', requireAuth, async (req, res) => {
  try {
    const { data, error } = await req.supabase
      .from('clients')
      .select('*')
      .eq('cabinet_id', req.cabinet.id)
      .order('created_at', { ascending: false });

    if (error) {
      logger.error(`GET clients error: ${error.message}`);
      return res.status(500).json({ error: error.message });
    }
    res.json({ clients: data || [] });
  } catch (err) {
    logger.error(`GET clients exception: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/clients/:id — récupère un client précis (avec ses factures et devis)
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { data: client, error } = await req.supabase
      .from('clients')
      .select('*')
      .eq('id', req.params.id)
      .eq('cabinet_id', req.cabinet.id)
      .single();

    if (error || !client) return res.status(404).json({ error: 'Client introuvable.' });

    const { data: factures } = await req.supabase
      .from('factures')
      .select('*')
      .eq('client_id', client.id)
      .order('created_at', { ascending: false });

    const { data: devis } = await req.supabase
      .from('devis')
      .select('*')
      .eq('client_id', client.id)
      .order('created_at', { ascending: false });

    res.json({ client, factures: factures || [], devis: devis || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/clients — crée un nouveau client
router.post('/', requireAuth, async (req, res) => {
  const { nom, email, telephone, entreprise } = req.body;
  if (!nom) return res.status(400).json({ error: 'nom requis.' });

  try {
    const { data, error } = await req.supabase
      .from('clients')
      .insert([{
        cabinet_id: req.cabinet.id,
        nom: nom.trim(),
        email: email?.trim() || null,
        telephone: telephone?.trim() || null,
        entreprise: entreprise?.trim() || null,
      }])
      .select()
      .single();

    if (error) {
      logger.error(`POST clients error: ${error.message}`);
      return res.status(500).json({ error: error.message });
    }
    logger.info(`Client créé: ${data.id} (cabinet ${req.cabinet.id})`);
    res.status(201).json({ client: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/clients/:id — met à jour un client
router.patch('/:id', requireAuth, async (req, res) => {
  const { nom, email, telephone, entreprise } = req.body;
  const updates = {};
  if (nom !== undefined) updates.nom = nom.trim();
  if (email !== undefined) updates.email = email?.trim() || null;
  if (telephone !== undefined) updates.telephone = telephone?.trim() || null;
  if (entreprise !== undefined) updates.entreprise = entreprise?.trim() || null;

  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });

  try {
    const { data, error } = await req.supabase
      .from('clients')
      .update(updates)
      .eq('id', req.params.id)
      .eq('cabinet_id', req.cabinet.id)
      .select()
      .single();

    if (error || !data) return res.status(404).json({ error: 'Client introuvable.' });
    res.json({ client: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/clients/:id — supprime un client (cascade sur factures/devis via FK)
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    // Vérifier qu'il appartient bien au cabinet
    const { data: client } = await req.supabase
      .from('clients')
      .select('id')
      .eq('id', req.params.id)
      .eq('cabinet_id', req.cabinet.id)
      .single();

    if (!client) return res.status(404).json({ error: 'Client introuvable.' });

    const { error } = await req.supabase
      .from('clients')
      .delete()
      .eq('id', req.params.id)
      .eq('cabinet_id', req.cabinet.id);

    if (error) return res.status(500).json({ error: error.message });
    logger.info(`Client supprimé: ${req.params.id}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/clients/import — import en bulk depuis un CSV (JSON array)
router.post('/import', requireAuth, async (req, res) => {
  const { clients } = req.body;
  if (!Array.isArray(clients) || clients.length === 0) {
    return res.status(400).json({ error: 'clients (array) requis.' });
  }
  if (clients.length > 1000) {
    return res.status(400).json({ error: 'Maximum 1000 clients par import.' });
  }

  const rows = clients
    .filter(c => c.nom)
    .map(c => ({
      cabinet_id: req.cabinet.id,
      nom: String(c.nom).trim(),
      email: c.email?.trim() || null,
      telephone: c.telephone?.trim() || null,
      entreprise: c.entreprise?.trim() || null,
    }));

  if (rows.length === 0) return res.status(400).json({ error: 'Aucun client valide (nom requis).' });

  try {
    const { data, error } = await req.supabase.from('clients').insert(rows).select();
    if (error) return res.status(500).json({ error: error.message });
    logger.info(`Import: ${data.length} clients pour cabinet ${req.cabinet.id}`);
    res.status(201).json({ imported: data.length, clients: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
