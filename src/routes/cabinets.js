const express = require('express');
const { requireAuth } = require('../middleware/auth');
const logger = require('../services/logger');

const router = express.Router();

// ════════════════════════════════════════════════════
// /api/cabinets — gestion du cabinet (entreprise) courant
// (les références "cabinet" sont conservées pour ne pas casser
// le schéma BDD, mais sémantiquement il s'agit de l'entreprise.)
// ════════════════════════════════════════════════════

// GET /api/cabinets/me — récupère le cabinet du user authentifié
router.get('/me', requireAuth, (req, res) => {
  res.json({ cabinet: req.cabinet });
});

// PATCH /api/cabinets/me — met à jour son propre cabinet
router.patch('/me', requireAuth, async (req, res) => {
  const allowedFields = ['nom', 'entreprise', 'secteur', 'telephone', 'adresse', 'horaires', 'logo_url', 'tva_regime', 'tva_defaut'];
  const updates = {};
  for (const f of allowedFields) {
    if (req.body[f] !== undefined) updates[f] = req.body[f];
  }
  // Validation TVA
  if (updates.tva_regime !== undefined && !['franchise', 'assujetti'].includes(updates.tva_regime)) {
    return res.status(400).json({ error: 'tva_regime invalide.' });
  }
  if (updates.tva_defaut !== undefined) {
    const t = parseFloat(updates.tva_defaut);
    if (isNaN(t) || t < 0 || t > 100) return res.status(400).json({ error: 'tva_defaut invalide.' });
    updates.tva_defaut = t;
  }
  if (updates.tva_regime === 'franchise') updates.tva_defaut = 0;
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'Aucun champ à mettre à jour.' });

  try {
    const { data, error } = await req.supabase
      .from('cabinets')
      .update(updates)
      .eq('id', req.cabinet.id)
      .select()
      .single();
    if (error || !data) return res.status(500).json({ error: error?.message || 'Erreur mise à jour.' });
    res.json({ cabinet: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/cabinets/:id — admin only (pas implémenté pour l'instant)
router.get('/:id', requireAuth, async (req, res) => {
  if (req.cabinet.id !== req.params.id) {
    return res.status(403).json({ error: 'Accès interdit.' });
  }
  res.json({ cabinet: req.cabinet });
});

module.exports = router;
