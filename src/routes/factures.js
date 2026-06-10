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

// POST /api/factures/import — import bulk clients + factures impayées (active les relances)
// Body : { rows: [{ nom_client, email_client, reference_facture, montant, date_echeance }] }
router.post('/import', requireAuth, async (req, res) => {
  const { rows } = req.body;
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: 'rows (array) requis.' });
  }
  if (rows.length > 2000) {
    return res.status(400).json({ error: 'Maximum 2000 lignes par import.' });
  }

  // Parseurs tolérants (formats FR)
  const parseDate = (s) => {
    if (!s) return null;
    const v = String(s).trim();
    let m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    m = v.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
    if (m) {
      let [, d, mo, y] = m;
      if (y.length === 2) y = '20' + y;
      return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }
    return null;
  };
  const parseMontant = (s) => {
    if (s === undefined || s === null || s === '') return NaN;
    return parseFloat(String(s).replace(/\s/g, '').replace(',', '.').replace(/[^\d.-]/g, ''));
  };

  const errors = [];
  const valid = [];
  rows.forEach((r, i) => {
    const ligne = i + 2; // ligne 1 = entête
    const nom = (r.nom_client ?? r.nom ?? '').toString().trim();
    const email = ((r.email_client ?? r.email ?? '').toString().trim()) || null;
    const telephone = ((r.telephone ?? r.tel ?? '').toString().trim()) || null;
    const entreprise = ((r.entreprise ?? r.societe ?? '').toString().trim()) || null;
    const reference = ((r.reference_facture ?? r.reference ?? '').toString().trim()) || null;
    const montant = parseMontant(r.montant ?? r.montant_ht);
    const echeance = parseDate(r.date_echeance ?? r.echeance);
    if (!nom) { errors.push(`Ligne ${ligne}: nom_client manquant`); return; }
    if (isNaN(montant) || montant <= 0) { errors.push(`Ligne ${ligne}: montant invalide`); return; }
    if (!echeance) { errors.push(`Ligne ${ligne}: date_echeance invalide`); return; }
    valid.push({ nom, email, telephone, entreprise, reference, montant, echeance });
  });

  if (valid.length === 0) {
    return res.status(400).json({ error: 'Aucune ligne valide.', errors: errors.slice(0, 20) });
  }

  try {
    const keyOf = (nom, email) => `${(nom || '').toLowerCase()}|${(email || '').toLowerCase()}`;

    // 1) Clients existants → dédup
    const { data: existing } = await req.supabase
      .from('clients').select('id, nom, email').eq('cabinet_id', req.cabinet.id);
    const clientMap = new Map();
    (existing || []).forEach(c => clientMap.set(keyOf(c.nom, c.email), c));

    // 2) Créer les nouveaux clients en bulk
    const toCreate = new Map();
    valid.forEach(v => {
      const k = keyOf(v.nom, v.email);
      if (!clientMap.has(k) && !toCreate.has(k)) {
        toCreate.set(k, { cabinet_id: req.cabinet.id, nom: v.nom, email: v.email, telephone: v.telephone, entreprise: v.entreprise });
      }
    });
    let clientsCreated = 0;
    if (toCreate.size > 0) {
      const { data: created, error: cErr } = await req.supabase
        .from('clients').insert([...toCreate.values()]).select('id, nom, email');
      if (cErr) return res.status(500).json({ error: cErr.message });
      created.forEach(c => clientMap.set(keyOf(c.nom, c.email), c));
      clientsCreated = created.length;
    }

    // 3) Référence séquentielle calculée une fois (évite les doublons en bulk)
    const year = new Date().getFullYear();
    const { count: baseCount } = await req.supabase
      .from('factures').select('id', { count: 'exact', head: true })
      .eq('cabinet_id', req.cabinet.id).gte('created_at', `${year}-01-01`);
    let seq = baseCount || 0;
    const nextRef = () => { seq += 1; return `F-${year}-${String(seq).padStart(4, '0')}`; };

    // 4) Construire et insérer les factures (statut pending → relances actives)
    const factureRows = valid.map(v => {
      const client = clientMap.get(keyOf(v.nom, v.email));
      return {
        cabinet_id: req.cabinet.id,
        client_id: client?.id || null,
        reference: v.reference || nextRef(),
        montant: v.montant,
        montant_ht: v.montant,
        tva: 0,
        description: 'Import CSV',
        date_echeance: v.echeance,
        date_emission: v.echeance,
        statut: 'pending',
        client_nom: v.nom,
        client_email: v.email,
        last_stage_sent: 0,
      };
    });

    const { data: facts, error: fErr } = await req.supabase
      .from('factures').insert(factureRows).select('id');
    if (fErr) return res.status(500).json({ error: fErr.message });

    logger.info(`Import: ${clientsCreated} clients + ${facts.length} factures (cabinet ${req.cabinet.id})`);
    res.status(201).json({
      clients_created: clientsCreated,
      factures_created: facts.length,
      skipped: errors.length,
      errors: errors.slice(0, 20),
    });
  } catch (err) {
    logger.error(`Import factures exception: ${err.message}`);
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
