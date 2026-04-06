const express = require('express');
const { createCabinet, getCabinetByEmail, updateCabinet } = require('../services/supabase');
const logger = require('../services/logger');

const router = express.Router();

router.post('/create', async (req, res) => {
  const { email, nom, medecin, specialite, telephone, adresse, horaires } = req.body;
  if (!email || !nom || !medecin) return res.status(400).json({ error: 'email, nom et medecin requis.' });
  try {
    const existing = await getCabinetByEmail(email);
    if (existing) return res.json({ cabinet: existing, created: false });
    const cabinet = await createCabinet({ email, nom, medecin, specialite, telephone, adresse, horaires });
    if (!cabinet) return res.status(500).json({ error: 'Erreur création cabinet.' });
    logger.info(`Cabinet créé: ${email}`);
    res.json({ cabinet, created: true });
  } catch (err) {
    logger.error(`Cabinet create error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  const { getCabinet } = require('../services/supabase');
  const cabinet = await getCabinet(req.params.id);
  if (!cabinet) return res.status(404).json({ error: 'Cabinet introuvable.' });
  res.json({ cabinet });
});

router.patch('/:id', async (req, res) => {
  const cabinet = await updateCabinet(req.params.id, req.body);
  if (!cabinet) return res.status(500).json({ error: 'Erreur mise à jour.' });
  res.json({ cabinet });
});

module.exports = router;
