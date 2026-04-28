const { createClient } = require('@supabase/supabase-js');
const logger = require('../services/logger');
const { rateLimit } = require('express-rate-limit');

// ── Supabase admin client (service role, bypass RLS) ──
const supabaseAdmin = process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY)
  : null;

// ──────────────────────────────────────────────────
// requireAuth — vérifie le Bearer token et injecte
//   req.user (Supabase auth user)
//   req.cabinet (cabinet lié à l'email)
//   req.supabase (client Supabase admin)
//
// Utilisation :
//   router.get('/factures', requireAuth, async (req, res) => { ... });
// ──────────────────────────────────────────────────
const requireAuth = async (req, res, next) => {
  if (!supabaseAdmin) return res.status(503).json({ error: 'Auth non disponible.' });

  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Token manquant.' });

  try {
    const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token);
    if (userError || !userData?.user) {
      logger.debug(`Auth fail: ${userError?.message || 'no user'}`);
      return res.status(401).json({ error: 'Token invalide.' });
    }

    const { data: cabinet, error: cabinetError } = await supabaseAdmin
      .from('cabinets')
      .select('*')
      .eq('email', userData.user.email)
      .single();

    if (cabinetError || !cabinet) {
      logger.warn(`Cabinet introuvable pour ${userData.user.email}`);
      return res.status(404).json({ error: 'Cabinet introuvable.' });
    }

    req.user = userData.user;
    req.cabinet = cabinet;
    req.supabase = supabaseAdmin;
    next();
  } catch (err) {
    logger.error(`requireAuth error: ${err.message}`);
    res.status(500).json({ error: 'Erreur d\'authentification.' });
  }
};

// ──────────────────────────────────────────────────
// Origin checking (legacy, conservé)
// ──────────────────────────────────────────────────
const authMiddleware = (req, res, next) => {
  if (process.env.NODE_ENV === 'development') return next();
  const origin = req.headers.origin;
  const allowedOrigins = [
    process.env.FRONTEND_URL,
    'https://losaro.fr',
    'https://www.losaro.fr',
    'https://losaro-frontend.vercel.app',
  ].filter(Boolean);
  if (origin && !allowedOrigins.includes(origin)) {
    logger.warn(`Requête bloquée: ${origin}`);
    return res.status(403).json({ error: 'Accès non autorisé' });
  }
  next();
};

// ──────────────────────────────────────────────────
// Rate limiters
// ──────────────────────────────────────────────────
const aiRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'Trop de requêtes. Attendez une minute.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const stripeRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Trop de tentatives. Attendez une minute.' },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = {
  requireAuth,
  authMiddleware,
  aiRateLimiter,
  stripeRateLimiter,
  supabaseAdmin,
};
