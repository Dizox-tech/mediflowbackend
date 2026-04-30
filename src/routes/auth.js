const express = require('express');
const { supabaseAdmin } = require('../middleware/auth');
const logger = require('../services/logger');
const { Resend } = require('resend');

const router = express.Router();

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// ──────────────────────────────────────────────────
// ensureCabinet — idempotent
//   1. Cherche le cabinet par email
//   2. S'il n'existe pas, le crée à la volée à partir du user.user_metadata
//   3. Retourne { cabinet, error } — error non-null si échec d'INSERT
//
// Utilisé par /signup, /login et /me pour auto-réparer les comptes
// orphelins (user créé sans cabinet, ex. ancienne erreur RLS silencieuse).
// ──────────────────────────────────────────────────
async function ensureCabinet(supabaseAdmin, user) {
  if (!user || !user.email) return { cabinet: null, error: new Error('no user') };

  // 1. Lookup
  const { data: existing, error: lookupErr } = await supabaseAdmin
    .from('cabinets')
    .select('*')
    .eq('email', user.email)
    .maybeSingle();
  if (lookupErr) {
    logger.error(`ensureCabinet lookup error for ${user.email}: ${lookupErr.message}`);
    return { cabinet: null, error: lookupErr };
  }
  if (existing) return { cabinet: existing, error: null };

  // 2. Auto-create
  const meta = user.user_metadata || {};
  const { data: created, error: createErr } = await supabaseAdmin
    .from('cabinets')
    .insert([{
      email: user.email,
      nom: meta.nom || user.email,
      entreprise: meta.entreprise || null,
      secteur: meta.secteur || null,
      plan: 'pro',
      stripe_status: 'trial',
      actif: true,
    }])
    .select()
    .single();
  if (createErr) {
    logger.error(`ensureCabinet INSERT failed for ${user.email}: ${createErr.message} (code=${createErr.code || 'n/a'})`);
    return { cabinet: null, error: createErr };
  }
  logger.info(`ensureCabinet created cabinet ${created.id} for ${user.email}`);
  return { cabinet: created, error: null };
}

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
            Bienvenue ${nom ? nom : ''}
          </h1>
          <p style="color:#666;margin-bottom:2rem">Votre compte Losaro est actif. Voici comment démarrer.</p>

          <div style="background:#f8f7f4;border-radius:12px;padding:1.5rem;margin-bottom:1.5rem">
            <p style="font-weight:600;margin-bottom:1rem">3 choses à faire maintenant :</p>
            <ol style="padding-left:1.2rem;margin:0;line-height:1.7">
              <li><strong>Ajoutez votre premier client</strong><br>
                <span style="color:#666;font-size:0.85rem">Ses coordonnées et ses factures en attente.</span></li>
              <li style="margin-top:0.5rem"><strong>Activez vos relances automatiques</strong><br>
                <span style="color:#666;font-size:0.85rem">Losaro s'occupe de J+7, J+15, J+30, J+45 et J+60.</span></li>
              <li style="margin-top:0.5rem"><strong>Générez votre premier devis</strong><br>
                <span style="color:#666;font-size:0.85rem">Décrivez la prestation, Losaro génère et envoie le devis.</span></li>
            </ol>
          </div>

          <a href="https://losaro.fr" style="display:inline-block;background:#0f0f0d;color:white;text-decoration:none;padding:0.85rem 2rem;border-radius:8px;font-weight:600;font-size:0.9rem;margin-bottom:2rem">
            Accéder à mon tableau de bord →
          </a>

          <hr style="border:none;border-top:1px solid #e8e6dd;margin:1.5rem 0">

          <p style="font-size:0.8rem;color:#888">
            Une question ? Répondez directement à cet email ou écrivez à
            <a href="mailto:contact@losaro.fr" style="color:#1a56ff">contact@losaro.fr</a>
          </p>
          <p style="font-size:0.75rem;color:#aaa;margin-top:0.5rem">
            © 2026 Losaro · 55 rue Henri Barbusse, 77124 Crégy-lès-Meaux · SIRET 999 382 971 00011
          </p>
        </div>
      `,
    });
    logger.info(`Email de bienvenue envoyé → ${email}`);
  } catch (err) {
    logger.error(`Erreur email bienvenue: ${err.message}`);
  }
}

// POST /api/auth/signup
router.post('/signup', async (req, res) => {
  const { email, password, nom, secteur, entreprise } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email et password requis.' });
  if (!supabaseAdmin) return res.status(503).json({ error: 'Auth non disponible.' });

  try {
    // 1. Création du user Supabase Auth
    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { nom, secteur, entreprise },
    });
    if (error) return res.status(400).json({ error: error.message });

    // 2. Création du cabinet Losaro (idempotent)
    const { cabinet, error: cabinetErr } = await ensureCabinet(supabaseAdmin, data.user);
    if (cabinetErr) {
      // On laisse passer : le cabinet sera retenté au prochain /login ou /me.
      // Mais on log clairement pour Render.
      logger.warn(`Signup OK but cabinet not created for ${email}: ${cabinetErr.message}`);
    }

    // 3. Email de bienvenue (best-effort)
    sendWelcomeEmail(email, nom).catch(() => {});

    logger.info(`Signup: ${email} (cabinet=${cabinet ? cabinet.id : 'PENDING'})`);
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

    // Auto-répare les comptes orphelins (user sans cabinet)
    const { cabinet } = await ensureCabinet(supabaseAdmin, data.user);

    logger.info(`Login: ${email}`);
    res.json({ user: data.user, session: data.session, cabinet });
  } catch (err) {
    logger.error(`Login error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/logout (no-op côté serveur, le client doit jeter le token)
router.post('/logout', async (req, res) => {
  res.json({ success: true });
});

// GET /api/auth/me — récupère le user + cabinet courant
router.get('/me', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token || !supabaseAdmin) return res.status(401).json({ error: 'Non authentifié.' });
  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data?.user) return res.status(401).json({ error: 'Token invalide.' });

    // Auto-répare les comptes orphelins (user sans cabinet)
    const { cabinet } = await ensureCabinet(supabaseAdmin, data.user);

    res.json({ user: data.user, cabinet });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
