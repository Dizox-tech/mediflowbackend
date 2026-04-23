const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { createCabinet, getCabinetByEmail } = require('../services/supabase');
const logger = require('../services/logger');
const { Resend } = require('resend');

const router = express.Router();

const supabaseAdmin = process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY)
  : null;

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// ── Email de bienvenue ──
async function sendWelcomeEmail(email, nom) {
  if (!resend) {
    logger.debug(`[EMAIL BIENVENUE SIMULÉ] → ${email}`);
    return;
  }
  try {
    await resend.emails.send({
      from: 'Losaro <contact@losaro.fr>',
      to: email,
      subject: 'Bienvenue sur Losaro — votre compte est actif',
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:2rem;color:#1a1a17">
          <div style="margin-bottom:2rem">
            <strong style="font-size:1.3rem;letter-spacing:-0.03em">Losaro</strong>
          </div>

          <h1 style="font-size:1.4rem;font-weight:700;letter-spacing:-0.03em;margin-bottom:0.5rem">
            Bienvenue ${nom ? nom : ''} 👋
          </h1>
          <p style="color:#666;margin-bottom:2rem">Votre compte Losaro est actif. Voici comment démarrer.</p>

          <div style="background:#f8f7f4;border-radius:12px;padding:1.5rem;margin-bottom:1.5rem">
            <p style="font-weight:600;margin-bottom:1rem">3 choses à faire maintenant :</p>
            <div style="display:flex;flex-direction:column;gap:0.8rem">
              <div style="display:flex;align-items:flex-start;gap:0.8rem">
                <span style="background:#1a56ff;color:white;border-radius:50%;width:22px;height:22px;display:flex;align-items:center;justify-content:center;font-size:0.75rem;flex-shrink:0;margin-top:1px">1</span>
                <div>
                  <strong>Ajoutez votre premier client</strong>
                  <p style="color:#666;font-size:0.85rem;margin:0.2rem 0 0">Renseignez ses coordonnées et ses factures en attente.</p>
                </div>
              </div>
              <div style="display:flex;align-items:flex-start;gap:0.8rem">
                <span style="background:#1a56ff;color:white;border-radius:50%;width:22px;height:22px;display:flex;align-items:center;justify-content:center;font-size:0.75rem;flex-shrink:0;margin-top:1px">2</span>
                <div>
                  <strong>Activez vos relances automatiques</strong>
                  <p style="color:#666;font-size:0.85rem;margin:0.2rem 0 0">Losaro s'occupe des relances J+7, J+15, J+30, J+45 et J+60.</p>
                </div>
              </div>
              <div style="display:flex;align-items:flex-start;gap:0.8rem">
                <span style="background:#1a56ff;color:white;border-radius:50%;width:22px;height:22px;display:flex;align-items:center;justify-content:center;font-size:0.75rem;flex-shrink:0;margin-top:1px">3</span>
                <div>
                  <strong>Générez votre premier devis</strong>
                  <p style="color:#666;font-size:0.85rem;margin:0.2rem 0 0">Décrivez votre prestation, Losaro génère et envoie le devis.</p>
                </div>
              </div>
            </div>
          </div>

          <a href="https://losaro.fr" style="display:inline-block;background:#0f0f0d;color:white;text-decoration:none;padding:0.85rem 2rem;border-radius:8px;font-weight:600;font-size:0.9rem;margin-bottom:2rem">
            Accéder à mon tableau de bord →
          </a>

          <hr style="border:none;border-top:1px solid #e8e6dd;margin:1.5rem 0">

          <p style="font-size:0.8rem;color:#888">
            Une question ? Répondez directement à cet email ou écrivez-nous à 
            <a href="mailto:contact@losaro.fr" style="color:#1a56ff">contact@losaro.fr</a>
          </p>
          <p style="font-size:0.75rem;color:#aaa;margin-top:0.5rem">
            © 2026 Losaro · 55 rue Henri Barbusse, 77124 Crégy-lès-Meaux
          </p>
        </div>
      `
    });
    logger.info(`Email de bienvenue envoyé → ${email}`);
  } catch (err) {
    logger.error(`Erreur email bienvenue: ${err.message}`);
  }
}

// POST /api/auth/signup
router.post('/signup', async (req, res) => {
  const { email, password, nom, secteur, entreprise } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'email et password requis.' });
  }
  if (!supabaseAdmin) return res.status(503).json({ error: 'Auth non disponible.' });
  try {
    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email, password, email_confirm: true,
      user_metadata: { nom, secteur, entreprise }
    });
    if (error) return res.status(400).json({ error: error.message });

    const cabinet = await createCabinet({
      email,
      nom: nom || email,
      entreprise: entreprise || '',
      secteur: secteur || '',
    });

    // Envoyer l'email de bienvenue
    await sendWelcomeEmail(email, nom);

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

// GET /api/auth/me
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
