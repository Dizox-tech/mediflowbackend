const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { createCabinet, getCabinetByEmail } = require('../services/supabase');
const logger = require('../services/logger');

const router = express.Router();

const supabaseAdmin = process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY)
  : null;

// POST /api/auth/signup
router.post('/signup', async (req, res) => {
  const { email, password, medecin, nom, specialite } = req.body;
  if (!email || !password || !medecin) {
    return res.status(400).json({ error: 'email, password et medecin requis.' });
  }
  if (!supabaseAdmin) return res.status(503).json({ error: 'Auth non disponible.' });
  try {
    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email, password, email_confirm: true,
      user_metadata: { medecin, nom, specialite }
    });
    if (error) return res.status(400).json({ error: error.message });
    const cabinet = await createCabinet({
      email,
      nom: nom || medecin,
      medecin,
      specialite: specialite || 'Médecin généraliste',
    });
    logger.info(`Signup: ${email}`);
    res.json({ user: data.user, cabinet });
  } catch (err) {
    logger.error(`Signup error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email et password requis.' });
  if (!supabaseAdmin) return res.status(503).json({ error: 'Auth non disponible.' });
  try {
    const { data, error } = await supabaseAdmin.auth.signInWithPassword({ email, password });
    if (error) return res.status(401).json({ error: 'Email ou mot de passe incorrect.' });
    const cabinet = await getCabinetByEmail(email);
    logger.info(`Login: ${email}`);
    res.json({ user: data.user, session: data.session, cabinet });
  } catch (err) {
    logger.error(`Login error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/logout
router.post('/logout', async (req, res) => {
  res.json({ success: true });
});

// GET /api/auth/me — vérifie le token et retourne l'utilisateur
router.get('/me', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token || !supabaseAdmin) return res.status(401).json({ error: 'Non authentifié.' });
  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error) return res.status(401).json({ error: 'Token invalide.' });
    const cabinet = await getCabinetByEmail(data.user.email);
    res.json({ user: data.user, cabinet });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
