const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { rateLimit } = require('express-rate-limit');
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

// ──────────────────────────────────────────────────
// Mot de passe oublié
//   1. /forgot-password : génère un lien de récupération Supabase et l'envoie
//      par Resend (mail Losaro en français, pas le modèle anglais de Supabase)
//   2. /reset-password : vérifie le token du lien et enregistre le nouveau mot de passe
// ──────────────────────────────────────────────────
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://www.losaro.fr';

// Deux compteurs séparés : demander le lien et choisir le mot de passe ne
// doivent pas se partager le même quota
const forgotRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Trop de demandes. Réessayez dans 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});
const resetRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Trop de tentatives. Réessayez dans 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

async function sendResetEmail(email, link) {
  if (!resend) {
    logger.debug(`[EMAIL RESET SIMULÉ] → ${email} | ${link}`);
    return;
  }
  await resend.emails.send({
    from: 'Losaro <contact@losaro.fr>',
    to: email,
    subject: 'Réinitialisez votre mot de passe Losaro',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:2rem;color:#1a1a17">
        <div style="margin-bottom:2rem"><strong style="font-size:1.3rem;letter-spacing:-0.03em">Losaro</strong></div>
        <h1 style="font-size:1.3rem;font-weight:700;letter-spacing:-0.03em;margin-bottom:0.5rem">Réinitialiser votre mot de passe</h1>
        <p style="color:#555;line-height:1.6">Vous avez demandé à changer le mot de passe de votre compte Losaro. Cliquez sur le bouton ci-dessous pour en choisir un nouveau. Le lien est valable <strong>1 heure</strong>.</p>
        <a href="${link}" style="display:inline-block;background:#0f0f0d;color:white;text-decoration:none;padding:0.85rem 2rem;border-radius:8px;font-weight:600;font-size:0.9rem;margin:1.2rem 0 1.5rem">
          Choisir un nouveau mot de passe
        </a>
        <p style="color:#888;font-size:0.82rem;line-height:1.6">Si vous n'êtes pas à l'origine de cette demande, ignorez ce message : votre mot de passe actuel reste valable.</p>
        <hr style="border:none;border-top:1px solid #e8e6dd;margin:1.5rem 0">
        <p style="font-size:0.75rem;color:#aaa">© 2026 Losaro · 55 rue Henri Barbusse, 77124 Crégy-lès-Meaux · SIRET 999 382 971 00011</p>
      </div>
    `,
  });
}

// POST /api/auth/forgot-password — répond toujours pareil, pour ne pas révéler
// si un compte existe pour cet email
router.post('/forgot-password', forgotRateLimiter, async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'Email requis.' });
  if (!supabaseAdmin) return res.status(503).json({ error: 'Auth non disponible.' });

  try {
    const { data, error } = await supabaseAdmin.auth.admin.generateLink({ type: 'recovery', email });
    if (error || !data?.properties?.hashed_token) {
      // Compte inexistant le plus souvent : on ne le dit pas au visiteur
      logger.info(`Forgot password: pas de lien pour ${email} (${error?.message || 'no token'})`);
    } else {
      const link = `${FRONTEND_URL}/reset?token_hash=${encodeURIComponent(data.properties.hashed_token)}`;
      await sendResetEmail(email, link);
      logger.info(`Forgot password: lien envoyé → ${email}`);
    }
  } catch (err) {
    logger.error(`Forgot password error: ${err.message}`);
  }
  res.json({ success: true });
});

// POST /api/auth/reset-password { token_hash, password }
router.post('/reset-password', resetRateLimiter, async (req, res) => {
  const { token_hash, password } = req.body;
  if (!token_hash || !password) return res.status(400).json({ error: 'Lien ou mot de passe manquant.' });
  if (password.length < 8) return res.status(400).json({ error: 'Le mot de passe doit faire au moins 8 caractères.' });
  if (!supabaseAdmin) return res.status(503).json({ error: 'Auth non disponible.' });

  try {
    // Client jetable : verifyOtp ouvre une session, elle ne doit pas toucher le client admin partagé
    const verifier = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { data, error } = await verifier.auth.verifyOtp({ type: 'recovery', token_hash });
    if (error || !data?.user) {
      return res.status(400).json({ error: 'Ce lien a expiré ou a déjà servi. Demandez-en un nouveau.' });
    }

    const { error: updateErr } = await supabaseAdmin.auth.admin.updateUserById(data.user.id, { password });
    if (updateErr) return res.status(400).json({ error: updateErr.message });

    logger.info(`Reset password OK: ${data.user.email}`);
    res.json({ success: true, email: data.user.email });
  } catch (err) {
    logger.error(`Reset password error: ${err.message}`);
    res.status(500).json({ error: 'Erreur serveur, réessayez dans un instant.' });
  }
});

// POST /api/auth/refresh { refresh_token } — renouvelle la session avant que le
// jeton d'accès (1 h) expire, pour ne pas déconnecter l'utilisateur en plein travail
const refreshRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  message: { error: 'Trop de tentatives. Réessayez dans 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.post('/refresh', refreshRateLimiter, async (req, res) => {
  const { refresh_token } = req.body;
  if (!refresh_token) return res.status(400).json({ error: 'refresh_token requis.' });
  if (!supabaseAdmin) return res.status(503).json({ error: 'Auth non disponible.' });

  try {
    // Client jetable : refreshSession ouvre une session, elle ne doit pas toucher le client admin partagé
    const refresher = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { data, error } = await refresher.auth.refreshSession({ refresh_token });
    if (error || !data?.session) {
      return res.status(401).json({ error: 'Session expirée. Reconnectez-vous.' });
    }
    res.json({ user: data.user, session: data.session });
  } catch (err) {
    logger.error(`Refresh error: ${err.message}`);
    res.status(500).json({ error: 'Erreur serveur, réessayez dans un instant.' });
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
